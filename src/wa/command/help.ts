import logger from "../../logger.js";
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

const HELP_TEXT = `*WazzapAgents - Daftar Perintah*

*Umum (Semua Orang)*
• \`/help\` — Tampilkan pesan bantuan ini
• \`/info\` — Informasi profil, peran, dan chat
• \`/dashboard\` — Statistik penggunaan bot
• \`/join\` [link] — Masuk grup via link
• \`/sticker\` — Buat stiker (balas gambar)
• \`/addsticker\` <nama> — Tambahkan sticker ke katalog bot untuk chat ini _(admin grup; bebas di private chat)_
• \`/addsticker global\` <nama> — Tambahkan sticker ke katalog global semua chat _(owner only)_
• \`/owner-contact\` — Kirim kartu kontak owner

*Pengaturan & Moderasi (Admin)*
• \`/setting\` — Menu pengaturan interaktif
• \`/prompt\` [teks] — Atur kepribadian bot
• \`/reset\` — Hapus memori percakapan
• \`/mode\` [auto|prefix|hybrid] — Mode respon
• \`/trigger\` [tag|tagall|reply|name|join] — Atur pemicu respon (_tagall_ = saat tag semua orang)
• \`/idle\` [n|n-m|off] — Auto-trigger LLM2 setelah n pesan tanpa bicara
• \`/group-status\` [text/media] — Kirim group status

_Perintah konfigurasi di atas mendukung argumen \`global\` (semua chat) dan \`default\` (chat yang belum diatur sendiri), khusus owner. Contoh: \`/mode default auto\`._

*Owner*
• \`/bot-conf\` — Konfigurasi bot global (pesan aktivasi, prompt dasar, wajib-aktivasi)

_Ketik perintah tanpa argumen untuk melihat status saat ini._

Kesulitan? silahkan gabung ke group ini untuk bantuan lebih lanjut.
https://chat.whatsapp.com/BkMkMS2pX376ZWrOkXgDoM`;

async function handleHelp({ chatId, sock }: CommandContext): Promise<void> {
  try {
    await sock.sendMessage(chatId, { text: HELP_TEXT });
  } catch (err) {
    logger.warn({ err, chatId }, "failed sending /help response");
  }
}

export { handleHelp };

export const helpCommand: CommandHandler = { name: "help", aliases: ["helps"], run: handleHelp };