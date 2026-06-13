---
sidebar_position: 1
---

# Panduan Instalasi

Panduan untuk menginstall dan menjalankan WazzapAgents di server atau komputer lokal Kamu.

## Prasyarat

| Software | Versi | Catatan |
|----------|-------|---------|
| Node.js | 18+ | Tested dengan Node 25 |
| pnpm | 9+ | `npm i -g pnpm` atau `corepack enable pnpm` |
| Python | 3.10+ | Untuk bridge |
| SQLite | 3.x | Biasanya sudah terinstall di OS |

## Instalasi

### 1. Clone Repository

```bash
git clone https://github.com/Chomosuke9/WazzapAgents.git && cd WazzapAgents
```
![Clone Repository](/img/2026-05-05-143910_hyprcap.png)

Cek apakah berhasil:

![Check Repository](/img/check_repo.png)

Jika berhasil tandanya akan muncul isi project ini:

![Check Repository Success](/img/check_success.png)


### 2. Setup Environment Variables

```bash
cp .env.example .env
```
Kemudian edit dengan text editor (disini menggunakan `nano`)
```bash
nano .env
```

![Nano .env](/img/nano_env.png)

Edit `.env` dan isi minimal:
```bash
# Node gateway adalah WebSocket SERVER. Port yang di-listen:
WS_LISTEN_PORT=3000
# Port(angka) ini bisa di ganti jadi apa saja, yang penting tidak terpakai port-nya.

# URL yang di-dial oleh Python bridge (client) menuju gateway.
# Harus sesuai dengan WS_LISTEN_PORT di atas.
NODE_URL=ws://localhost:3000

# Opsional — bearer token untuk autentikasi WS (di-enforce Node, dikirim client Python)
LLM_WS_TOKEN=
# Opsional — host bind WS server (default 127.0.0.1; set 0.0.0.0 untuk lintas-host)
WS_BIND_HOST=127.0.0.1

# Contoh: vivy,ivy,vivi,ivi,vy  (display name: vivy, aliases: ivy, vivi, etc.)
ASSISTANT_NAME=LLM

# Ini endpoint dan kunci API dari AI yang kamu pakai, WAJIB OpenAi compatible. 
LLM2_ENDPOINT=
LLM2_API_KEY=
```

Kemudian tambahkan JID/LID nomor kamu.
```bash
# Contoh: 628123456789@s.whatsapp.net, 193058310034@lid
BOT_OWNER_JIDS=
```
:::note
Setiap nomor bisa memakai JID(nomor handphone) atau LID(ID yang diberikan WhatsApp), jika JID(nomor handphone) tidak bekerja, gunakan LID dengan mengetik `/info` untuk mendapatkan LID-nya.

[**Cara lengkapnya ada disini**](/instalasi/cara-mendapatkan-lid)
:::


### 3. Install Dependensi Node.js dan Python.
**Node.js**:
```bash
pnpm install
```
**Python**:
```bash
pip install -r requirements.txt
```

Atau dengan virtual environment (direkomendasikan):

```bash
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
pip install -r requirements.txt
```

### 4. Menjalankan

Dua komponen harus berjalan bersamaan. Node gateway adalah WebSocket **server**, jadi jalankan **gateway lebih dulu**, baru kemudian Python bridge (client) yang men-dial-nya.
:::tip
Gunakan **Terminal multiplexer** agar bisa menjalankan _service_-nya di background. Kamu bisa memakai _Tmux_, _Zellij_, _Byobu_, atau apapun yang kamu suka. 
:::
**Terminal 1 — Node.js Gateway (WS server):**
```bash
pnpm dev
```

**Terminal 2 — Python Bridge (WS client):**
```bash
python -m python.bridge.main
```

Saat pertama kali jalan, gateway akan menampilkan QR code di terminal. Scan dengan WhatsApp untuk pairing.

### 5. Menambahkan model
Kamu harus menambahkan model Ai yang ingin kamu gunakan terlebih dahulu, tanpa modelnya, bot ini hampir tidak bisa melakukan apapun.

Langkah-langkah:
1. Pastikan nomor kamu sudah terdaftar sebagai nomor owner, [**kalau belum atur itu sekarang juga**](/instalasi/cara-mendapatkan-lid).
2. Kirim command `/modelcfg add` ke bot nya, formatnya seperti ini

![model add](/img/slash_model_add.jpg)

Perhatikan, format nya adalah seperti ini
```txt
/model add <id model>|<nama model>|<deskripsi model>|<vision support modelnya>
```

