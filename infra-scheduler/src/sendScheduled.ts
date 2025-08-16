/*
  - Membaca Firestore collection `scheduled_notifications` yang due.
  - Mengirim FCM HTTP v1 via firebase-admin (service account).
  - Mencatat hasil ke koleksi `notifications` dan update status agar idempoten.
*/

import { initializeApp, applicationDefault, cert, AppOptions } from 'firebase-admin/app';
import { getFirestore, Timestamp, Firestore, Transaction, DocumentData } from 'firebase-admin/firestore';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

function initFirebase(): void {
  const json = process.env.GCP_SA_JSON;
  let options: AppOptions | undefined;
  if (json) {
    try {
      const creds = JSON.parse(json);
      options = { credential: cert(creds), projectId: process.env.FIREBASE_PROJECT_ID };
    } catch (e) {
      throw new Error('GCP_SA_JSON tidak valid: ' + (e as Error).message);
    }
  } else {
    options = { credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID };
  }
  initializeApp(options);
}

function nowTs(): Timestamp {
  return Timestamp.now();
}

function toSafeString(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s.length ? s : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(e: unknown): boolean {
  const code = (e as any)?.code || (e as any)?.errorInfo?.code;
  const msg = String((e as any)?.message || e || '');
  // Quota/429/resource exhausted/transient network
  return (
    code === 'resource-exhausted' ||
    code === 'quota-exceeded' ||
    code === 'aborted' ||
    code === 'unavailable' ||
    /429|quota|exhausted|unavailable|deadline/i.test(msg)
  );
}

async function main(): Promise<void> {
  if (!process.env.FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_PROJECT_ID wajib di-set');
  }
  initFirebase();
  const db: Firestore = getFirestore();
  const messaging: Messaging = getMessaging();

  const DRY_RUN = /^1|true$/i.test(String(process.env.DRY_RUN || ''));
  const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT ?? '50', 10);
  const MAX_BATCHES = parseInt(process.env.MAX_BATCHES ?? '10', 10);

  let processed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    // Ambil dokumen yang due (status==queued && scheduleTime <= now)
    const dueSnap = await db
      .collection('scheduled_notifications')
      .where('status', '==', 'queued')
      .where('scheduleTime', '<=', nowTs())
      .orderBy('scheduleTime', 'asc')
      .limit(BATCH_LIMIT)
      .get();

    if (dueSnap.empty) {
      if (batch === 0) console.log('Tidak ada notifikasi due.');
      break;
    }

    for (const doc of dueSnap.docs) {
    const data = doc.data() as any;

    // Idempoten: gunakan transaksi untuk lock singkat
    await db.runTransaction(async (tx: Transaction) => {
      const ref = doc.ref;
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const cur = snap.data() as DocumentData;
      if (cur.status !== 'queued') return; // sudah diproses oleh worker lain

      tx.update(ref, { status: 'processing', processingAt: nowTs() });
    });

    const title = toSafeString(data.title) ?? 'Pemberitahuan';
    const body = toSafeString(data.body) ?? '';
    const topic = toSafeString(data.topic);
    const token = toSafeString(data.token);
    const imageUrl = toSafeString(data.imageUrl);
    const action = toSafeString(data.action);
    const additionalData = (data.additionalData && typeof data.additionalData === 'object') ? data.additionalData : undefined;
    const debug = Boolean(data.debug);
    const expiry = data.expiry ? Timestamp.fromDate(new Date(data.expiry)) : undefined;

      if (!topic && !token) {
        console.warn(`Lewati ${doc.id}: tidak ada target (topic/token).`);
        await doc.ref.update({ status: 'error', errorAt: nowTs(), lastResult: 'missing-target' });
        continue;
      }

    const message = {
      topic: topic,
      token: token,
      notification: {
        title,
        body,
        imageUrl: imageUrl,
      },
      data: {
        title,
        body,
        imageUrl: imageUrl ?? '',
        action: action ?? '',
        debug: debug ? 'true' : 'false',
        screen: '/notifications_screen',
        ...(additionalData ?? {}),
      },
      android: {
        notification: {
          channelId: 'high_importance_channel',
          imageUrl: imageUrl,
          priority: 'HIGH',
        },
      },
      apns: {
        payload: {
          aps: {
            'mutable-content': 1,
            'content-available': 1,
          },
        },
        fcmOptions: imageUrl ? { imageUrl } : undefined,
      },
    } as any;

    try {
        if (DRY_RUN) {
          console.log(`[DRY_RUN] Would send ${doc.id} to ${token ? 'token' : 'topic'}: ${token ?? topic}`);
          await doc.ref.update({ status: 'sent', sentAt: nowTs(), lastResult: 'dry-run' });
        } else {
          const res = await messaging.send(message as any, false);
          console.log(`Sent ${doc.id}: ${res}`);
          await doc.ref.update({ status: 'sent', sentAt: nowTs(), lastResult: 'ok' });
        }

        // Catat ke koleksi notifications sesuai pola app
        const logDoc = {
          title,
          body,
          imageUrl: imageUrl ?? null,
          action: action ?? null,
          debug,
          timestamp: nowTs(),
          expiry: expiry ?? null,
          from: 'github-actions',
        };
        await db.collection('notifications').add(logDoc);
    } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`Gagal kirim ${doc.id}:`, msg);
        if (isRetryableError(err)) {
          // Naikkan attemptCount dan kembalikan ke queued untuk dicoba lagi pada run berikutnya
          await doc.ref.update({ status: 'queued', lastResult: msg, attemptCount: (data.attemptCount || 0) + 1, errorAt: nowTs() });
          // Hindari spin cepat
          await sleep(200);
        } else {
          await doc.ref.update({ status: 'error', errorAt: nowTs(), lastResult: msg });
        }
    }
      processed++;
    }

    if (dueSnap.size < BATCH_LIMIT) break; // habis dalam batch ini
  }
  console.log(`Selesai. Diproses: ${processed} dokumen.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
