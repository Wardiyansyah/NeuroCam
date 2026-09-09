# SIPIJAR — Skrining Dini Potensi Stroke Berbasis Citra Wajah

Implementasi draft "Pendeteksi dini potensi stroke berdasarkan citra wajah berbasis AI"
di atas Next.js 16 (App Router, Turbopack, React 19).

> [!WARNING]
> **Bukan alat diagnosis dan belum divalidasi secara klinis.**
> Tidak ada bukti yang menetapkan bahwa kombinasi rPPG dan asimetri fotometrik
> dapat mendeteksi stroke secara andal. Status `Normal` **tidak** menyingkirkan
> kemungkinan stroke. Gunakan sebagai prototipe rekayasa, bukan sebagai dasar
> keputusan medis. Bila ada gejala, hubungi **119** atau **112**.

---

## Menjalankan

```bash
npm install
npm run dev          # http://localhost:3000
npm run verify       # verifikasi pipeline sinyal terhadap data sintetis
```

Kamera memerlukan origin aman: `localhost` sudah aman, host lain butuh HTTPS.

Salin `.env.example` ke `.env.local` bila ingin mengaktifkan asisten triase atau
inference server. **Aplikasi berjalan penuh tanpa satu pun variabel diisi.**

---

## Halaman

| Rute         | Isi                                                                      |
| ------------ | ------------------------------------------------------------------------ |
| `/`          | Ringkasan sistem, alur kerja, batasan, dan ambang batas yang sedang aktif |
| `/monitor`   | Sesi pemantauan langsung + panduan FAST                                   |
| `/dashboard` | Riwayat insiden teranonimisasi                                            |

## API

| Endpoint         | Metode   | Fungsi                                                    |
| ---------------- | -------- | --------------------------------------------------------- |
| `/api/session`   | `POST`   | Membuka sesi, mengembalikan `sessionId`                    |
| `/api/session`   | `DELETE` | Menutup sesi (`?id=`)                                      |
| `/api/analyze`   | `POST`   | Menerima batch bingkai tereduksi, mengembalikan status     |
| `/api/triage`    | `POST`   | Streaming panduan triase (`text/plain`)                    |
| `/api/incidents` | `GET`    | Daftar insiden teranonimisasi                              |

---

## Tiga penyimpangan dari draft — dan alasannya

Sisanya mengikuti draft. Tiga hal ini sengaja berbeda:

### 1. Video tidak dikirim ke peladen sama sekali

Draft merancang WebRTC → peladen GPU, lalu menghapus video dari RAM dalam
hitungan milidetik. Implementasi ini **mereduksi bingkai di dalam peramban**:
tiap frame dipetakan ke sembilan region wajah, direduksi menjadi rata-rata warna
RGB, lalu pikselnya dibuang. Yang menyeberang jaringan hanya ~27 angka per
bingkai (±5 KB/detik) — bukan video.

Ini **lebih kuat** daripada tujuan privasi draft, bukan lebih lemah: tidak ada
video mentah yang bisa bocor, ter-buffer di proxy, atau lupa dihapus, karena
tidak pernah ada video yang dikirim. Konsekuensinya, model AU penuh berbasis
landmark tidak bisa dijalankan dari data ini — lihat penyimpangan 3.

Jalur WebRTC → GPU tetap tersedia: isi `INFERENCE_SERVER_URL` dan ekstraksi
metrik didelegasikan ke layanan eksternal (kontrak di `lib/inference.ts`).

### 2. Nama model diperbarui

Draft menyebut "Claude 4.5 Sonnet" lewat OpenRouter. Penyedianya tetap
**OpenRouter** sesuai draft; hanya nama modelnya yang dibakukan ke slug yang
benar-benar ada di katalog OpenRouter:

```
anthropic/claude-sonnet-4.5
```

Awalan `anthropic/` adalah cara OpenRouter memberi *namespace* vendor pada nama
model — setiap model di sana ditulis `vendor/model`. Itu **bukan** berarti API
Anthropic yang dipanggil. Satu-satunya endpoint yang dihubungi aplikasi ini
adalah `https://openrouter.ai/api/v1/chat/completions`, dan satu-satunya
kredensial yang dibaca adalah `OPENROUTER_API_KEY`.

Ganti model lewat `TRIAGE_MODEL` bila perlu.

Transportnya HTTPS + SSE langsung, tanpa shim OpenAI SDK — format kabelnya cukup
sederhana sehingga menambah dependensi hanya memperluas permukaan yang harus
diaudit.

### 3. Skor asimetri adalah proksi fotometrik, bukan Action Unit sungguhan

