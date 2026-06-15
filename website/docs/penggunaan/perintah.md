---
sidebar_position: 3
---

# Daftar Perintah

Semua perintah diawali dengan `/` (garis miring). Di grup, sebagian besar perintah hanya bisa digunakan oleh **admin**. Di chat pribadi, semua pengguna bisa memakai semua perintah. Sebagian perintah hanya untuk **owner bot**.

## Ringkasan

| Perintah | Fungsi | Siapa Bisa |
|----------|--------|------------|
| `/activate <kode>` | Aktifkan chat dengan kode aktivasi | Siapa saja |
| `/add-sticker <nama>` | Tambah stiker ke katalog (reply ke stiker) | Admin (grup), Siapa saja (pribadi) |
| `/announcement [pesan]` | Kirim pengumuman ke semua anggota (@all) | Admin grup |
| `/bot-conf` | Konfigurasi bot global (owner) | Owner bot saja |
| `/broadcast <pesan>` | Kirim pesan ke semua grup | Owner bot saja |
| `/catch` | Tandai pesan agar diproses ulang bot | Siapa saja |
| `/dashboard` | Tampilkan statistik penggunaan | Siapa saja |
| `/debug` | Tampilkan info debug | Owner bot saja |
| `/generate <prompt>` | Buat gambar dari prompt teks | Owner bot saja |
| `/help` | Tampilkan daftar perintah | Siapa saja |
| `/idle <n\|min-max\|off>` | Konfigurasi pemicu idle | Admin / Owner |
| `/info` | Info pengguna & chat/grup | Siapa saja |
| `/join <link>` | Perintahkan bot bergabung ke grup via link | Siapa saja |
| `/modelcfg` | Konfigurasi model default | Owner bot saja |
| `/monitor` | Monitor dashboard semua chat | Owner bot saja |
| `/owner-contact` | Kirim kartu kontak owner bot | Siapa saja |
| `/permission` | Cek/set level izin moderasi | Admin grup |
| `/prompt` | Lihat/set/hapus prompt bot | Admin (grup), Siapa saja (pribadi) |
| `/remove-sticker <nama>` | Hapus stiker dari katalog | Admin (grup), Siapa saja (pribadi) |
| `/reset` | Reset memori bot | Admin (grup), Siapa saja (pribadi) |
| `/revoke [n]` | Cabut link undangan grup | Owner bot saja |
| `/setting` | Lihat/ubah pengaturan per-chat (termasuk mode respons) | Admin (grup), Siapa saja (pribadi) |
| `/sticker [bawah#atas]` | Buat stiker dari gambar/video | Siapa saja |
| `/subagent <on\|off>` | Aktif/nonaktifkan sub-agent per chat | Owner bot saja |
| `/trigger <jenis>` | Cek/ubah trigger dalam prefix mode | Admin grup |

:::note
Mode respons (auto/prefix) **tidak lagi** memakai perintah `/mode`. Mode kini diatur lewat menu interaktif **`/setting`**.
:::

---

## `/activate`

Mengaktifkan chat ini menggunakan **kode aktivasi** yang diberikan oleh owner. Setelah diaktifkan, bot akan merespons pesan di chat ini.

```
/activate WA-ABC12345
```

---

## `/add-sticker`

Menambahkan stiker ke **katalog bot** dengan membalas (reply) sebuah stiker dan menyebut namanya. Bot bisa mengirim stiker dari katalog ini lewat tool `send_sticker`.

```
/add-sticker kucing lucu
```

Gunakan `/add-sticker global <nama>` untuk menambah ke katalog global semua chat (khusus owner).

---

## `/announcement`

Mengirim pesan pengumuman ke seluruh anggota grup dengan mention `@all`. Tanpa argumen menampilkan status on/off saat ini.

```
/announcement Rapat malam ini jam 20.00 WIB
```

---

## `/bot-conf`

Konfigurasi bot secara **global** (berlaku untuk semua chat): ubah pesan aktivasi, atur system prompt dasar, atau aktif/nonaktifkan wajib-aktivasi.

```
/bot-conf
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/broadcast`

Mengirim pesan ke **semua grup** tempat bot terdaftar.

```
/broadcast <pesan>
```

Atau **reply** ke pesan tertentu dengan `/broadcast` untuk meneruskan pesan itu ke semua grup.

:::warning
Hanya bisa digunakan oleh **pemilik bot (owner)**. Pengguna biasa tidak bisa menggunakan perintah ini.
:::

---

## `/catch`

Menandai pesan yang kamu balas agar dapat **diproses ulang** oleh bot. Berguna ketika bot perlu menganalisis ulang pesan tertentu.

```
/catch
```

---

## `/dashboard`

Menampilkan **statistik penggunaan** bot di chat ini.

```
/dashboard
```

Menampilkan:
- Jumlah pesan yang diproses
- Jumlah respons yang dikirim
- Token yang digunakan (LLM1 & LLM2)
- Rata-rata waktu respons
- Informasi lainnya tergantung konfigurasi

**Bisa digunakan oleh siapa saja**, tidak perlu admin.

---

## `/debug`

Menampilkan informasi **debug** (untuk pengembangan/diagnostik).

```
/debug
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/generate`

Membuat **gambar** dari prompt teks.

```
/generate kucing astronot pakai helm
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/help`

Menampilkan **daftar perintah** yang tersedia. Alias: `/menu`, `/list`.

```
/help
```

---

## `/idle`

