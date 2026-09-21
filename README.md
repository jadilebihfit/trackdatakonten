# 🚀 Asistent Creator - AI Social Media Analytics & Content Auditor

Aplikasi multi-user untuk menghubungkan akun media sosial (**YouTube, Instagram, TikTok, dan Threads**) secara resmi melalui protokol **OAuth 2.0 (Login with Platform)**, menarik metrik insight real-time (views, likes, comments, **saves / bookmarks**, shares, dan followers), serta melakukan evaluasi dan perencanaan konten otomatis berbasis **Google Gemini 2.0 Flash AI**.

---

## 🌟 Fitur Utama

1. **Multi-Platform OAuth Connect (Tanpa Password)**
   * **YouTube Data API v3 & Analytics API**: Menarik subscriber, views, likes, comments, jam tayang, dan detail video/Shorts.
   * **Instagram Graph API & Threads API**: Menarik Reach, Impressions, **Saves (Bookmarks)**, Shares, Reels views, dan Follower growth.
   * **TikTok Creator/Display API**: Menarik views, likes, comments, shares, dan **collect count (saves)**.
2. **Dashboard Real-Time & Visualisasi Interaktif**
   * Metrik KPI Utama: Total Views, Total Saves (Faktor utama algoritma), Total Shares, Engagement Rate gabungan.
   * Grafik tren 14 hari (Views, Likes, Saves).
   * Grafik komposisi interaksi audiens (Doughnut Chart).
   * Tabel performa video per platform yang bisa diurutkan berdasarkan *Views*, *Saves*, *Shares*, atau *Engagement Rate*.
3. **AI Content Auditor & Co-Pilot (Gemini 2.0 Flash)**
   * **Full Account Audit**: Menganalisis pola konten pemenang (*winning pattern*), kelemahan konten underperform, dan skor kesehatan akun.
   * **AI Single Video Diagnosis**: Mendiagnosis efektivitas hook 3 detik pertama dan rasio simpan/bagikan per video.
   * **AI 7-Day Strategy Generator**: Merancang jadwal dan ide konten 7 hari kedepan lengkap dengan hook, angle, dan CTA.
4. **Sandbox & Demo Mode**
   * Dilengkapi data simulasi realistis (YouTube, IG, TikTok, Threads) sehingga dashboard langsung bisa dicoba sebelum mendaftarkan seluruh API keys.

---

## 📁 Struktur Folder Project

```
E:\AI Joko\Asistent Creator\
├── data\
│   └── asistent_creator.sqlite       # Database SQLite lokal
├── public\
│   ├── index.html                    # Dashboard UI (TailwindCSS + Chart.js)
│   ├── style.css                     # Custom styling & scrollbars
│   └── app.js                        # Client-side interactivity & AI calls
├── src\
│   ├── db\
│   │   └── database.js               # Schema & Query Helpers
│   ├── services\
│   │   ├── aiAuditorService.js       # Gemini 2.0 Flash Auditor Engine
│   │   ├── mockDataService.js        # Realistic Sandbox Data Generator
│   │   ├── youtubeService.js         # Google OAuth & YouTube Ingestion
│   │   ├── metaService.js            # Instagram & Threads Graph API
│   │   └── tiktokService.js          # TikTok OAuth & Creator Ingestion
│   └── server.js                     # Express REST API Server
├── .env                              # File konfigurasi API Key lokal
├── .env.example                      # Template variabel lingkungan
└── package.json
```

---

## 🚀 Cara Menjalankan Aplikasi

1. Buka terminal di folder project:
   ```bash
   cd "E:\AI Joko\Asistent Creator"
   ```
2. Jalankan server:
   ```bash
   npm start
   # atau untuk mode auto-reload development:
   npm run dev
   ```
3. Buka browser dan akses:
   👉 **`http://localhost:3000`**

---

## 🔑 Panduan Pendaftaran Kunci API & OAuth

Buka file `.env` di text editor, lalu lengkapi variabel berikut:

### 1. Google Gemini AI Key (Otak AI - 100% Gratis)
1. Buka [Google AI Studio](https://aistudio.google.com/).
2. Klik **"Get API key"** -> **"Create API key"**.
3. Salin kuncinya dan masukkan ke `.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...
   ```

### 2. YouTube OAuth (Google Cloud Console)
1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Buat Project baru (misal: *Asistent Creator*).
3. Buka menu **APIs & Services** > **Library**, aktifkan:
   * **YouTube Data API v3**
   * **YouTube Analytics API**
4. Buka menu **OAuth consent screen** > Pilih **External** > Tambahkan email kamu sebagai Test User.
5. Buka menu **Credentials** > **Create Credentials** > **OAuth client ID**:
   * Application type: **Web application**
   * Authorized redirect URIs: `http://localhost:3000/auth/youtube/callback`
6. Masukkan hasilnya ke `.env`:
   ```env
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
   ```

### 3. Meta for Developers (Instagram & Threads)
1. Buka [Meta for Developers](https://developers.facebook.com/).
2. Buat App baru dengan tipe **Business** atau **Consumer**.
3. Tambahkan produk **Instagram Graph API** dan **Threads API**.
4. Set Valid OAuth Redirect URIs:
   `http://localhost:3000/auth/meta/callback`
5. Masukkan App ID & App Secret ke `.env`:
   ```env
   META_APP_ID=xxxx
   META_APP_SECRET=xxxx
   ```

### 4. TikTok for Developers
1. Buka [TikTok for Developers](https://developers.tiktok.com/).
2. Buat App dan aktifkan produk **Login Kit** & **Display API / Video List**.
3. Set Redirect URI: `http://localhost:3000/auth/tiktok/callback`
4. Masukkan ke `.env`:
   ```env
   TIKTOK_CLIENT_KEY=xxxx
   TIKTOK_CLIENT_SECRET=xxxx
   ```

---

## 🔒 Privasi & Keamanan
* Aplikasi ini tidak pernah meminta atau menyimpan kata sandi user.
* Semua otentikasi menggunakan token OAuth 2.0 yang hanya memiliki izin baca (*read-only insights*).
* Database disimpan secara lokal pada komputer kamu (`data/asistent_creator.sqlite`).
