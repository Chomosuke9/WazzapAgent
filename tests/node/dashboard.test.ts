import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { handleDashboard } from '../../src/wa/commands/dashboard.js';

type TopUser = { senderRef: string; senderName: string; invokeCount: number };

function makeCtx(captured: any, topUsers: TopUser[], opts: { failRelay?: boolean } = {}) {
  const sock: any = {
    user: { id: '123:1@s.whatsapp.net', name: 'TestBot' },
    sendMessage: async (_jid: string, content: any) => {
      captured.textMessages.push(content);
      return { key: { id: 'm1' } };
    },
    relayMessage: async (_jid: string, message: any) => {
      if (opts.failRelay) throw new Error('relay boom');
      captured.relayed.push(message);
    },
  };
  const repos: any = {
    stats: {
      getStats: (_chatId: string, period: string) => {
        if (period === 'monthly') {
          return {
            messages_processed: 200,
            responses_sent: 50,
            llm1_calls: 30,
            llm2_calls: 20,
            subagent_tasks_completed: 5,
          };
        }
        if (period === 'weekly') return { messages_processed: 60, responses_sent: 12 };
        return { messages_processed: 10, responses_sent: 3 }; // daily
      },
      getTopUsers: () => topUsers,
      getTotalUserInvokes: () =>
        topUsers.reduce((s, u) => s + (Number(u.invokeCount) || 0), 0),
    },
  };
  return {
    chatId: '12345@g.us',
    chatType: 'group',
    senderId: 'owner@s.whatsapp.net',
    senderIsAdmin: true,
    senderIsOwner: true,
    botIsAdmin: true,
    args: '',
    text: '',
    contextMsgId: null,
    quotedMessageId: null,
    senderDisplay: 'Owner',
    senderRole: null,
    isGroup: true,
    fromMe: false,
    group: { name: 'My Group', description: null, botIsAdmin: true, botIsSuperAdmin: false, participantRoles: {}, participants: [] },
    msg: {} as any,
    folderPath: '/data',
    // Per-account state holder — withJidQueue serializes sends via this map.
    account: { jidQueues: new Map() } as any,
    sock,
    repos,
  } as any;
}

test('/dashboard sends the STATISTIC/period poll then the Top Monthly Users poll (Overall first)', async () => {
  const captured = { textMessages: [] as any[], relayed: [] as any[] };
  const topUsers: TopUser[] = [
    { senderRef: 'u1', senderName: 'Alice', invokeCount: 42 },
    { senderRef: 'u2', senderName: 'Bob', invokeCount: 17 },
  ];
  await handleDashboard(makeCtx(captured, topUsers));

  assert.equal(captured.relayed.length, 2, 'two poll snapshots (period + top users)');
  assert.equal(captured.textMessages.length, 0, 'no text fallback');

  // Message 1: STATISTIC counters in title + period comparison bars.
  const stat = captured.relayed[0].pollResultSnapshotMessage;
  assert.match(stat.name, /STATISTIC/);
  assert.match(stat.name, /MAIN AGENT CALL : 20/);
  assert.equal(stat.pollVotes.length, 3);
  assert.equal(stat.pollVotes[0].optionName, '🕘 Today');
  assert.equal(Number(stat.pollVotes[0].optionVoteCount), 10);
  assert.equal(stat.pollVotes[2].optionName, '📆 This Month');
  assert.equal(Number(stat.pollVotes[2].optionVoteCount), 200);

  // Message 2: Overall baseline first, then ranked users.
  const top = captured.relayed[1].pollResultSnapshotMessage;
  assert.match(top.name, /Top Monthly Users/);
  assert.equal(top.pollVotes.length, 3);
  assert.equal(top.pollVotes[0].optionName, 'Overall');
  assert.equal(Number(top.pollVotes[0].optionVoteCount), 59); // sum of all user invokes (42 + 17)
  assert.equal(top.pollVotes[1].optionName, '1. Alice');
  assert.equal(Number(top.pollVotes[1].optionVoteCount), 42);
  assert.equal(top.pollVotes[2].optionName, '2. Bob');
  assert.equal(Number(top.pollVotes[2].optionVoteCount), 17);
});

