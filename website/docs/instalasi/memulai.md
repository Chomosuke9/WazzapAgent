---
sidebar_position: 2
---

# Cara Memulai

## Menambahkan Bot ke Grup

1. **Tambahkan nomor bot** ke grup WhatsApp-mu seperti menambahkan anggota biasa.
2. Bot akan otomatis aktif dan siap digunakan.
3. **Opsional tapi penting untuk moderasi:** Jadikan bot sebagai **admin grup** jika ingin bot bisa menghapus pesan atau mengeluarkan anggota.

:::note
Tanpa status admin, bot tetap bisa mengobrol dan menjawab pesan, tapi tidak bisa melakukan tindakan moderasi (hapus/kick).
:::

## Cara Menjadikan Bot Admin

1. Buka **Info Grup** di WhatsApp
2. Ketuk nama bot dalam daftar anggota
3. Pilih **"Jadikan Admin"**

## Langkah Pertama yang Disarankan

Setelah bot masuk grup, lakukan ini secara berurutan:

1. **Cek info bot** dengan mengetik `/info` di chat — pastikan bot terdeteksi sebagai admin jika sudah dijadikan admin.
2. **Atur kepribadian bot** dengan `/prompt <instruksimu>` — ini menentukan bagaimana bot berperilaku di grup ini.
3. **Uji coba** dengan menyapa bot: `@Vivy halo!`
4. Jika ingin moderasi, baca dulu bagian [Sistem Permission](/penggunaan/permission) sebelum mengaktifkannya.

## Cara Bot Merespons di Grup

Bot memiliki dua **mode respons** yang diatur lewat menu interaktif `/setting`:

### Mode `auto`
- Bot **menganalisis konteks** setiap pesan dengan AI
- Merespons secara otomatis jika ada topik penting
- Cocok untuk grup yang memang butuh bot aktif
- **Menggunakan lebih banyak token API**

### Mode `prefix` (default, optimal untuk grup ramai)
- Bot **hanya merespons saat dipanggil eksplisit:**
  - `@mention` bot (contoh: `@Vivy halo`)
  - Reply ke pesan bot sebelumnya
  - Sebut nama bot dalam teks (contoh: "Vivy, bantu aku")
  - Anggota baru bergabung (bisa diatur)
- **Lebih hemat token**, respons lebih cepat
- Konfigurasi trigger dengan `/trigger`

Di **chat pribadi**, bot selalu merespons setiap pesan **tanpa memandang mode**.

:::tip
Untuk grup ramai, gunakan **mode prefix** agar bot tidak terlalu berisik dan token lebih hemat. Buka `/setting` untuk memilih mode, lalu atur pemicunya:
```
/setting                        # Pilih mode respons (auto/prefix)
/trigger reply on               # Bot respons saat direply
/trigger tag on                 # Bot respons saat di-tag
```
:::
