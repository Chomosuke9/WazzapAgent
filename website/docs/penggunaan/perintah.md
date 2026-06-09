---
sidebar_position: 3
---

# Daftar Perintah

Semua perintah diawali dengan `/` (garis miring). Di grup, sebagian besar perintah hanya bisa digunakan oleh **admin**. Di chat pribadi, semua pengguna bisa memakai semua perintah.

## Ringkasan

| Perintah | Fungsi | Siapa Bisa |
|----------|--------|------------|
| `/prompt` | Lihat/set/hapus prompt bot | Admin (grup), Siapa saja (pribadi) |
| `/reset` | Reset memori bot | Admin (grup), Siapa saja (pribadi) |
| `/permission` | Cek/set level izin moderasi | Admin grup |
| `/mode` | Cek/ubah mode respons (auto/prefix) | Owner bot saja |
| `/trigger` | Cek/ubah trigger dalam prefix mode | Owner bot saja |
| `/dashboard` | Tampilkan statistik penggunaan | Siapa saja |
| `/info` | Info pengguna & chat/grup | Siapa saja |
| `/broadcast <pesan>` | Kirim pesan ke semua grup | Owner bot saja |

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
/prompt -
```
atau `/prompt clear` atau `/prompt reset`

:::info
Prompt berlaku **per chat/grup**. Pengaturan di grup A tidak mempengaruhi grup B.
:::

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

---

## `/info`

Menampilkan informasi pengguna dan chat/grup.

```
/info
```

Menampilkan:
- **Info pengguna:** nama, JID (ID WhatsApp), peran (member/admin/superadmin/owner)
- **Info grup** (jika di grup): nama grup, ID grup, jumlah anggota, status admin bot, status superadmin bot, deskripsi grup
- **Info chat** (jika di chat pribadi): tipe chat, ID chat

**Bisa digunakan oleh semua orang**, tidak perlu jadi admin.

---

## `/permission`

Mengatur **level izin untuk tindakan moderasi** (hapus/kick pesan).

### Melihat permission saat ini
```
/permission
```

### Mengatur permission level
```
/permission 0    # Hapus & kick dilarang
/permission 1    # Hapus diizinkan, kick dilarang
/permission 2    # Kick diizinkan, hapus dilarang
/permission 3    # Hapus & kick diizinkan (full moderasi)
```

**Level 0** — Bot hanya ngobrol, moderasi dimatikan
**Level 1** — Bot bisa menghapus pesan spam
**Level 2** — Bot bisa mengeluarkan anggota nakal
**Level 3** — Bot punya otoritas moderasi penuh

:::info
Permission hanya bisa diatur oleh **admin grup**. Setting berlaku per-chat.
:::

---

## `/mode`

Mengatur **mode respons** bot di grup: **auto** atau **prefix**.

### Melihat mode saat ini
```
/mode
```

### Mengatur mode
```
/mode auto        # LLM1 decides when to respond
/mode prefix      # Bot hanya respons jika ditag/direply/disebut namanya
```

**Mode `auto`** (default):
- Bot menganalisis setiap pesan dengan LLM1
- Merespons secara otomatis jika ada konteks penting
- Lebih smart tapi menggunakan lebih banyak token

**Mode `prefix`** (optimal untuk grup ramai):
- Bot hanya respons saat eksplisit dipanggil
- Bisa dikonfigurasi dengan `/trigger`
- Lebih hemat token, respons lebih cepat

:::warning
Hanya **pemilik bot (owner)** yang bisa mengubah mode.
:::

---

## `/trigger`

Mengatur **pemicu respons** dalam **mode prefix**. Tentukan apa saja yang membuat bot merespons.

### Melihat triggers saat ini
```
/trigger
```

### Mengatur triggers
```
/trigger all              # Aktifkan semua trigger
/trigger none             # Matikan semua trigger
/trigger tag,reply        # Bot respons saat @tag atau direply
/trigger tag,reply,name   # Tambahkan trigger "name mention"
```

**Trigger yang tersedia:**
- `tag` — Bot @mention secara eksplisit (contoh: `@Vivy`)
- `reply` — Pesan adalah reply ke pesan bot sebelumnya
- `join` — Anggota baru bergabung ke grup
- `name` — Nama bot disebut di teks pesan (case-insensitive)

:::note
Hanya berlaku dalam **mode prefix**. Di mode auto, trigger diabaikan.
:::

:::warning
Hanya **pemilik bot (owner)** yang bisa mengubah trigger.
:::

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

## `/broadcast`

Mengirim pesan ke **semua grup** tempat bot terdaftar.

```
/broadcast <pesan>
```

Atau **reply** ke pesan tertentu dengan `/broadcast` untuk meneruskan pesan itu ke semua grup.

:::warning
Hanya bisa digunakan oleh **pemilik bot (owner)**. Pengguna biasa tidak bisa menggunakan perintah ini.
:::