test('/dashboard renders a valid poll (Overall + the single active user) when only one user is active', async () => {
  const captured = { textMessages: [] as any[], relayed: [] as any[] };
  await handleDashboard(makeCtx(captured, [{ senderRef: 'u1', senderName: 'Agus Kebab', invokeCount: 6 }]));

  assert.equal(captured.relayed.length, 2, 'period poll + leaderboard poll');
  assert.equal(captured.textMessages.length, 0, 'no text fallback — Overall makes it >= 2 options');
  const top = captured.relayed[1].pollResultSnapshotMessage;
  assert.equal(top.pollVotes.length, 2);
  assert.equal(top.pollVotes[0].optionName, 'Overall');
  assert.equal(Number(top.pollVotes[0].optionVoteCount), 6); // sum of all user invokes (single user)
  assert.equal(top.pollVotes[1].optionName, '1. Agus Kebab');
  assert.equal(Number(top.pollVotes[1].optionVoteCount), 6);
});

test('/dashboard caps the leaderboard poll at 11 options (Overall + 10 users)', async () => {
  const captured = { textMessages: [] as any[], relayed: [] as any[] };
  const many: TopUser[] = Array.from({ length: 10 }, (_v, i) => ({
    senderRef: `u${i}`,
    senderName: `User${i}`,
    invokeCount: 10 - i,
  }));
  await handleDashboard(makeCtx(captured, many));

  const top = captured.relayed[1].pollResultSnapshotMessage;
  assert.equal(top.pollVotes.length, 11, '1 Overall + 10 users');
  assert.equal(top.pollVotes[0].optionName, 'Overall');
});

test('/dashboard sanitizes/guards leaderboard data (newlines, dup names, bad counts)', async () => {
  const captured = { textMessages: [] as any[], relayed: [] as any[] };
  const topUsers: TopUser[] = [
    { senderRef: 'u1', senderName: 'Bob\n\nspam', invokeCount: 9 },
    { senderRef: 'u2', senderName: '', invokeCount: undefined as any },
  ];
  await handleDashboard(makeCtx(captured, topUsers));

  const top = captured.relayed[1].pollResultSnapshotMessage;
  assert.equal(top.pollVotes.length, 3); // Overall + 2 users
  assert.equal(top.pollVotes[0].optionName, 'Overall');
  // newlines collapsed to single spaces, ranked prefix preserved
  assert.equal(top.pollVotes[1].optionName, '1. Bob spam');
  assert.equal(Number(top.pollVotes[1].optionVoteCount), 9);
  // empty name falls back to senderRef; undefined count coerced to 0
  assert.equal(top.pollVotes[2].optionName, '2. u2');
  assert.equal(Number(top.pollVotes[2].optionVoteCount), 0);
});

test('/dashboard sends the period poll plus a text note when there are no active users', async () => {
  const captured = { textMessages: [] as any[], relayed: [] as any[] };
  await handleDashboard(makeCtx(captured, []));

  assert.equal(captured.relayed.length, 1, 'only the period poll');
  assert.equal(captured.textMessages.length, 1, 'a top-users note (only Overall — 1 option is invalid)');
  assert.match(captured.textMessages[0].text, /Top Monthly Users/);
  assert.match(captured.textMessages[0].text, /Overall: 0/);
  assert.match(captured.textMessages[0].text, /no active users/);
});

test('/dashboard falls back to the text dashboard when the poll relay fails', async () => {
  const captured = { textMessages: [] as any[], relayed: [] as any[] };
  const topUsers: TopUser[] = [{ senderRef: 'u1', senderName: 'Alice', invokeCount: 5 }];
  await handleDashboard(makeCtx(captured, topUsers, { failRelay: true }));

  assert.equal(captured.relayed.length, 0);
  assert.equal(captured.textMessages.length, 1, 'falls back to the text dashboard');
  assert.match(captured.textMessages[0].text, /Dashboard Stats/);
  assert.match(captured.textMessages[0].text, /Sub-agent tasks completed: 5/);
});