:::warning
1. Gunakan `|` sebagai pemisah. 
2. `<id model>` WAJIB akurat, tidak ada kode yang memperbaiki id nya secara otomatis.
3. `<vision support modelnya>` WAJIB benar, jika modelnya tidak support _vision_, JANGAN di atur ke `true`, itu akan menyebabkan error dan bot nya jadi tidak menjawab.
:::

### Verifikasi model.
Ketik `/setting` untuk membuka menu seperti ini

![slash setting](/img/slash_setting.jpg)

kemudian pencet bagian `Change model`, jika kamu melakukan [langkah tadi](/instalasi#5-menambahkan-model) dengan benar, maka akan keluar hasil seperti ini

![slash setting model](/img/gpt_model.jpg)


## Sub-Agent

**Sub-Agent** adalah service executor terpisah yang menjalankan agent otonom di dalam container Docker terisolasi. Sub-Agent menerima instruksi dari WazzapAgents, menjalankan _tool_ (bash, Python, JavaScript) di dalam sandbox, lalu mengembalikan hasil dan file output ke WhatsApp.

Tidak seperti bot utama yang hanya membalas chat, Sub-Agent bisa memproses tugas berat yang membutuhkan eksekusi kode asli.

### Kapan Sub-Agent Dipakai?

Aktifkan Sub-Agent jika kamu ingin bot mengerjakan tugas yang lebih berat dari sekadar membalas chat, misalnya:

- membaca dan memproses file yang dikirim pengguna (PDF, DOCX, XLSX, PPTX, dan lain-lain);
- mengekstrak tabel atau ringkasan dari dokumen;
- menjalankan script kecil (bash, Python, JavaScript) di sandbox terisolasi;
- membuat file hasil kerja (laporan, gambar, dokumen) dan mengirimkannya kembali ke WhatsApp.

Jika bot hanya dipakai untuk ngobrol biasa atau moderasi grup, Sub-Agent boleh tetap dimatikan.

:::info
Sub-Agent **tidak** bisa mengakses internet secara langsung. Sub-Agent hanya bisa memproses file dan menjalankan kode di dalam sandbox-nya sendiri.
:::

### Arsitektur Singkat

Sub-Agent berjalan sebagai service terpisah ([WazzapSubAgents](https://github.com/Chomosuke9/WazzapSubAgents)) yang terdiri dari dua container:

1. **executor-service** (Flask, port 5000) — menerima permintaan dari WazzapAgents, menjalankan agent loop (LLM ReAct), dan mengirim callback webhook.
2. **executor-executor** (sidecar, port 5001) — menjalankan kode bash/Python/JavaScript yang dihasilkan oleh agent di dalam sandbox.

WazzapAgents mengirim tugas ke `/execute`, Sub-Agent memprosesnya secara asinkron, lalu mengirim hasilnya balik lewat webhook ke WazzapAgents. Jika ada antrian, pengguna akan diberitahu posisi antrian mereka.

### 1. Jalankan WazzapSubAgents

Clone service Sub-Agent dan siapkan environment-nya:

```bash
git clone https://github.com/Chomosuke9/WazzapSubAgents.git && cd WazzapSubAgents
cp .env.example .env
```

Edit `.env`, lalu isi minimal:

```bash
LLM_API_KEY=<api key kamu>
AGENT_MODEL_LOW=<model untuk sub-agent>
```

:::note
`AGENT_MODEL` (tanpa `_LOW`) tetap didukung untuk backward compatibility dan akan otomatis digunakan sebagai `AGENT_MODEL_LOW` jika `AGENT_MODEL_LOW` tidak diatur.
:::

Opsional — atur model berkualitas tinggi untuk tugas yang lebih kompleks:

```bash
AGENT_MODEL_HIGH=<model lebih powerful untuk tugas kompleks>
# Jika tidak diatur, akan menggunakan AGENT_MODEL_LOW
AGENT_TEMPERATURE_LOW=0.7
AGENT_TEMPERATURE_HIGH=0.3
```

Jalankan dengan Docker Compose (direkomendasikan):

```bash
docker-compose up -d
```

Atau jalankan secara native (tanpa Docker untuk service utama, hanya sidecar yang pakai Docker):

```bash
pip install -r requirements.txt
python main.py
```

Service ini akan membuka:

- API utama: `http://localhost:5000`
- Executor sidecar: `http://localhost:5001`

### 2. Hubungkan WazzapAgents ke Sub-Agent

Di `.env` WazzapAgents, tambahkan:

```bash
SUBAGENT_URL=http://localhost:5000
SUBAGENT_WEBHOOK_PORT=8081
SUBAGENT_WEBHOOK_URL=http://localhost:8081/subagent/callback
```

Jika WazzapSubAgents berjalan di Docker dan harus memanggil balik WazzapAgents di host, gunakan:

```bash
SUBAGENT_WEBHOOK_URL=http://host.docker.internal:8081/subagent/callback
```

:::tip
`docker-compose.yml` di WazzapSubAgents sudah menambahkan `host.docker.internal` untuk Linux dengan `host-gateway`.
:::

### 3. Pastikan Folder File Dibagi Bersama

Untuk tugas yang memakai file, WazzapAgents dan WazzapSubAgents harus bisa membaca folder host yang sama. Jika menggunakan Docker Compose, gunakan `/storage` sebagai direktori bersama:

```bash
# Di .env WazzapSubAgents:
SUBAGENT_STORAGE_DIR=/storage
WORKDIR_BASE=/storage/subagent_work
```

Jika menjalankan secara native (tanpa Docker Compose), biarkan `SUBAGENT_INPUT_STAGING_DIR` kosong dan WazzapAgents akan menggunakan `<project_root>/data/subagent_in` secara otomatis.

Pastikan WazzapAgents bisa membaca file yang dikembalikan Sub-Agent. Jika tidak, hasil file tidak bisa dikirim balik sebagai media WhatsApp.

### 4. Aktifkan dari WhatsApp

Hanya owner bot yang bisa menyalakan Sub-Agent:

```txt
/subagent on
/subagent off
/subagent global on
/subagent global off
```

Cek status untuk chat saat ini:

```txt
/subagent
```

### 5. Uji Alurnya

Setelah kedua service berjalan:

1. Kirim `/subagent on` di chat.
2. Minta tugas yang membutuhkan tool, misalnya: "Baca dokumen ini dan ekstrak tabelnya."
3. Main agent akan memberi acknowledgement.
4. Sub-Agent memproses tugas secara asinkron. Jika ada antrian, kamu akan diberitahu posisi antrianmu.
5. Sub-Agent mengirim progress lewat webhook.
6. Setelah selesai, WazzapAgents merangkum hasil dan mengirim file output jika ada.

:::warning
Sub-Agent menjalankan kode di dalam sandbox Docker. Meskipun terisolasi, jalankan hanya di server yang kamu kontrol, jaga API key tetap privat, dan aktifkan hanya untuk chat yang kamu percaya.
:::

## Variabel Environment

### Gateway (Node.js)

| Variabel | Default | Deskripsi |
|----------|---------|-----------|
| `WS_LISTEN_PORT` | `3000` | Port yang di-listen WS server (Node gateway) |
| `NODE_URL` | `ws://localhost:3000` | URL yang di-dial Python bridge menuju gateway |
| `WS_BIND_HOST` | `127.0.0.1` | Host bind WS server (set `0.0.0.0` untuk lintas-host) |
| `LLM_WS_TOKEN` | *(kosong)* | Bearer token untuk autentikasi WS |
| `INSTANCE_ID` | `default` | Identifier instance gateway |
| `DATA_DIR` | `./data` | Direktori data runtime |
| `MEDIA_DIR` | `./data/media` | Direktori penyimpanan media |
| `LOG_LEVEL` | `info` | Level log (debug, info, warn, error) |
| `WS_RECONNECT_MS` | `5000` | Interval reconnect WS dalam ms |
| `GROUP_METADATA_TIMEOUT_MS` | `8000` | Timeout fetch metadata grup |
| `DOWNLOAD_TIMEOUT_MS` | `60000` | Timeout download media |
| `SEND_TIMEOUT_MS` | `60000` | Timeout kirim pesan |
| `UPSERT_CONCURRENCY` | `2` | Concurrency pemrosesan pesan |
| `BOT_OWNER_JIDS` | *(kosong)* | JID owner, pisahkan koma |

### Bridge (Python)

| Variabel | Default | Deskripsi |
|----------|---------|-----------|
| `HISTORY_LIMIT` | `20` | Jumlah pesan history per chat |
| `INCOMING_DEBOUNCE_SECONDS` | `5` | Debounce window untuk batching |
| `INCOMING_BURST_MAX_SECONDS` | `20` | Maksimum durasi burst window |
| `ASSISTANT_NAME` | `LLM` | Nama tampilan bot di konteks |
| `CONTEXT_TIME_UTC_OFFSET_HOURS` | *(auto)* | UTC offset untuk timestamp |

### Sub-Agent (Bridge ke WazzapSubAgents)

| Variabel | Default | Deskripsi |
|----------|---------|-----------|
| `SUBAGENT_URL` | `http://localhost:5000` | URL service WazzapSubAgents |
| `SUBAGENT_WEBHOOK_PORT` | `8081` | Port webhook server di bridge |
| `SUBAGENT_WEBHOOK_URL` | `http://localhost:8081/subagent/callback` | Callback URL yang dikirim ke Sub-Agent |
| `SUBAGENT_ENABLED_DEFAULT` | `false` | Aktifkan Sub-Agent secara default untuk chat baru |
| `SUBAGENT_WAIT_TIMEOUT_S` | `300` | Timeout tunggu callback Sub-Agent (detik) |

### LLM1 (Gating)

| Variabel | Default | Deskripsi |
|----------|---------|-----------|
| `LLM1_ENDPOINT` | *(OpenAI default)* | Endpoint API LLM1 |
| `LLM1_MODEL` | `openai/gpt-oss-20b` | Model untuk gating |
| `LLM1_API_KEY` | *(kosong)* | API key LLM1 |
| `LLM1_TEMPERATURE` | `0` | Temperature untuk LLM1 |
| `LLM1_TIMEOUT` | `8` | Timeout dalam detik |
| `LLM1_HISTORY_LIMIT` | `20` | Limit history untuk konteks LLM1 |
| `LLM1_MESSAGE_MAX_CHARS` | `500` | Maks karakter per pesan untuk LLM1 |
| `LLM1_ENABLE_MEDIA_INPUT` | `0` | Aktifkan input multimodal LLM1 |
| `LLM1_FALLBACK_ENDPOINT` | *(reuse LLM1)* | Endpoint fallback |
| `LLM1_FALLBACK_MODEL` | *(kosong)* | Model fallback |
| `LLM1_FALLBACK_API_KEY` | *(reuse LLM1)* | API key fallback — isi jika endpoint fallback memakai key berbeda |

### LLM2 (Responder)

| Variabel | Default | Deskripsi |
|----------|---------|-----------|
| `LLM2_ENDPOINT` | *(OpenAI default)* | Endpoint API LLM2 |
| `LLM2_MODEL` | `gpt-5.3` | Model default — di-override oleh database jika sudah ada model yang ditambahkan via `/modelcfg add` |
| `LLM2_API_KEY` | *(kosong)* | API key LLM2 |
| `LLM2_TEMPERATURE` | `0.5` | Temperature untuk LLM2 |
| `LLM2_TIMEOUT` | `20` | Timeout dalam detik |
| `LLM2_RETRY_MAX` | `0` | Maks retry saat timeout |
| `LLM2_RETRY_BACKOFF_SECONDS` | `0.8` | Backoff antar retry |
| `LLM2_ENABLE_MEDIA_INPUT` | `1` | Aktifkan input multimodal LLM2 |
| `LLM2_FALLBACK_ENDPOINT` | *(reuse LLM2)* | Endpoint fallback — jika primary gagal, request dicoba ke endpoint ini |
| `LLM2_FALLBACK_API_KEY` | *(reuse LLM2)* | API key fallback — isi jika endpoint fallback memakai key berbeda |
| `LLM2_FALLBACK_MODEL` | *(kosong)* | Model fallback — **diabaikan** jika sudah ada model di database, karena model selalu diambil dari DB untuk semua target |

:::info
**Cara kerja fallback LLM2:** Saat runtime, model selalu diambil dari database (diatur via `/modelcfg add` dan `/model`). Env var `LLM2_MODEL` dan `LLM2_FALLBACK_MODEL` hanya dipakai sebagai fallback kalau database belum punya model sama sekali. Endpoint dan API key (`LLM2_ENDPOINT`, `LLM2_API_KEY`, `LLM2_FALLBACK_ENDPOINT`, `LLM2_FALLBACK_API_KEY`) tetap penting karena mereka menentukan **provider mana** yang menerima request. Jadi jika primary endpoint timeout/error, sistem otomatis mencoba fallback endpoint dengan model yang sama (dari database).
:::

### Logging Bridge

| Variabel | Default | Deskripsi |
|----------|---------|-----------|
| `BRIDGE_LOG_LEVEL` | `info` | Level log bridge |
| `BRIDGE_LOG_PROMPT_FULL` | `0` | Log prompt LLM2 lengkap |
| `BRIDGE_LOG_EXTRAS_LIMIT` | `4000` | Limit karakter extras di log |
| `BRIDGE_LOG_CHAT_LABEL_WIDTH` | `24` | Lebar label chat di log |
| `BRIDGE_SLOW_BATCH_LOG_MS` | `2000` | Threshold log batch lambat |
