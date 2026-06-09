---
sidebar_position: 9
---

# FAQ — Pertanyaan yang Sering Ditanyakan

## Mengapa bot tidak merespons pesan saya?

Kemungkinan penyebab:
- **Mode prefix aktif** — Bot hanya merespons saat @mention, reply, atau nama disebut. Cek dengan `/mode` dan ubah dengan `/mode auto` jika perlu.
- Di grup, bot tidak selalu merespons setiap pesan. Coba **mention atau reply** langsung ke bot.
- Bot sedang memproses pesan lain (terlihat dari indikator mengetik).
- Pesanmu sudah terlalu lama (bot hanya melihat beberapa pesan terakhir).

## Mengapa perintah `/prompt` saya tidak berhasil?

- Di grup, **hanya admin** yang bisa menggunakan `/prompt`.
- Pastikan perintah ditulis dengan benar (diawali `/`).
- Cek apakah teksmu melebihi 4000 karakter.

## Bagaimana cara menghentikan bot dari merespons?

- Gunakan `/prompt` untuk mengubah perilaku bot, atau
- Admin grup bisa mengeluarkan bot dari grup

## Apakah bot menyimpan pesan saya?

Bot menyimpan riwayat percakapan **secara sementara** untuk memberikan konteks jawaban. Gunakan `/reset` untuk menghapus riwayat ini.

## Bisakah bot menjawab dalam bahasa lain?

Ya! Bot bisa berkomunikasi dalam berbagai bahasa. Kamu bisa meminta bot berbahasa tertentu melalui `/prompt`, atau cukup ajak bot bicara dalam bahasa yang kamu inginkan.

## Mengapa bot menghapus pesan saya?

Bot menghapus pesan jika:
- Permission level diset ke 1 atau 3
- Promptnya memerintahkan bot untuk menghapus jenis pesan tersebut

Hubungi admin grup untuk mengetahui aturan yang berlaku.

## Bot tiba-tiba kick saya padahal tidak melanggar aturan?

Ini bisa terjadi jika prompt moderasi terlalu agresif. Hubungi admin grup untuk:
1. Mengecek prompt dengan `/prompt`
2. Menurunkan level permission dengan `/permission 1` atau `/permission 0`
3. Memperbaiki prompt agar lebih spesifik

## Apakah pengaturan berlaku untuk semua grup?

**Tidak.** Semua pengaturan (prompt, permission, reset) berlaku **per chat**. Pengaturan di grup A tidak mempengaruhi grup B.