Mengatur **pemicu idle**: bot ikut berkomentar setelah sejumlah pesan berlalu tanpa dibalas.

```
/idle 5          # setelah tepat 5 pesan
/idle 5-10       # acak dalam rentang
/idle off        # nonaktifkan
```

---

## `/info`

Menampilkan informasi pengguna dan chat/grup.

```
/info
```

Menampilkan:
- **Info pengguna:** nama, JID (ID WhatsApp), peran (member/admin/superadmin/owner)
- **Info grup** (jika di grup): nama grup, ID grup, jumlah anggota, status admin bot, status superadmin bot, deskripsi grup
- **Info chat** (jika di chat pribadi): tipe chat, ID chat, status aktivasi

**Bisa digunakan oleh semua orang**, tidak perlu jadi admin.

---

## `/join`

Memerintahkan bot untuk **bergabung ke grup** WhatsApp menggunakan link undangan. Bot akan join atas namanya sendiri.

```
/join https://chat.whatsapp.com/AbCdEfGhIjK
```

---

## `/modelcfg`

Mengatur **konfigurasi model default** untuk LLM2 (lewat menu interaktif).

```
/modelcfg
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/monitor`

Menampilkan **monitor dashboard** ringkas untuk semua chat.

```
/monitor
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/owner-contact`

Mengirim **kartu kontak owner** bot ke chat ini. Owner dapat mengatur kontak yang dikirim dengan `/owner-contact set <nomor>`.

```
/owner-contact
```

---

## `/permission`

Mengatur **level izin untuk tindakan moderasi** (hapus/mute/kick).

### Melihat permission saat ini
```
/permission
```

### Mengatur permission level
```
/permission 0    # Tidak ada moderasi
/permission 1    # Bot bisa hapus pesan
/permission 2    # + mute anggota
/permission 3    # + kick anggota (full moderasi)
```

**Level 0** — Bot hanya ngobrol, moderasi dimatikan
**Level 1** — Bot bisa menghapus pesan spam
**Level 2** — Bot bisa mute anggota nakal
**Level 3** — Bot punya otoritas moderasi penuh (termasuk kick)

:::info
Permission hanya bisa diatur oleh **admin grup**. Setting berlaku per-chat.
:::

---

## `/prompt`

Mengatur **kepribadian, peran, dan aturan** bot di chat ini.

### Melihat prompt saat ini
```
/prompt
```

### Mengatur prompt baru
```
/prompt <teks aturanmu>
```
**Batas:** maksimal 4000 karakter.

### Menghapus prompt (kembali ke default)
```
/prompt clear
```

:::info
Prompt berlaku **per chat/grup**. Pengaturan di grup A tidak mempengaruhi grup B.
:::

---

## `/remove-sticker`

Menghapus stiker dari **katalog bot** berdasarkan namanya.

```
/remove-sticker kucing lucu
```

Gunakan `/remove-sticker global <nama>` untuk menghapus dari katalog global (khusus owner).

---

## `/reset`

Menghapus **memori/riwayat percakapan** bot untuk chat ini.

```
/reset
```

Gunakan ketika:
- Bot sudah "keluar jalur" dan jawabannya tidak nyambung
- Ingin memulai percakapan baru dari awal
- Setelah mengganti prompt besar-besaran

Gunakan `/reset global` untuk menghapus memori semua chat sekaligus (khusus owner).

---

## `/revoke`

Mencabut **link undangan grup** saat ini dan membuat link baru yang fresh. Berguna ketika link lama bocor. Opsional: ulangi beberapa kali.

```
/revoke 3
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/setting`

Menampilkan dan mengubah **pengaturan per-chat** lewat menu interaktif: mode respons (auto/prefix), model, level permission, pemicu idle, dan status aktivasi.

```
/setting
```

:::info
**Mode respons** (auto/prefix) kini diatur di sini, menggantikan perintah lama `/mode`.
:::

---

## `/sticker`

Membuat **stiker WhatsApp** dari gambar atau video. Kirim gambar dengan caption `/sticker`, atau reply gambar/video dengan `/sticker`. Tambahkan teks meme dengan format `/sticker teks_bawah#teks_atas`.

```
/sticker gue banget#ketika senin tiba
```

---

## `/subagent`

Mengaktifkan atau menonaktifkan **sub-agent** untuk chat ini. Sub-agent memungkinkan bot mendelegasikan tugas kompleks ke layanan eksternal (WazzapSubAgents). Perlu `SUBAGENT_URL` dikonfigurasi.

```
/subagent on
```

:::warning
Hanya **pemilik bot (owner)** yang bisa menggunakan perintah ini.
:::

---

## `/trigger`

Mengatur **pemicu respons** dalam **mode prefix/hybrid**. Tentukan apa saja yang membuat bot merespons.

### Melihat triggers saat ini
```
/trigger
```

### Mengatur triggers
```
/trigger reply on         # Bot respons saat direply
/trigger tag on           # Bot respons saat di-mention
```

**Trigger yang tersedia:**
- `tag` — Bot di-mention secara eksplisit (contoh: `@Vivy`)
- `tagall` — Pesan memakai `@all`
- `reply` — Pesan adalah reply ke pesan bot sebelumnya
- `name` — Nama bot disebut di teks pesan (case-insensitive)
- `join` — Anggota baru bergabung ke grup

:::note
Hanya berlaku dalam **mode prefix/hybrid**. Di mode auto, trigger diabaikan.
:::
