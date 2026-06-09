# Cara mendapatkan LID

## Memakai command `/info`
:::note
Cara ini memerlukan bot untuk mendapatkan LID-nya. Jika bot belum online, [nyalakan dulu](/instalasi#3-Install-Dependensi-Nodejs-dan-Python).
:::
Caranya sangat mudah, tinggal ketik `/info` menggunakan nomor owner-nya saja.
![slash info](/img/slash_info.jpg)

## Menggunakan Meta Ai
:::note
Cara ini memerlukan 2 akun ATAU orang lain untuk mendapatkan LID-nya.
:::

Langkah-langkah:
1. Pergi ke group dimana nomor owner ada disitu dan @Meta Ai juga ada(nonaktifkan privasi tingkat lanjut group).
2. Ketik

```txt
@Meta Ai Give me this person id's @<nomor owner>
```
3. Hasil seharusnya seperti ini
![Meta ai method success](/img/meta_ai_method.jpg)
4. `@4131402...` itu adalah LID orang yang di tag, gunakan itu.


## Konfirmasi apakah nomor owner terdeteksi
Setelah mengkonfigurasi env `BOT_OWNER_JIDS`, kamu harus mengonfirmasi menggunakan command `/info`. ini bisa dilihat melalui bagian `Owner bot:...`.
![slash info](/img/slash_info.jpg)
