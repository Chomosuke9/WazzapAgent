---
sidebar_position: 4
---

# Sistem Permission (Izin Moderasi)

Permission mengontrol seberapa besar otoritas bot dalam mengelola grup.

## Level Permission

| Level | Hapus Pesan | Mute Anggota | Kick Anggota | Keterangan |
|-------|:-----------:|:------------:|:------------:|------------|
| **0** | ❌ | ❌ | ❌ | Default. Bot hanya mengobrol. |
| **1** | ✅ | ❌ | ❌ | Bot bisa hapus pesan melanggar. |
| **2** | ✅ | ✅ | ❌ | Bot bisa hapus + mute anggota. |
| **3** | ✅ | ✅ | ✅ | Bot punya otoritas moderasi penuh (hapus + mute + kick). |

## Cara Mengatur

```
/permission       ← cek level saat ini
/permission 0     ← nonaktifkan semua moderasi
/permission 1     ← aktifkan hapus pesan saja
/permission 2     ← aktifkan hapus + mute
/permission 3     ← aktifkan hapus + mute + kick
```

:::note
Hanya bisa digunakan di **grup**. Hanya **admin grup** yang bisa mengubah permission.
:::

## Kapan Pakai Level Berapa?

- **Level 0** — Bot hanya dipakai untuk ngobrol, tidak perlu moderasi
- **Level 1** — Grup banyak spam link/pesan toksik tapi tidak ingin ada yang di-kick
- **Level 2** — Perlu hapus pesan + mute anggota yang mengganggu
- **Level 3** — Grup butuh moderasi penuh (hapus + mute + kick)

## Alur yang Disarankan

1. **Jadikan bot admin** terlebih dahulu
2. **Set prompt moderator** (lihat [Contoh Prompt](/penggunaan/contoh-prompt))
3. **Coba di grup testing** mulai dari level 1
4. Naikkan level setelah yakin bot berperilaku dengan benar

:::danger PERINGATAN
**KICK DAN DELETE ADALAH KEMAMPUAN YANG SANGAT MERUSAK.**

Bot yang salah dikonfigurasi dapat mengeluarkan anggota secara tidak sengaja atau menghapus pesan penting.

**WAJIB:** Coba di grup testing dulu sebelum mengaktifkan di grup sungguhan. Jangan langsung set permission 3.
:::
