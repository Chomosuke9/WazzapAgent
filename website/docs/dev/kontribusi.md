---
sidebar_position: 6
---

# Panduan Kontribusi

Panduan untuk berkontribusi ke project WazzapAgents.

## Alur Kerja

1. Fork repository.
2. Buat branch baru dari `main`.
3. Lakukan perubahan.
4. Jalankan tests.
5. Buat Pull Request.

## Konvensi Kode

### JavaScript (Node.js Gateway)

- ESM modules (`import`/`export`, bukan `require`).
- 2-space indentation, single quotes, tanpa trailing commas.
- Async/await untuk semua operasi asynchronous.
- Gunakan `logger` dari `src/logger.js` untuk logging.
- Tidak ada formatter/linter — ikuti style yang ada dan jaga diff minimal.

### Python (Bridge)

- Python 3.10+ dengan `from __future__ import annotations` di setiap file.
- Type hints digunakan konsisten.
- Dataclass untuk struktur data.
- Relative imports dalam package `python/bridge/`.

### Umum

- Path dalam payload tetap workspace-relative (`data/media/...`).
- Gunakan `senderRef` untuk referensi user, **jangan pernah** raw JID di kode yang menghadap LLM.
- `contextMsgId` adalah counter 6 digit per chat.

## Pesan Commit

- Gunakan imperative mood, prefix pendek:
  - `add` — fitur baru
  - `fix` — perbaikan bug
  - `refactor` — refactoring tanpa perubahan behavior
  - `docs` — perubahan dokumentasi
  - `test` — menambah atau mengubah tests
- Jika mengubah WebSocket protocol, prefix dengan `protocol:`.

Contoh:
```
add support for voice message transcription
fix senderRef collision on large groups
protocol: add bulk_delete command type
docs: update WebSocket protocol reference
```

## Pull Request

PR harus menyertakan:

1. **Ringkasan** — Apa yang diubah dan mengapa.
2. **Testing** — Bagaimana perubahan diuji.
3. **Protocol changes** — Jika ada perubahan WebSocket protocol, dokumentasikan schema changes.

## Tests

### Menjalankan Tests

```bash
# Semua tests Python
python -m pytest python/tests/

# Test spesifik
python -m unittest python/tests/test_llm_context_serialization.py
```

### Menulis Tests

- Tests Python ada di `python/tests/`.
- Gunakan `pytest` atau `unittest`.
- Untuk gateway, gunakan `vitest` jika menambahkan tests baru.

## Keamanan

### Jangan Pernah Commit

- `data/auth/` — Session WhatsApp
- `.env` — Environment variables dengan secrets
- API keys dalam bentuk apapun

### Aturan Keamanan

- `LLM_WS_TOKEN`, API keys LLM, dan auth Baileys adalah **secrets**.
- Patuhi size limit media untuk menghindari OOM.
- Aksi moderasi (`DELETE`/`KICK`) harus melalui gating permission level (diatur via `/permission`).
- JID asli tidak boleh terekspos ke LLM.

## Dokumentasi

Website dokumentasi menggunakan Docusaurus dan di-deploy otomatis via GitHub Actions.

### Development Lokal

```bash
cd website
npm ci
npm start
```

### Bahasa

- **Bahasa Indonesia** adalah bahasa utama (source) — edit di `website/docs/`.
- **English** adalah terjemahan — edit di `website/i18n/en/docusaurus-plugin-content-docs/current/`.
- Pastikan kedua bahasa tetap sinkron saat menambah atau mengubah halaman.

### Menambah Halaman Baru

1. Buat file `.md` di `website/docs/` (Indonesian).
2. Buat file terjemahan di `website/i18n/en/docusaurus-plugin-content-docs/current/`.
3. Tambahkan entry di `website/sidebars.ts`.
4. Tambahkan terjemahan label di `website/i18n/en/docusaurus-plugin-content-docs/current/sidebars.json`.

## CI/CD

- GitHub Actions workflow di `.github/workflows/deploy-docs.yml` deploy website ke GitHub Pages saat push ke `main`/`master` yang mengubah `website/`.
- Belum ada CI untuk tests atau linting.
