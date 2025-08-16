# infra-scheduler (Spark-friendly)

Scheduler mandiri untuk memproses `scheduled_notifications` dan mengirim FCM HTTP v1 tanpa Cloud Functions/Cloud Scheduler (cocok untuk Spark Plan).

## Cara kerja
- GitHub Actions menjalankan workflow terjadwal (cron).
- Skrip TypeScript membaca dokumen due dari `scheduled_notifications` (status==queued, scheduleTime<=now), lalu mengirim FCM (topic/device) dan menulis log ke `notifications`.
- Idempoten via status update (queued → processing → sent/error).

## Setup Secrets (di repo organisasi)
- `GCP_SA_JSON`: isi file JSON Service Account dengan peran minimal (Firestore + FCM Send).
- `FIREBASE_PROJECT_ID`: ID proyek Firebase (mis. `hkbp-perawang-app`).

## Deploy
1. Commit folder `infra-scheduler` dan workflow `.github/workflows/notify-cron.yml` ke repo organisasi (direkomendasikan repo terpisah `infra-scheduler`).
2. Tambahkan Secrets di Settings → Secrets and variables → Actions.
3. Workflow jalan tiap 15 menit (UTC). Bisa manual via Run workflow.

## Skema data di Firestore (diselaraskan dengan aplikasi)
- Koleksi: `scheduled_notifications`
  - Contoh field: { title, body, topic|token, imageUrl?, action?, additionalData?, debug?, scheduleTime (Timestamp), expiry? (ISO/ts), status: 'queued'|'processing'|'sent'|'error' }
- Koleksi: `notifications` untuk riwayat yang ditampilkan di aplikasi.

## Uji lokal (opsional)
- Set env var `GCP_SA_JSON` dan `FIREBASE_PROJECT_ID`, lalu jalankan:
  - `npm i`
  - `npm run build && node dist/sendScheduled.js`

## Catatan
- Cron GitHub Actions memakai UTC; sesuaikan penjadwalan.
- Pastikan tidak menggunakan legacy FCM (gunakan HTTP v1 melalui firebase-admin).