Draft menyebut "analisis Action Units". AU sungguhan memerlukan landmark wajah
atau model AU terlatih. Yang berjalan lokal di sini membandingkan **dinamika
luminansi sisi kiri dan kanan** untuk tiap pasang region — seberapa banyak tiap
sisi *bergerak*, dan bagaimana tiap sisi *terbayang* relatif terhadap pipi di
sisi yang sama.

Nama `AU12`/`AU6`/`AU4` dipakai untuk menyebut AU yang **diwakili**, bukan yang
**diukur**. Model AU penuh adalah tugas inference server pada penyimpangan 1.

Dua perancu ditangani eksplisit:

- **Pencahayaan samping** — tiap fitur dinormalisasi terhadap pipi di sisinya
  sendiri, sehingga gradien cahaya kiri-kanan saling meniadakan.
- **Asimetri bawaan** — tidak ada wajah yang simetris. Skor hanya bermakna
  sebagai **kelebihan di atas baseline pribadi** yang direkam saat kalibrasi.

### 4. Polling, bukan WebSocket

Dasbor melakukan polling `/api/incidents` tiap 5 detik alih-alih berlangganan
WSS. Data identik, tanpa perlu mengoperasikan socket server. Titik penggantinya
ada di `components/incident-table.tsx`.

---

## Cara kerja pipeline

### rPPG — metode CHROM

`lib/signal/rppg.ts` memulihkan sinyal pulsa memakai CHROM (de Haan & Jeanne,
2013), bukan kanal hijau mentah: pulsa hidup di subruang krominansi tempat
pantulan spekular sebagian besar saling meniadakan, sehingga jauh lebih tahan
terhadap gerakan dan variasi warna kulit.

```
resample seragam → normalisasi per kanal → proyeksi krominansi
  → detrend → jendela Hann → FFT → puncak dalam 0,7–4,0 Hz
```

Resampling penting: pengiriman bingkai peramban ber-jitter, dan FFT yang
mengasumsikan jarak seragam pada input ber-jitter akan mengaburkan puncak pulsa.
SNR memakai definisi de Haan — energi di frekuensi pulsa dan harmonik keduanya,
dibandingkan sisa pita.

### Dua jendela waktu

Draft menyebut agregasi 5 detik. Implementasi memakai dua jendela karena
resolusi frekuensi berbanding lurus dengan panjang jendela — 5 detik tidak dapat
memisahkan 70 dari 76 bpm:

| Jendela      | Durasi | Dipakai untuk                         |
| ------------ | ------ | ------------------------------------- |
| Pulsa        | 10 s   | Estimasi detak jantung                |
| Krisis       | 5 s    | Asimetri + keputusan status (sesuai draft) |
| Retensi      | 12 s   | Buffer sesi                           |
| Kalibrasi    | 20 s   | Baseline HR dan asimetri pribadi      |

### Jalur RunPod (opsional)

Ekstraksi metrik dapat didelegasikan ke peladen GPU sesuai draft. Isi
`INFERENCE_SERVER_URL`, dan `lib/inference.ts` akan memanggil:

```
POST {INFERENCE_SERVER_URL}/extract
Authorization: Bearer {INFERENCE_SERVER_TOKEN}

  → { "fps": 30, "samples": [ { "t": 0, "faceFound": true,
                                "roi": { "forehead": [r,g,b], ... } }, ... ] }

  ← { "bpm": 72 | null,
      "snrDb": 11.6,
      "quality": "good" | "fair" | "poor",
      "asymmetry": { "mouth": 0, "eye": 0, "brow": 0, "overall": 0 } }
```

Peladen Python-nya **belum disertakan** di repositori ini — yang ada adalah sisi
kliennya: kontrak, autentikasi bearer, timeout 2 detik, dan *fallback* otomatis
ke ekstraksi CHROM lokal bila peladen lambat, gagal, atau sedang *cold start*.
Sesi pemantauan tidak boleh buta hanya karena worker GPU baru bangun.

Perhatikan bahwa yang dikirim ke peladen tetap sampel ROI tereduksi, bukan
video. Untuk menjalankan model AU berbasis landmark seperti pada draft, jalur
transport perlu diubah agar mengirim bingkai — dan itu mengembalikan
kompromi privasi yang dijelaskan pada penyimpangan 1.

### Gerbang sinyal mendahului semua aturan

Kualitas sinyal buruk menghasilkan `signal_lost`, **bukan** `normal`. Membaca
"tidak ada anomali" dari pelacakan wajah yang hilang adalah mode kegagalan yang
benar-benar membahayakan, jadi ketidaktahuan tidak pernah disamarkan sebagai
kabar baik. Lihat `lib/thresholds.ts`.

