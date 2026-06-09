---
sidebar_position: 7
---

# Fitur-Fitur Bot

## Membaca Gambar & Media

Bot bisa **memahami dan mendeskripsikan** gambar, foto, stiker, dan dokumen yang dikirim ke chat. Tinggal kirim gambar dan bot akan memahami konteksnya secara otomatis.

**Batasan:**
- Maksimal **2 file** per pesan yang diproses
- Ukuran total maksimal **5 MB**

## Sinyal Centang Biru (Read)

Setelah bot selesai memproses pesanmu (memutuskan mau jawab atau tidak), bot akan otomatis **mencentang biru** pesanmu. Ini tanda bot sudah "membaca" dan memproses pesanmu.

## Indikator Mengetik

Ketika bot sedang menyusun balasan, kamu akan melihat **"[Nama Bot] sedang mengetik..."** — persis seperti kalau teman sedang menulis pesan.

## Memory / Konteks Percakapan

Bot **mengingat konteks percakapan** beberapa pesan terakhir, sehingga:
- Bot tahu apa yang dibicarakan sebelumnya
- Bot bisa menjawab pertanyaan lanjutan tanpa perlu mengulang konteks

Gunakan `/reset` untuk menghapus memori ini dan mulai dari awal.

## Reply ke Pesan

Bot me-**reply** ke pesan tertentu saat menjawab, sehingga jelas pesan mana yang sedang dibalas — terutama berguna di grup yang ramai.

## Deteksi Anggota Baru

Bot secara otomatis **mendeteksi ketika ada anggota baru** bergabung ke grup dan bisa menyapa mereka jika prompt-nya mengatur ini.

## Mode Respons (Auto vs Prefix)

Bot memiliki **dua mode respons** yang bisa dikonfigurasi:

- **`auto`** (default) — Bot menganalisis konteks setiap pesan dan merespons secara otomatis
- **`prefix`** (hemat token) — Bot hanya merespons saat dipanggil: `@mention`, reply, atau nama disebut

Gunakan `/mode` untuk melihat atau mengubah mode. Pemilik bot bisa mengatur dengan:
```
/mode prefix        # Aktifkan mode hemat
/trigger tag,reply  # Atur trigger respons
```

## Pengaturan Prompt, Mode, & Permission

Admin & pemilik bot bisa mengatur perilaku bot:
- `/prompt <teks>` — Atur instruksi kustom untuk bot di chat ini
- `/permission <0-3>` — Atur level permission moderasi (delete/kick)
- `/mode <auto|prefix>` — Ubah mode respons (pemilik bot saja)
- `/trigger <triggers>` — Atur pemicu dalam mode prefix (pemilik bot saja)
- `/dashboard` — Lihat statistik penggunaan
