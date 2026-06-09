import logger from '../../logger.js';
import { getSock } from '../connection.js';
import { getStats, getTopUsers } from '../../db.js';

function getWeekKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay() + 1);
  return d.toISOString().slice(0, 10);
}

async function handleDashboard({ chatId }) {
  const sock = getSock();
  const now = new Date();
  const dailyKey = now.toISOString().slice(0, 10);
  const weekKey = getWeekKey(now);
  const monthKey = now.toISOString().slice(0, 7);

  const daily = getStats(chatId, 'daily', dailyKey);
  const weekly = getStats(chatId, 'weekly', weekKey);
  const monthly = getStats(chatId, 'monthly', monthKey);
  const topUsers = getTopUsers(chatId, 'monthly', monthKey, 5);

  const lines = ['*Dashboard Stats*'];
  lines.push('');
  lines.push(`*Daily (${dailyKey})*`);
  lines.push(`  Messages processed: ${daily.messages_processed || 0}`);
  lines.push(`  Responses sent: ${daily.responses_sent || 0}`);
  lines.push(`  Bot tags: ${daily.bot_tags || 0}`);
  lines.push(`  Stickers sent: ${daily.stickers_sent || 0}`);
  lines.push('');
  lines.push(`*Weekly (${weekKey})*`);
  lines.push(`  Messages processed: ${weekly.messages_processed || 0}`);
  lines.push(`  Responses sent: ${weekly.responses_sent || 0}`);
  lines.push('');
  lines.push(`*Monthly (${monthKey})*`);
  lines.push(`  Messages processed: ${monthly.messages_processed || 0}`);
  lines.push(`  Responses sent: ${monthly.responses_sent || 0}`);
  lines.push(`  LLM1 calls: ${monthly.llm1_calls || 0}`);
  lines.push(`  LLM2 calls: ${monthly.llm2_calls || 0}`);

  if (topUsers.length > 0) {
    lines.push('');
    lines.push('*Top Users (Monthly)*');
    for (const u of topUsers) {
      lines.push(`  ${u.senderName || u.senderRef}: ${u.invokeCount}`);
    }
  }

  try {
    await sock.sendMessage(chatId, { text: lines.join('\n') });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /dashboard response');
  }
}

export { handleDashboard };