### Panduan darurat tidak pernah bergantung pada jaringan

`lib/fast-protocol.ts` bersifat statis dan dirender di server, sudah ada di
markup sebelum JavaScript berjalan. Bila API triase lambat, kena rate limit,
atau tidak terjangkau, protokol FAST dan langkah pertama tetap tampil. LLM hanya
memperkaya, tidak pernah menjadi prasyarat.

---

## Struktur

```
app/
  page.tsx                    Beranda
  monitor/page.tsx            Sesi pemantauan
  dashboard/page.tsx          Dasbor insiden
  api/session/route.ts        Siklus hidup sesi          (langkah 1)
  api/analyze/route.ts        Ekstraksi + evaluasi       (langkah 3-4)
  api/triage/route.ts         Asisten triase streaming   (langkah 5)
  api/incidents/route.ts      Riwayat teranonimisasi

lib/
  capture.ts                  Reduksi bingkai di peramban (langkah 2)
  signal/rppg.ts              CHROM + FFT → detak jantung
  signal/asymmetry.ts         Proksi asimetri kiri-kanan
  signal/fft.ts               FFT radix-2
  signal/stats.ts             Detrend, Hann, luminansi
  thresholds.ts               Aturan krisis (langkah 4)
  inference.ts                Orkestrasi + jalur GPU RunPod opsional
  triage.ts                   Panggilan OpenRouter, streaming SSE
  fast-protocol.ts            Panduan FAST deterministik
  store.ts                    Sesi + insiden (antarmuka Redis/Supabase)

components/
  monitor-client.tsx          Kamera, loop tangkap, tampilan metrik
  incident-table.tsx          Umpan insiden langsung
  fast-panel.tsx              Panduan darurat statis
  metric-card.tsx             Kartu metrik dan bilah indeks

scripts/
  verify-signals.ts           Verifikasi pipeline sinyal
  verify-triage.mts           Verifikasi lapisan triase (npm run verify)
```

---

## Verifikasi

`npm run verify` menjalankan dua rangkaian:

- **`scripts/verify-signals.ts`** — 21 pemeriksaan pipeline terhadap sinyal
  sintetis ber-*ground truth*: pemulihan detak jantung 55–124 bpm, gerbang
  derau, gerbang wajah hilang, diskriminasi asimetri, pembatalan baseline, dan
  seluruh transisi status ambang batas.
- **`scripts/verify-triage.mts`** — pemeriksaan lapisan triase: perakitan ulang
  SSE OpenRouter melintasi batas chunk (diuji dengan potongan 7 byte), dan
  fallback ke protokol FAST pada HTTP 429/500, galat jaringan, aliran kosong,
  serta kunci yang belum diatur.

Perlu diingat data sintetis bersifat ideal — tanpa artefak gerakan, tanpa
perubahan pencahayaan, tanpa variasi warna kulit. Lulus di sini berarti
matematikanya benar, **bukan** bahwa sistem akurat pada pasien sungguhan.

---

## Sebelum menyentuh produksi

- **`lib/store.ts` menyimpan di memori proses.** Pada deployment serverless atau
  multi-instance, sesi akan tersebar dan jendela bergulir rusak. Ganti dengan
  Redis dan Supabase — antarmukanya sudah didefinisikan.
- **Tidak ada autentikasi.** Dasbor insiden terbuka bagi siapa pun yang tahu
  URL-nya. Data memang teranonimisasi, tetapi tetap perlu dibatasi.
- **Tidak ada rate limiting** pada `/api/analyze` maupun `/api/triage`.
- **Ambang batas belum divalidasi.** Seluruh angka di `lib/thresholds.ts` adalah
  heuristik yang dipilih agar mudah dibaca. Sensitivitas dan spesifisitas
  sesungguhnya tidak diketahui dan hanya dapat ditetapkan lewat studi klinis.
- **Gerbang deteksi kulit** memakai ambang tetap di ruang YCbCr. Ini lebih tahan
  variasi warna kulit dibanding aturan RGB klasik, tetapi tidak ada ambang tetap
  yang benar-benar netral untuk semua warna kulit.

## Mendemonstrasikan jalur peringatan

Turunkan ambang batas lewat variabel lingkungan agar status kritis mudah dipicu
tanpa menunggu kejadian sungguhan:

```bash
STROKE_ASYMMETRY_WARN=2 STROKE_ASYMMETRY_CRITICAL=4 STROKE_HR_SPIKE_PCT=3 npm run dev
```
