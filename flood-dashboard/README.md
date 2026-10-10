# Water Level Monitoring

Dashboard React/Vite untuk memantau tinggi air dari pembacaan sensor ESP32 di Supabase.

## Menjalankan aplikasi

1. Salin `.env.example` menjadi `.env`.
2. Isi `VITE_SUPABASE_URL` dan `VITE_SUPABASE_KEY` dengan URL project dan publishable/anon key Supabase. Jangan gunakan service-role key di frontend.
3. Pastikan `public.device_settings` memiliki satu baris dengan `id = 1` dan kolom `is_configured`, `sensor_to_bottom_cm`, `warning_level_cm`, `flood_level_cm`, serta `updated_at`.
4. Jalankan `npm install`, `npm run dev`, dan `npm test`.

Saat `is_configured` bernilai `false`, aplikasi menampilkan pengaturan awal. Pengaturan yang disimpan diperbarui pada baris `id = 1`; aplikasi tidak membuat baris dan tidak menulis ke `water_readings`.

Tinggi air dihitung dari jarak sensor yang valid: `max(0, sensor_to_bottom_cm - distance_cm)`. Status mengikuti ambang tinggi air secara langsung. Data sensor gagal ditampilkan sebagai celah grafik; saat kegagalan berlanjut lebih dari 30 detik, label sensor bermasalah ditampilkan dan status valid terakhir dipertahankan.

Kartu **Prediksi** saat ini menampilkan “Prediksi belum aktif”. Komponen menerima prop `prediction` agar sumber prediksi dapat ditambahkan kemudian; aplikasi tidak membuat atau membaca tabel prediksi.
