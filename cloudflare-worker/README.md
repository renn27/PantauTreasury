# 🚀 Panduan Setup Cloudflare Worker: Notifikasi PWA Promo 24 Jam Nonstop

Cloudflare Worker ini bekerja sebagai **Server Push PWA mandiri** yang mengawasi status promo Treasury setiap 1 menit (24/7) secara **100% gratis**. Ketika promo berubah status menjadi **ON**, Worker akan seketika menembakkan notifikasi push langsung ke HP/PC Anda melalui aplikasi PWA PantauTreasury (tanpa perlu aplikasi pihak ketiga seperti Telegram).

---

## 🌟 Keunggulan Notifikasi PWA Murni:
1. **Notifikasi Aplikasi Asli**: Notifikasi muncul di bar notifikasi dan lockscreen HP persis seperti aplikasi native (Android / iOS).
2. **Berjalan 24 Jam Saat Web Tertutup**: Notifikasi tetap masuk meski browser ditutup atau layar HP mati.
3. **100% Gratis Selamanya**: Cloudflare Worker memberikan 100.000 eksekusi per hari (Cron per menit hanya memakai 1.440 eksekusi/hari).
4. **Vercel Tetap Aman**: Backend scraping USD/IDR Anda di Vercel tidak dibebani sama sekali.

---

## 🛠️ Langkah Demi Langkah Setup di Dashboard Cloudflare (Lewat Browser)

### Langkah 1: Buat Worker Baru di Cloudflare
1. Buka [dash.cloudflare.com](https://dash.cloudflare.com/) dan login ke akun Cloudflare Anda.
2. Di menu samping kiri, klik **Workers & Pages**.
3. Klik tombol biru **Create application** -> pilih tab **Workers** -> klik **Create Worker**.
4. Beri nama worker Anda, misalnya: `pantau-treasury-promo`.
5. Klik **Deploy**.

---

### Langkah 2: Masukkan Kode Script Worker
1. Setelah ter-deploy, klik tombol **Edit code** (di kanan atas).
2. Di editor sebelah kiri, hapus semua kode contoh bawaan.
3. Buka file [`cloudflare-worker/promo-monitor.js`](file:///d:/A%20DEV/Treasury/cloudflare-worker/promo-monitor.js), **salin seluruh isinya**, lalu **paste** ke editor Cloudflare.
4. Klik tombol **Deploy** di pojok kanan atas.
5. Catat URL Worker Anda yang ada di bagian atas (contoh: `https://pantau-treasury-promo.<subdomain-anda>.workers.dev`).

---

### Langkah 3: Buat KV Storage (Penyimpan Perangkat HP Anda)
*KV Storage digunakan Worker untuk menyimpan daftar HP / browser yang berlangganan notifikasi serta mengingat status promo terakhir.*

1. Kembali ke menu utama Cloudflare Dashboard -> klik **Workers & Pages** -> pilih sub-menu **KV**.
2. Klik tombol **Create namespace**.
3. Beri nama: `PROMO_KV` -> klik **Add**.
4. Sekarang tautkan KV tersebut ke Worker Anda:
   - Klik menu **Workers & Pages** -> pilih Worker Anda (`pantau-treasury-promo`).
   - Masuk ke tab **Settings** -> pilih sub-menu **Variables and Secrets** (atau **Bindings**).
   - Di bagian **KV Namespace Bindings**, klik **Add binding**:
     - **Variable name**: `PROMO_KV` *(wajib huruf kapital persis seperti ini)*
     - **KV namespace**: pilih `PROMO_KV` yang baru saja Anda buat
   - Klik **Deploy** / **Save**.

---

### Langkah 4: Atur Jadwal Cron Trigger (Per 1 Menit Nonstop)
1. Di halaman Worker Anda, klik tab **Settings** -> pilih sub-menu **Triggers**.
2. Scroll ke bawah ke bagian **Cron Triggers**, lalu klik **Add Cron Trigger**.
3. Pada input Cron Expression, masukkan:
   ```text
   * * * * *
   ```
   *(Artinya: dijalankan otomatis setiap 1 menit, 24 jam sehari, 7 hari seminggu)*.
4. Klik **Add Trigger**.

---

### Langkah 5: Aktifkan Notifikasi di PWA PantauTreasury (HP / Laptop Anda)
1. Buka web **PantauTreasury** di HP atau browser Anda.
2. Klik card **Status Promo** untuk membuka dropdown riwayat promo.
3. Di bagian atas dropdown, Anda akan melihat bar:
   `[ ⚪ Notif PWA: Mati ]  [ Aktifkan ]`
4. Klik tombol **Aktifkan**:
   - Browser akan memunculkan pop-up izin: klik **Izinkan (Allow)**.
   - Aplikasi akan meminta Anda memasukkan URL Worker: masukkan URL Cloudflare Worker Anda dari Langkah 2 (contoh: `https://pantau-treasury-promo.<subdomain-anda>.workers.dev`).
5. Status akan berubah menjadi:
   `[ 🟢 Notif PWA: Aktif (24 Jam) ]  [ Tes ]  [ Matikan ]`
6. Klik tombol **Tes**:
   - Notifikasi tes akan langsung berbunyi dan muncul di layar HP Anda!

---

Selesai! Mulai sekarang, Cloudflare Worker Anda akan terus mengawasi status promo Treasury selama 24 jam nonstop, dan ketika promo berubah menjadi ON, HP Anda akan langsung berdering menerima notifikasi dari aplikasi PWA PantauTreasury.
