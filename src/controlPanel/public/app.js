const state = {
  token: sessionStorage.getItem('wazzap_admin_token') || '',
  page: 'overview',
  overview: null,
  accounts: [],
  accountCatalog: null,
  selectedAccountId: sessionStorage.getItem('wazzap_account_id') || '',
  chatList: [],
  chatModels: [],
  currentChatId: '',
  chatDetail: null,
  pendingScopeName: '',
  models: [],
  activation: null,
  stickers: [],
  envFields: [],
  logs: [],
  pairingResults: new Map(),
  knownScopes: [],
  systemSection: sessionStorage.getItem('wazzap_system_section') || 'runtime',
  updateStatus: null,
  subagentOutbox: { entries: [], count: 0, error: '', loaded: false },
};

const loginShell = document.getElementById('login-shell');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginCopy = document.getElementById('login-copy');
const setupHelp = document.getElementById('setup-help');
const appShell = document.getElementById('app');
const content = document.getElementById('content');
const modalRoot = document.getElementById('modal-root');
const toastRegion = document.getElementById('toast-region');
const sidebar = document.getElementById('sidebar');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function relativeTime(value) {
  if (!value) return 'just now';
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 15_000) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatBytes(value) {
  if (value === null || value === undefined) return 'Unknown size';
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return 'Unknown size';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = size / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

function scopeName(scope, fallbackId = '') {
  if (fallbackId === '__global__' || scope?.chatId === '__global__') return 'Default settings';
  return scope?.displayName || (fallbackId.endsWith('@g.us') ? 'Unnamed group' : fallbackId.split('@')[0]) || 'Unknown scope';
}

function scopeCell(scope, fallbackId = '') {
  const chatId = scope?.chatId || fallbackId;
  const label = chatId === '__global__' ? 'Global' : scopeName(scope, chatId);
  return `<span class="cell-title">${escapeHtml(label)}</span>${chatId && chatId !== '__global__' ? `<span class="cell-subtitle mono">${escapeHtml(chatId)}</span>` : ''}`;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4200);
}

async function copyText(value) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function withPreservedListScroll(selector, task) {
  const scroller = document.querySelector(selector);
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const restore = () => {
    const restored = document.querySelector(selector);
    if (restored) restored.scrollTop = scrollTop;
  };
  let result;
  try {
    result = task();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then((value) => { restore(); return value; }, (error) => { restore(); throw error; });
  }
  restore();
  return result;
}

function statusMarkup(account) {
  if (account.linked) {
    return '<span class="status-label success"><span class="status-dot success"></span>Linked</span>';
  }
  if (account.pairingInProgress) {
    return '<span class="status-label warning"><span class="status-dot warning"></span>Pairing</span>';
  }
  if (account.waStatus === 'connecting') {
    return '<span class="status-label warning"><span class="status-dot warning"></span>Connecting</span>';
  }
  return '<span class="status-label danger"><span class="status-dot danger"></span>Needs pairing</span>';
}

function accountOptions(selectedId = state.selectedAccountId) {
  return state.accounts
    .map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selectedId ? 'selected' : ''}>${escapeHtml(account.name)} · ${escapeHtml(account.folderPath)}</option>`)
    .join('');
}

function ensureSelectedAccount() {
  if (!state.accounts.length) {
    state.selectedAccountId = '';
    return;
  }
  if (!state.accounts.some((account) => account.id === state.selectedAccountId)) {
    state.selectedAccountId = state.accounts[0].id;
  }
  sessionStorage.setItem('wazzap_account_id', state.selectedAccountId);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { error: `Request failed with status ${response.status}.` };
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed with status ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    if (response.status === 401) lockPanel('Your admin token is no longer valid.');
    throw error;
  }
  return payload;
}

function showPanel() {
  loginShell.classList.add('hidden');
  appShell.classList.remove('hidden');
  loginError.textContent = '';
}

function lockPanel(message = '') {
  state.token = '';
  sessionStorage.removeItem('wazzap_admin_token');
  appShell.classList.add('hidden');
  loginShell.classList.remove('hidden');
  setupHelp.classList.add('hidden');
  loginCopy.textContent = 'Enter the admin token configured on this gateway.';
  loginError.textContent = message;
  document.getElementById('admin-token').value = '';
}

function setLoading() {
  content.innerHTML = `
    <div class="page-header"><div><h1>Loading</h1><p>Reading live gateway state…</p></div></div>
    <div class="health-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
  `;
}

function pageHeader(title, subtitle, actions = '') {
  return `<header class="page-header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
}

function accountSelector(id = 'page-account-select') {
  return `<select id="${id}" class="account-select" aria-label="Tenant account">${accountOptions()}</select>`;
}

function bindAccountSelector(id = 'page-account-select', callback = renderPage) {
  const select = document.getElementById(id);
  if (!select) return;
  select.addEventListener('change', async () => {
    state.selectedAccountId = select.value;
    sessionStorage.setItem('wazzap_account_id', select.value);
    state.currentChatId = '';
    state.chatDetail = null;
    state.pendingScopeName = '';
    await callback();
  });
}

function openModal(title, subtitle, body, options = {}) {
  modalRoot.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle || '')}</p></header>
      <div class="modal-body">${body}</div>
      <footer class="modal-footer">
        <button class="button secondary" id="modal-cancel" type="button">Cancel</button>
        <button class="button ${options.danger ? 'danger' : 'primary'}" id="modal-confirm" type="button">${escapeHtml(options.confirmText || 'Save')}</button>
      </footer>
    </div>
  `;
  modalRoot.classList.remove('hidden');
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', async () => {
    const button = document.getElementById('modal-confirm');
    button.disabled = true;
    try {
      await options.onConfirm?.(modalRoot);
      closeModal();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
  setTimeout(() => modalRoot.querySelector('input, select, textarea')?.focus(), 0);
}

function closeModal() {
  modalRoot.classList.add('hidden');
  modalRoot.innerHTML = '';
}

modalRoot.addEventListener('click', (event) => {
  if (event.target === modalRoot) closeModal();
});

function pairFormMarkup(accountId, compact = false) {
  const eligible = state.accounts.filter((account) => !account.linked);
  const selected = eligible.some((account) => account.id === accountId)
    ? accountId
    : eligible[0]?.id || '';
  const result = state.pairingResults.get(selected);
  return `
    <form id="pair-form" class="pair-form">
      ${eligible.length > 1 ? `<label class="field-label" for="pair-account">Account</label><select id="pair-account">${eligible.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(account.name)}</option>`).join('')}</select>` : `<input id="pair-account" type="hidden" value="${escapeHtml(selected)}">`}
      <label class="field-label" for="pair-phone">Phone number with country code</label>
      <input id="pair-phone" inputmode="tel" autocomplete="tel" placeholder="6281234567890" required ${eligible.length ? '' : 'disabled'}>
      <button class="button primary full" type="submit" ${eligible.length ? '' : 'disabled'}>${eligible.length ? 'Generate pairing code' : 'All accounts are linked'}</button>
    </form>
    ${result ? `<div class="pair-code"><strong>${escapeHtml(result.code)}</strong><button id="copy-pair-code" class="button secondary small" type="button">Copy</button></div><p class="field-help">Generated ${relativeTime(result.generatedAtMs)}. Use it immediately; the panel will not request another code on refresh.</p>` : ''}
    ${compact ? '' : `<ol class="pair-help"><li>Open WhatsApp Linked Devices</li><li>Choose Link with phone number</li><li>Enter the code shown above</li></ol>`}
  `;
}

function bindPairForm(onDone = renderPage) {
  const form = document.getElementById('pair-form');
  if (!form) return;
  const accountInput = document.getElementById('pair-account');
  accountInput?.addEventListener('change', () => {
    const result = state.pairingResults.get(accountInput.value);
    const oldCode = document.querySelector('.pair-code');
    if (oldCode && !result) oldCode.remove();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const accountId = accountInput.value;
    const phoneNumber = document.getElementById('pair-phone').value;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Waiting for WhatsApp…';
    try {
      const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/pairing-code`, {
        method: 'POST',
        body: { phoneNumber },
      });
      state.pairingResults.set(accountId, result);
      toast('Pairing code generated.');
      await refreshAccounts();
      await onDone();
    } catch (error) {
      if (error.payload?.retryAfterMs) {
        const retry = new Date(error.payload.retryAfterMs).toLocaleTimeString();
        toast(`${error.message} Retry after ${retry}.`, 'error');
      } else {
        toast(error.message, 'error');
      }
      button.disabled = false;
      button.textContent = 'Generate pairing code';
    }
  });
  document.getElementById('copy-pair-code')?.addEventListener('click', async () => {
    const accountId = accountInput.value;
    const result = state.pairingResults.get(accountId);
    if (!result) return;
    const copied = await copyText(result.code.replace('-', ''));
    toast(copied ? 'Pairing code copied.' : 'Clipboard is unavailable on this connection.', copied ? 'success' : 'error');
  });
}

async function refreshAccounts() {
  const data = await api('/api/accounts');
  state.accounts = data.accounts || [];
  state.accountCatalog = data.catalog || null;
  ensureSelectedAccount();
}

async function loadOverview() {
  state.overview = await api('/api/overview');
  state.accounts = state.overview.accounts || [];
  ensureSelectedAccount();
}

function renderOverview() {
  const data = state.overview;
  const health = data.health;
  const runtime = data.runtime;
  const allHealthy = health.nodeGateway === 'online'
    && health.pythonConnected === health.pythonTotal
    && health.whatsappLinked === health.whatsappTotal;
  document.getElementById('system-summary').innerHTML = `<span class="status-dot ${allHealthy ? 'success' : 'warning'}"></span>${allHealthy ? 'All systems operational' : 'Some services need attention'}`;
  const accountRows = state.accounts.length
    ? state.accounts.map((account) => `
      <tr>
        <td><span class="cell-title">${escapeHtml(account.name)}</span><span class="cell-subtitle mono">${escapeHtml(account.folderPath)}</span></td>
        <td>${statusMarkup(account)}</td>
        <td>${escapeHtml(account.phoneNumber || 'Not linked')}</td>
        <td><span class="status-label ${account.bridgeConnected ? 'success' : 'warning'}"><span class="status-dot ${account.bridgeConnected ? 'success' : 'warning'}"></span>${account.bridgeConnected ? 'Connected' : 'Offline'}</span></td>
        <td><button class="button secondary small manage-account" data-id="${escapeHtml(account.id)}" type="button">Manage</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5"><div class="empty-state">No tenant accounts are registered.</div></td></tr>';
  const activity = data.recentActivity?.length
    ? data.recentActivity.map((entry) => `<li class="activity-row"><span class="status-dot ${entry.outcome === 'failure' ? 'danger' : 'success'}"></span><span>${escapeHtml(entry.detail)}</span><time>${relativeTime(entry.timestamp)}</time></li>`).join('')
    : '<li class="empty-state">No control panel activity yet.</li>';
  content.innerHTML = `
    ${pageHeader('Overview', 'Manage every tenant from one place.')}
    <div class="health-grid">
      <article class="health-card"><div class="health-icon">✓</div><div><p>Node Gateway</p><strong>Online</strong></div></article>
      <article class="health-card ${health.pythonConnected === health.pythonTotal ? '' : 'warning'}"><div class="health-icon">✓</div><div><p>Python Bridge</p><strong>${health.pythonConnected} of ${health.pythonTotal}</strong></div></article>
      <article class="health-card ${health.whatsappLinked === health.whatsappTotal ? '' : 'warning'}"><div class="health-icon">✓</div><div><p>WhatsApp</p><strong>${health.whatsappLinked} of ${health.whatsappTotal} linked</strong></div></article>
      <article class="health-card ${health.queuedEvents ? 'warning' : ''}"><div class="health-icon">${health.queuedEvents ? '!' : '✓'}</div><div><p>Queued Events</p><strong>${health.queuedEvents}</strong></div></article>
    </div>
    <div class="overview-grid">
      <section class="panel">
        <header class="panel-header"><div><h2>Accounts</h2><p>Live tenant and bridge state</p></div><button class="text-button" id="view-accounts" type="button">View all →</button></header>
        <div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Status</th><th>Phone</th><th>Bridge</th><th></th></tr></thead><tbody>${accountRows}</tbody></table></div>
      </section>
      <section class="panel accent pair-card"><h2>Pair a device</h2><p>Link WhatsApp without scanning a QR code.</p>${pairFormMarkup(state.selectedAccountId)}</section>
    </div>
    <div class="lower-grid">
      <section class="panel"><header class="panel-header"><h3>Runtime configuration</h3></header><div class="panel-body"><div class="key-value-list">
        <div class="key-value-row"><span>LLM2 model</span><strong>${escapeHtml(runtime.llm2Model)}</strong></div>
        <div class="key-value-row"><span>Activation required</span><strong class="${runtime.requireActivation ? 'status-label success' : ''}">${runtime.requireActivation ? 'On' : 'Off'}</strong></div>
        <div class="key-value-row"><span>Private chats</span><strong>${runtime.privateChatEnabled ? 'On' : 'Off'}</strong></div>
        <div class="key-value-row"><span>Sub-agent default</span><strong>${runtime.subagentDefault ? 'On' : 'Off'}</strong></div>
      </div></div></section>
      <section class="panel"><header class="panel-header"><h3>Recent activity</h3><button class="text-button" id="view-logs" type="button">View logs →</button></header><div class="panel-body"><ul class="activity-list">${activity}</ul></div></section>
    </div>
  `;
  bindPairForm(async () => {
    await loadOverview();
    renderOverview();
  });
  document.getElementById('view-accounts').addEventListener('click', () => navigate('accounts'));
  document.getElementById('view-logs').addEventListener('click', () => navigate('logs'));
  document.querySelectorAll('.manage-account').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedAccountId = button.dataset.id;
      navigate('accounts');
    });
  });
}

async function renderAccounts() {
  await refreshAccounts();
  const rows = state.accounts.length
    ? state.accounts.map((account) => `
      <tr>
        <td><span class="cell-title">${escapeHtml(account.name)}</span><span class="cell-subtitle mono">${escapeHtml(account.folderPath)}</span></td>
        <td>${statusMarkup(account)}</td>
        <td>${escapeHtml(account.phoneNumber || 'Not linked')}</td>
        <td>${account.bridgeConnected ? '<span class="badge success">Bridge online</span>' : '<span class="badge warning">Bridge offline</span>'}</td>
        <td>${account.queueSize}</td>
        <td><div class="row-actions">
          <button class="button secondary small account-config" data-id="${escapeHtml(account.id)}" type="button">Configure</button>
          <button class="button secondary small account-reconnect" data-id="${escapeHtml(account.id)}" type="button">Reconnect</button>
          ${account.linked ? `<button class="button danger small account-disconnect" data-id="${escapeHtml(account.id)}" type="button">Disconnect</button>` : `<button class="button primary small account-pair" data-id="${escapeHtml(account.id)}" type="button">Pair now</button>`}
          ${state.accounts.length > 1 ? `<button class="button danger small account-remove" data-id="${escapeHtml(account.id)}" type="button">Remove account</button>` : ''}
        </div></td>
      </tr>`).join('')
    : '<tr><td colspan="6"><div class="empty-state">No accounts available.</div></td></tr>';
  content.innerHTML = `
    ${pageHeader('Accounts', 'Manage tenant identity, sockets, and WhatsApp sessions.', '<button id="add-account" class="button primary" type="button">Add account</button>')}
    <section class="panel"><header class="panel-header"><div><h2>Tenant accounts</h2><p>Each account keeps isolated auth, databases, media, and stickers.</p></div></header><div class="table-wrap"><table><thead><tr><th>Account</th><th>WhatsApp</th><th>Phone</th><th>Python</th><th>Queue</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>
  `;
  document.getElementById('add-account').addEventListener('click', showAddAccountModal);
  document.querySelectorAll('.account-pair').forEach((button) => button.addEventListener('click', () => showPairModal(button.dataset.id)));
  document.querySelectorAll('.account-reconnect').forEach((button) => button.addEventListener('click', () => reconnectFromUi(button.dataset.id, button)));
  document.querySelectorAll('.account-disconnect').forEach((button) => button.addEventListener('click', () => showDisconnectModal(button.dataset.id)));
  document.querySelectorAll('.account-config').forEach((button) => button.addEventListener('click', () => showAccountConfig(button.dataset.id)));
  document.querySelectorAll('.account-remove').forEach((button) => button.addEventListener('click', () => showRemoveAccountModal(button.dataset.id)));
}

function accountKeyFromName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function showAddAccountModal() {
  openModal(
    'Add WhatsApp account',
    'A separate tenant folder, databases, session, and bridge runtime will be created.',
    `<div class="form-grid">
      <label class="form-field"><span class="field-label">Account name</span><input id="new-account-name" maxlength="80" placeholder="Customer support" autocomplete="off" required></label>
      <label class="form-field"><span class="field-label">Account ID</span><input id="new-account-key" maxlength="48" placeholder="customer-support" autocomplete="off" required><span class="field-help">Lowercase letters, numbers, _ or -. Stored under tenants/&lt;id&gt;.</span></label>
      <label class="form-field full"><span class="field-label">WhatsApp number</span><input id="new-account-phone" inputmode="tel" autocomplete="tel" placeholder="6281234567890" required><span class="field-help">The pairing code is generated immediately after creation.</span></label>
      <div class="notice full">Removing an account later does not delete its auth, databases, media, or stickers.</div>
    </div>`,
    {
      confirmText: 'Create and pair',
      onConfirm: async (root) => {
        const name = root.querySelector('#new-account-name').value.trim();
        const accountKey = root.querySelector('#new-account-key').value.trim();
        const phoneNumber = root.querySelector('#new-account-phone').value.trim();
        const response = await api('/api/accounts', {
          method: 'POST',
          body: { name, accountKey, phoneNumber },
        });
        const accountId = response.account.id;
        if (response.pairing) state.pairingResults.set(accountId, response.pairing);
        state.selectedAccountId = accountId;
        sessionStorage.setItem('wazzap_account_id', accountId);
        await renderAccounts();
        if (response.restored) {
          toast('Account restored with its existing WhatsApp session.');
        } else if (response.pairingError) {
          toast(`Account created, but pairing needs retry: ${response.pairingError.message}`, 'error');
        } else {
          toast('Account created and pairing code generated.');
        }
        if (!response.restored) setTimeout(() => showPairModal(accountId), 0);
      },
    },
  );
  const nameInput = document.getElementById('new-account-name');
  const keyInput = document.getElementById('new-account-key');
  let keyEdited = false;
  keyInput.addEventListener('input', () => { keyEdited = true; });
  nameInput.addEventListener('input', () => {
    if (!keyEdited) keyInput.value = accountKeyFromName(nameInput.value);
  });
}

function showRemoveAccountModal(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  openModal(
    'Remove account',
    'The runtime stops, but every tenant file is retained on disk.',
    `<div class="notice warning">Remove ${escapeHtml(account?.name || 'this account')} from the managed account catalog?</div><label class="field-label" for="remove-account-confirm">Type REMOVE to continue</label><input id="remove-account-confirm" autocomplete="off">`,
    {
      danger: true,
      confirmText: 'Remove account',
      onConfirm: async (root) => {
        const confirm = root.querySelector('#remove-account-confirm').value;
        await api(`/api/accounts/${encodeURIComponent(accountId)}`, {
          method: 'DELETE',
          body: { confirm },
        });
        state.pairingResults.delete(accountId);
        if (state.selectedAccountId === accountId) state.selectedAccountId = '';
        toast('Account removed. Its tenant data is still on disk.');
        await renderAccounts();
      },
    },
  );
}

function showPairModal(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  openModal(
    'Pair WhatsApp',
    account ? `Generate a native code for ${account.name}.` : 'Generate a native pairing code.',
    `<div class="pair-card">${pairFormMarkup(accountId, false)}</div>`,
    { confirmText: 'Close', onConfirm: async () => undefined },
  );
  bindPairForm(async () => {
    await refreshAccounts();
    closeModal();
    await renderAccounts();
  });
}

async function reconnectFromUi(accountId, button) {
  button.disabled = true;
  try {
    await api(`/api/accounts/${encodeURIComponent(accountId)}/reconnect`, { method: 'POST' });
    toast('Account reconnect started.');
    await renderAccounts();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
}

function showDisconnectModal(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  openModal(
    'Disconnect WhatsApp session',
    'This removes only WhatsApp authentication. Tenant settings and media remain.',
    `<div class="notice warning">${escapeHtml(account?.name || 'This account')} must be paired again after this action.</div><label class="field-label" for="disconnect-confirm">Type DISCONNECT to continue</label><input id="disconnect-confirm" autocomplete="off">`,
    {
      danger: true,
      confirmText: 'Remove session',
      onConfirm: async (root) => {
        const confirm = root.querySelector('#disconnect-confirm').value;
        await api(`/api/accounts/${encodeURIComponent(accountId)}/session`, {
          method: 'DELETE',
          body: { confirm },
        });
        state.pairingResults.delete(accountId);
        toast('WhatsApp session removed.');
        await renderAccounts();
      },
    },
  );
}

async function showAccountConfig(accountId) {
  const data = await api(`/api/accounts/${encodeURIComponent(accountId)}/bot-config`);
  openModal(
    'Tenant configuration',
    'Bot-wide defaults for this account.',
    `<div class="form-grid">
      <label class="form-field"><span class="field-label">Account name</span><input id="config-account-name" value="${escapeHtml(data.accountName || '')}"></label>
      <label class="form-field"><span class="field-label">Bot name</span><input id="config-bot-name" value="${escapeHtml(data.botName || '')}" placeholder="e.g. Vivy"></label>
      <label class="form-field full"><span class="field-label">Bot owner phone(s) / JID(s)</span><input id="config-bot-owner-jids" value="${escapeHtml(data.botOwnerJids || '')}" placeholder="e.g. 628123456789, 628987654321"></label>
      <label class="form-field"><span class="field-label">Owner display name</span><input id="config-owner-name" value="${escapeHtml(data.ownerContact?.displayName || '')}"></label>
      <label class="form-field full"><span class="field-label">Owner phone</span><input id="config-owner-phone" value="${escapeHtml(data.ownerContact?.phoneNumber || '')}"></label>
      <label class="form-field full"><span class="field-label">Activation message</span><textarea id="config-activation-message">${escapeHtml(data.activationMessage || '')}</textarea></label>
      <label class="form-field full"><span class="field-label">Default prompt</span><textarea id="config-default-prompt">${escapeHtml(data.defaultPrompt || '')}</textarea></label>
      <label class="form-field full"><span class="field-label">Join prompt</span><textarea id="config-join-prompt">${escapeHtml(data.joinPrompt || '')}</textarea></label>
      <div class="form-field full"><div class="toggle-row"><div><strong>Require activation</strong><p class="field-help">Gate new chats behind activation codes.</p></div><label class="toggle"><input id="config-require-activation" type="checkbox" ${data.requireActivation ? 'checked' : ''}><span></span></label></div></div>
    </div>`,
    {
      onConfirm: async (root) => {
        const ownerName = root.querySelector('#config-owner-name').value.trim();
        const ownerPhone = root.querySelector('#config-owner-phone').value.trim();
        const body = {
          accountName: root.querySelector('#config-account-name').value.trim() || null,
          botName: root.querySelector('#config-bot-name').value.trim() || null,
          botOwnerJids: root.querySelector('#config-bot-owner-jids').value.trim() || null,
          requireActivation: root.querySelector('#config-require-activation').checked,
          activationMessage: root.querySelector('#config-activation-message').value.trim() || null,
          defaultPrompt: root.querySelector('#config-default-prompt').value.trim() || null,
          joinPrompt: root.querySelector('#config-join-prompt').value.trim() || null,
        };
        if (ownerName || ownerPhone) {
          body.ownerContact = { displayName: ownerName, phoneNumber: ownerPhone };
        }
        await api(`/api/accounts/${encodeURIComponent(accountId)}/bot-config`, {
          method: 'PUT',
          body,
        });
        toast('Tenant configuration saved.');
        await renderAccounts();
      },
    },
  );
}

async function loadChats() {
  await refreshAccounts();
  if (!state.selectedAccountId) return;
  const data = await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/chat-settings`);
  state.chatList = data.chats || [];
  state.chatModels = data.models || [];
  state.knownScopes = data.knownScopes || [];
  if (!state.currentChatId && state.chatList.length) {
    state.currentChatId = state.chatList[0].chatId;
  }
  if (state.currentChatId) {
    state.chatDetail = await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/chat-settings/detail?chatId=${encodeURIComponent(state.currentChatId)}`);
    if (state.pendingScopeName && state.currentChatId !== '__global__') {
      state.chatDetail.scope = {
        ...(state.chatDetail.scope || {}),
        chatId: state.currentChatId,
        displayName: state.pendingScopeName,
      };
    }
  }
}

function renderChatEditor() {
  if (!state.chatDetail?.settings) {
    return '<div class="empty-state">Select a configured chat or enter a chat ID to create one.</div>';
  }
  const detail = state.chatDetail;
  const settings = detail.settings;
  const memories = detail.memories || [];
  const memoryRows = memories.length
    ? memories.map((memory, index) => `<li class="memory-row"><span class="memory-index">${index + 1}</span><span>${escapeHtml(memory.text)}</span><button class="button danger small delete-memory" data-index="${index + 1}" type="button">Delete</button></li>`).join('')
    : '<li class="empty-state">No long-term memories in this scope.</li>';
  return `
    <header class="panel-header"><div><h2>${escapeHtml(scopeName(detail.scope, settings.chatId))}</h2><p>${settings.chatId === '__global__' ? 'Tenant-wide fallback settings' : `<span class="mono">${escapeHtml(settings.chatId)}</span> · ${detail.exists ? 'Explicit settings row' : 'Using tenant defaults until saved'}`}</p></div><span class="badge ${detail.exists ? 'success' : 'warning'}">${detail.source}</span></header>
    <div class="panel-body">
      <form id="chat-settings-form">
        <div class="form-grid">
          ${settings.chatId === '__global__' ? '' : `<label class="form-field full"><span class="field-label">Scope name</span><input id="chat-display-name" maxlength="160" value="${escapeHtml(detail.scope?.stored || state.pendingScopeName ? detail.scope?.displayName || state.pendingScopeName : '')}" placeholder="Group or contact name" required><p class="field-help">Stored locally and reused by the panel; saving does not fetch WhatsApp metadata.</p></label>`}
          <label class="form-field"><span class="field-label">Mode</span><select id="chat-mode"><option value="auto" ${settings.mode === 'auto' ? 'selected' : ''}>Auto</option><option value="prefix" ${settings.mode === 'prefix' ? 'selected' : ''}>Prefix</option><option value="hybrid" ${settings.mode === 'hybrid' ? 'selected' : ''}>Hybrid</option></select><p class="field-help">Auto and hybrid require LLM1.</p></label>
          <label class="form-field"><span class="field-label">Permission level</span><select id="chat-permission">${[0, 1, 2, 3].map((level) => `<option value="${level}" ${settings.permission === level ? 'selected' : ''}>Level ${level}</option>`).join('')}</select></label>
          <label class="form-field"><span class="field-label">LLM2 model</span><select id="chat-model"><option value="">Tenant default</option>${state.chatModels.map((model) => `<option value="${escapeHtml(model.modelId)}" ${settings.llm2Model === model.modelId ? 'selected' : ''}>${escapeHtml(model.displayName)}</option>`).join('')}</select></label>
          <label class="form-field"><span class="field-label">Interactive compatibility</span><select id="chat-compat"><option value="auto" ${settings.compatibilityMode === 'auto' ? 'selected' : ''}>Auto</option><option value="full" ${settings.compatibilityMode === 'full' ? 'selected' : ''}>Full</option><option value="semi" ${settings.compatibilityMode === 'semi' ? 'selected' : ''}>Semi</option><option value="safe" ${settings.compatibilityMode === 'safe' ? 'selected' : ''}>Safe</option></select></label>
          <div class="form-field full"><span class="field-label">Triggers</span><div class="checkbox-grid">${['tag', 'tagall', 'reply', 'join', 'name'].map((trigger) => `<label class="check-pill"><input type="checkbox" name="trigger" value="${trigger}" ${settings.triggers.includes(trigger) ? 'checked' : ''}>${trigger}</label>`).join('')}</div></div>
          <label class="form-field"><span class="field-label">Idle minimum</span><input id="chat-idle-min" type="number" min="1" value="${settings.idleTriggerMin ?? ''}" placeholder="Disabled"></label>
          <label class="form-field"><span class="field-label">Idle maximum</span><input id="chat-idle-max" type="number" min="1" value="${settings.idleTriggerMax ?? ''}" placeholder="Same as minimum"></label>
          <label class="form-field full"><span class="field-label">System prompt override</span><textarea id="chat-prompt" placeholder="Use tenant default">${escapeHtml(settings.prompt || '')}</textarea></label>
          <div class="form-field full">
            <div class="toggle-row"><div><strong>Sub-agent</strong><p class="field-help">Delegate complex tasks to WazzapSubAgents.</p></div><label class="toggle"><input id="chat-subagent" type="checkbox" ${settings.subagentEnabled ? 'checked' : ''} ${detail.capabilities.subagentConfigured ? '' : 'disabled'}><span></span></label></div>
            <div class="toggle-row"><div><strong>Announcements</strong><p class="field-help">Allow this chat to receive announcements.</p></div><label class="toggle"><input id="chat-announcement" type="checkbox" ${settings.announcementEnabled ? 'checked' : ''}><span></span></label></div>
          </div>
        </div>
        <div class="form-footer">${settings.chatId === '__global__' ? '' : '<button id="reset-chat" class="button danger" type="button">Reset to default</button>'}<button class="button primary" type="submit">Save settings</button></div>
      </form>
      <section class="panel spaced-panel"><header class="panel-header"><div><h3>Long-term memory</h3><p>Facts injected into this chat's prompt.</p></div></header><div class="panel-body"><ul class="memory-list">${memoryRows}</ul><form id="memory-form" class="form-grid spaced-form"><label class="form-field full"><span class="field-label">New memory</span><textarea id="memory-text" required></textarea></label><div class="form-footer form-field full"><button class="button primary" type="submit">Add memory</button></div></form></div></section>
    </div>
  `;
}

async function renderChats() {
  await loadChats();
  const list = state.chatList.length
    ? state.chatList.map((chat) => `<button class="select-row ${chat.chatId === state.currentChatId ? 'active' : ''}" data-chat-id="${escapeHtml(chat.chatId)}" type="button"><strong>${escapeHtml(scopeName(chat, chat.chatId))}</strong><small>${chat.chatId === '__global__' ? '' : `${escapeHtml(chat.chatId)} · `}${escapeHtml(chat.mode)} · permission ${chat.permission}</small></button>`).join('')
    : '<div class="empty-state">No chat settings rows yet.</div>';
  content.innerHTML = `
    ${pageHeader('Chats', 'Edit default and per-chat behavior without slash commands.', `${accountSelector()}<button id="new-chat" class="button primary" type="button">Add scope</button>`)}
    <div class="split-layout"><aside class="panel list-panel"><header class="panel-header"><h2>Configured scopes</h2></header><div class="select-list">${list}</div></aside><section class="panel">${renderChatEditor()}</section></div>
  `;
  bindAccountSelector();
  document.getElementById('new-chat').addEventListener('click', showNewChatModal);
  document.querySelectorAll('.select-row[data-chat-id]').forEach((button) => button.addEventListener('click', () => {
    state.currentChatId = button.dataset.chatId;
    state.pendingScopeName = '';
    void withPreservedListScroll('.list-panel', renderChats);
  }));
  bindChatEditor();
}

function showNewChatModal() {
  const configured = new Set(state.chatList.map((chat) => chat.chatId));
  const known = state.knownScopes.filter((scope) => !configured.has(scope.chatId));
  openModal('Add chat scope', 'Choose a locally remembered chat or enter one manually.', `<div class="form-grid"><label class="form-field full"><span class="field-label">Remembered chat</span><select id="known-chat"><option value="">Enter manually</option>${known.map((scope) => `<option value="${escapeHtml(scope.chatId)}" data-name="${escapeHtml(scope.displayName)}">${escapeHtml(scope.displayName)} · ${escapeHtml(scope.chatType)}</option>`).join('')}</select></label><label class="form-field full"><span class="field-label">Scope name</span><input id="new-chat-name" maxlength="160" placeholder="Community team" required></label><label class="form-field full"><span class="field-label">Chat ID</span><input id="new-chat-id" placeholder="120363…@g.us or 628…@s.whatsapp.net" required></label></div>`, {
    confirmText: 'Open editor',
    onConfirm: async (root) => {
      const chatId = root.querySelector('#new-chat-id').value.trim();
      const displayName = root.querySelector('#new-chat-name').value.trim();
      if (!chatId) throw new Error('Chat ID is required.');
      if (!displayName) throw new Error('Scope name is required.');
      state.currentChatId = chatId;
      state.pendingScopeName = displayName;
      state.chatDetail = null;
      await renderChats();
    },
  });
  document.getElementById('known-chat')?.addEventListener('change', (event) => {
    const option = event.target.selectedOptions[0];
    if (!option?.value) return;
    document.getElementById('new-chat-id').value = option.value;
    document.getElementById('new-chat-name').value = option.dataset.name || option.textContent.split(' · ')[0];
  });
}

function bindChatEditor() {
  const form = document.getElementById('chat-settings-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      chatId: state.currentChatId,
      ...(state.currentChatId === '__global__' ? {} : { displayName: document.getElementById('chat-display-name').value.trim() }),
      mode: document.getElementById('chat-mode').value,
      permission: Number(document.getElementById('chat-permission').value),
      llm2Model: document.getElementById('chat-model').value || null,
      compatibilityMode: document.getElementById('chat-compat').value,
      triggers: [...document.querySelectorAll('input[name="trigger"]:checked')].map((input) => input.value),
      idleTriggerMin: document.getElementById('chat-idle-min').value || null,
      idleTriggerMax: document.getElementById('chat-idle-max').value || null,
      prompt: document.getElementById('chat-prompt').value || null,
      subagentEnabled: document.getElementById('chat-subagent').checked,
      announcementEnabled: document.getElementById('chat-announcement').checked,
    };
    try {
      state.chatDetail = await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/chat-settings/detail`, { method: 'PUT', body });
      state.pendingScopeName = '';
      toast('Chat settings saved.');
      await withPreservedListScroll('.list-panel', renderChats);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('reset-chat')?.addEventListener('click', async () => {
    if (!window.confirm(`Reset ${state.currentChatId} to tenant defaults?`)) return;
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/chat-settings/detail`, {
      method: 'DELETE',
      body: { chatId: state.currentChatId },
    });
    toast('Chat settings reset.');
    await withPreservedListScroll('.list-panel', renderChats);
  });
  document.getElementById('memory-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = document.getElementById('memory-text').value.trim();
    if (!text) return;
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/memories`, {
      method: 'POST',
      body: { scope: state.currentChatId, text },
    });
    toast('Memory added.');
    await withPreservedListScroll('.list-panel', renderChats);
  });
  document.querySelectorAll('.delete-memory').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/memories`, {
      method: 'DELETE',
      body: { scope: state.currentChatId, index: Number(button.dataset.index) },
    });
    toast('Memory deleted.');
    await withPreservedListScroll('.list-panel', renderChats);
  }));
}

async function renderModels() {
  await refreshAccounts();
  if (!state.selectedAccountId) return;
  const [data, providerConfig] = await Promise.all([
    api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/models`),
    api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/llm-config`),
  ]);
  state.models = data.models || [];
  const rows = state.models.length
    ? state.models.map((model) => `<tr><td><span class="cell-title">${escapeHtml(model.displayName)}</span><span class="cell-subtitle mono">${escapeHtml(model.modelId)}</span></td><td>${model.isActive ? '<span class="badge success">Active</span>' : '<span class="badge">Disabled</span>'}</td><td>${model.visionSupport ? 'Yes' : 'No'}</td><td>${model.sortOrder}</td><td>${escapeHtml(model.description || '—')}</td><td><div class="row-actions"><button class="icon-button default-model ${model.isDefault ? 'selected' : ''}" data-id="${encodeURIComponent(model.modelId)}" type="button" aria-label="${model.isDefault ? 'Current default model' : `Set ${escapeHtml(model.displayName)} as default`}" title="${model.isDefault ? 'Default model' : 'Set as default'}" ${model.isDefault ? 'disabled' : ''}>${model.isDefault ? '★' : '☆'}</button><button class="button secondary small edit-model" data-id="${encodeURIComponent(model.modelId)}" type="button">Edit</button><button class="button danger small delete-model" data-id="${encodeURIComponent(model.modelId)}" type="button">Delete</button></div></td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty-state">No model catalog entries. LLM2 falls back to environment configuration.</div></td></tr>';
  content.innerHTML = `
    ${pageHeader('Models', 'Manage the per-tenant model catalog and provider settings.', `${accountSelector()}<button id="provider-settings" class="button secondary" type="button">Provider settings</button><button id="add-model" class="button primary" type="button">Add model</button>`)}
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>Model</th><th>Status</th><th>Vision</th><th>Order</th><th>Description</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>
  `;
  bindAccountSelector();
  document.getElementById('provider-settings').addEventListener('click', () => showProviderModal(providerConfig));
  document.getElementById('add-model').addEventListener('click', () => showModelModal());
  document.querySelectorAll('.edit-model').forEach((button) => button.addEventListener('click', () => showModelModal(decodeURIComponent(button.dataset.id))));
  document.querySelectorAll('.default-model').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/models/${button.dataset.id}/default`, { method: 'POST' });
    toast('Default model updated.');
    await renderModels();
  }));
  document.querySelectorAll('.delete-model').forEach((button) => button.addEventListener('click', async () => {
    const id = decodeURIComponent(button.dataset.id);
    if (!window.confirm(`Delete model ${id}? Affected chats will return to the default.`)) return;
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/models/${button.dataset.id}`, { method: 'DELETE' });
    toast('Model deleted.');
    await renderModels();
  }));
}

function providerLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (ch) => ch.toUpperCase())
    .replace(/\bApi\b/, 'API');
}

function providerField(prefix, label, value, secret = false, full = '') {
  const configured = secret && value?.apiKeyConfigured;
  const inputId = `${prefix}-${label}`;
  const clearId = `${inputId}-clear`;
  const current = secret ? '' : (value?.[label] || '');
  const hint = secret && configured ? ` placeholder="Configured: ${escapeHtml(value.apiKeyMasked || 'hidden')}"` : '';
  return `<label class="form-field ${full}"><span class="field-label">${escapeHtml(providerLabel(label))}</span><input id="${inputId}" type="${secret ? 'password' : 'text'}" value="${escapeHtml(current)}"${hint}>${secret && configured ? `<span class="field-help"><label class="clear-key"><input id="${clearId}" type="checkbox"> Clear saved key</label></span>` : ''}</label>`;
}

function providerSection(prefix, title, subtitle, values) {
  const fallback = {
    apiKeyConfigured: values.fallbackApiKeyConfigured,
    apiKeyMasked: values.fallbackApiKeyMasked,
  };
  return `
    <section class="modal-section">
      <header class="modal-section-header"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></header>
      <div class="form-grid">
        ${providerField(prefix, 'endpoint', values, false, 'full')}
        ${providerField(prefix, 'model', values)}
        ${providerField(prefix, 'apiKey', values, true, 'full')}
      </div>
      <div class="provider-subgroup">
        <span class="provider-subgroup-label">Fallback provider</span>
        <div class="form-grid">
          ${providerField(prefix, 'fallbackEndpoint', values, false, 'full')}
          ${providerField(prefix, 'fallbackModel', values)}
          ${providerField(prefix, 'fallbackApiKey', fallback, true, 'full')}
        </div>
      </div>
    </section>`;
}

function showProviderModal(data) {
  const llm1 = data.llm1 || {};
  const llm2 = data.llm2 || {};
  openModal(
    'Provider settings',
    'Credentials are tenant-scoped. API keys are never returned in full.',
    `<div class="modal-sections">
      ${providerSection('llm2', 'LLM2 responder', 'Generates the actual replies and tool calls in chats.', llm2)}
      ${providerSection('llm1', 'LLM1 router', 'Cheap decision router that gates whether group chats get a reply.', llm1)}
    </div>`,
    {
      onConfirm: async (root) => {
        const group = (prefix) => {
          const result = {};
          for (const field of ['endpoint', 'model', 'fallbackEndpoint', 'fallbackModel']) {
            result[field] = root.querySelector(`#${prefix}-${field}`).value.trim() || null;
          }
          for (const field of ['apiKey', 'fallbackApiKey']) {
            const input = root.querySelector(`#${prefix}-${field}`);
            const clear = root.querySelector(`#${prefix}-${field}-clear`);
            if (clear?.checked) result[field] = null;
            else if (input.value.trim()) result[field] = input.value.trim();
          }
          return result;
        };
        await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/llm-config`, {
          method: 'PUT',
          body: { llm1: group('llm1'), llm2: group('llm2') },
        });
        toast('Provider settings saved.');
        await renderModels();
      },
    },
  );
}

function showModelModal(modelId = '') {
  const model = state.models.find((item) => item.modelId === modelId);
  openModal(
    model ? 'Edit model' : 'Add model',
    'This catalog controls model choices shown to chats.',
    `<div class="form-grid">
      <label class="form-field full"><span class="field-label">Model ID</span><input id="model-id" value="${escapeHtml(model?.modelId || '')}" ${model ? 'disabled' : ''} placeholder="provider/model"></label>
      <label class="form-field"><span class="field-label">Display name</span><input id="model-name" value="${escapeHtml(model?.displayName || '')}"></label>
      <label class="form-field"><span class="field-label">Sort order</span><input id="model-order" type="number" min="0" step="1" value="${model?.sortOrder ?? ''}"><p class="field-help">Uses non-negative values; choosing a default never changes this order.</p></label>
      <label class="form-field full"><span class="field-label">Description</span><textarea id="model-description">${escapeHtml(model?.description || '')}</textarea></label>
      <div class="form-field full"><span class="field-label">Capabilities</span><div class="toggle-grid">
        <div class="toggle-row"><div><strong>Active</strong><p class="field-help">Shown in the chat model selector.</p></div><label class="toggle"><input id="model-active" type="checkbox" ${model?.isActive !== false ? 'checked' : ''}><span></span></label></div>
        <div class="toggle-row"><div><strong>Vision support</strong><p class="field-help">Accepts images from chats.</p></div><label class="toggle"><input id="model-vision" type="checkbox" ${model?.visionSupport ? 'checked' : ''}><span></span></label></div>
      </div></div>
    </div>`,
    {
      onConfirm: async (root) => {
        const id = root.querySelector('#model-id').value.trim();
        const body = {
          modelId: id,
          displayName: root.querySelector('#model-name').value.trim(),
          description: root.querySelector('#model-description').value.trim(),
          sortOrder: root.querySelector('#model-order').value === '' ? null : Number(root.querySelector('#model-order').value),
          isActive: root.querySelector('#model-active').checked,
          visionSupport: root.querySelector('#model-vision').checked,
        };
        if (!id || !body.displayName) throw new Error('Model ID and display name are required.');
        if (model) {
          delete body.modelId;
          if (body.sortOrder === null) delete body.sortOrder;
          await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/models/${encodeURIComponent(id)}`, { method: 'PUT', body });
        } else {
          delete body.isActive;
          await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/models`, { method: 'POST', body });
        }
        toast(model ? 'Model updated.' : 'Model added.');
        await renderModels();
      },
    },
  );
}

async function renderActivation() {
  await refreshAccounts();
  if (!state.selectedAccountId) return;
  state.activation = await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/activation`);
  const codes = state.activation.codes || [];
  const activations = state.activation.activations || [];
  const codeRows = codes.length
    ? codes.slice().reverse().map((code) => `<tr><td class="mono">${escapeHtml(code.code)}</td><td>${escapeHtml(code.type)}</td><td>${code.days === 0 ? 'Permanent' : `${code.days} days`}</td><td>${code.used ? `<span class="badge success">Used by ${escapeHtml(code.usedBy || '')}</span>` : '<span class="badge warning">Unused</span>'}</td><td>${formatDate(code.createdAt)}</td><td><button class="button danger small revoke-code" data-id="${code.id}" type="button">Revoke</button></td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty-state">No activation codes generated.</div></td></tr>';
  const activeRows = activations.length
    ? activations.map((item) => `<tr><td>${scopeCell(item.scope, item.chatId)}</td><td class="mono">${escapeHtml(item.code)}</td><td>${formatDate(item.activatedAt)}</td><td>${item.expiresAt ? formatDate(item.expiresAt) : 'Permanent'}</td></tr>`).join('')
    : '<tr><td colspan="4"><div class="empty-state">No active chats.</div></td></tr>';
  content.innerHTML = `
    ${pageHeader('Activation', 'Generate and revoke access codes for private chats and groups.', `${accountSelector()}<span class="badge ${state.activation.required ? 'success' : 'warning'}">Gate ${state.activation.required ? 'enabled' : 'disabled'}</span>`)}
    <div class="overview-grid">
      <section class="panel"><header class="panel-header"><h2>Activation codes</h2></header><div class="table-wrap"><table><thead><tr><th>Code</th><th>Type</th><th>Duration</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${codeRows}</tbody></table></div></section>
      <section class="panel accent"><header class="panel-header"><div><h2>Generate code</h2><p>Codes are shown once here and retained in the list.</p></div></header><div class="panel-body"><form id="activation-form" class="form-grid"><label class="form-field full"><span class="field-label">Allowed chat type</span><select id="activation-type"><option value="all">Any chat</option><option value="private">Private only</option><option value="group">Group only</option></select></label><label class="form-field full"><span class="field-label">Duration in days</span><input id="activation-days" type="number" min="0" max="3650" value="0"><p class="field-help">Use 0 for permanent access.</p></label><div class="form-footer form-field full"><button class="button primary" type="submit">Generate activation code</button></div></form></div></section>
    </div>
    <section class="panel"><header class="panel-header"><h2>Active chats</h2></header><div class="table-wrap"><table><thead><tr><th>Chat ID</th><th>Code</th><th>Activated</th><th>Expires</th></tr></thead><tbody>${activeRows}</tbody></table></div></section>
  `;
  bindAccountSelector();
  document.getElementById('activation-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/activation-codes`, {
      method: 'POST',
      body: {
        type: document.getElementById('activation-type').value,
        days: Number(document.getElementById('activation-days').value),
      },
    });
    await renderActivation();
    const copied = await copyText(response.code.code);
    toast(`Generated ${response.code.code}.${copied ? ' Copied to clipboard.' : ' Clipboard is unavailable on this connection.'}`, copied ? 'success' : 'error');
  });
  document.querySelectorAll('.revoke-code').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Revoke this code? A chat using it will lose activation.')) return;
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/activation-codes/${button.dataset.id}`, { method: 'DELETE' });
    toast('Activation code revoked.');
    await renderActivation();
  }));
}

async function renderStickers() {
  await refreshAccounts();
  if (!state.selectedAccountId) return;
  const [data, scopeData] = await Promise.all([
    api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/stickers`),
    api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/chat-settings`),
  ]);
  state.knownScopes = scopeData.knownScopes || [];
  state.stickers = data.stickers || [];
  const rows = state.stickers.length
    ? state.stickers.map((sticker) => `<tr><td><span class="cell-title">${escapeHtml(sticker.name)}</span></td><td>${scopeCell(sticker.scope, sticker.chatId)}</td><td><span class="badge">${escapeHtml(sticker.kind)}</span></td><td>${escapeHtml(sticker.addedBy || '—')}</td><td>${formatDate(sticker.addedAt)}</td><td><button class="button danger small delete-sticker" data-chat="${escapeHtml(sticker.chatId)}" data-name="${escapeHtml(sticker.name)}" type="button">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="6"><div class="empty-state">No user-managed stickers in this tenant.</div></td></tr>';
  content.innerHTML = `
    ${pageHeader('Stickers', 'Manage shared and per-chat sticker catalogs.', `${accountSelector()}<button id="add-sticker" class="button primary" type="button">Upload sticker</button>`)}
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Scope</th><th>Kind</th><th>Added by</th><th>Added</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>
  `;
  bindAccountSelector();
  document.getElementById('add-sticker').addEventListener('click', showStickerModal);
  document.querySelectorAll('.delete-sticker').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(`Delete sticker ${button.dataset.name}?`)) return;
    await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/stickers`, {
      method: 'DELETE',
      body: { chatId: button.dataset.chat, name: button.dataset.name },
    });
    toast('Sticker deleted.');
    await renderStickers();
  }));
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed reading file.'));
    reader.readAsDataURL(file);
  });
}

function showStickerModal() {
  const scopeOptions = state.knownScopes.map((scope) => `<option value="${escapeHtml(scope.chatId)}">${escapeHtml(scope.displayName)} · ${escapeHtml(scope.chatType)}</option>`).join('');
  openModal(
    'Upload sticker',
    'Add a WebP file or a premium Lottie JSON payload.',
    `<div class="form-grid">
      <label class="form-field"><span class="field-label">Name</span><input id="sticker-name" placeholder="funny_cat"></label>
      <label class="form-field"><span class="field-label">Scope</span><select id="sticker-chat"><option value="__global__">Global shared catalog</option>${scopeOptions}</select><p class="field-help">Names come from the local chat directory; no live metadata fetch is performed.</p></label>
      <label class="form-field full"><span class="field-label">Kind</span><select id="sticker-kind"><option value="webp">WebP sticker</option><option value="lottie">Lottie JSON</option></select></label>
      <label id="sticker-file-field" class="form-field full"><span class="field-label">WebP file</span><input id="sticker-file" type="file" accept="image/webp,.webp"></label>
      <label id="sticker-lottie-field" class="form-field full hidden"><span class="field-label">Lottie payload</span><textarea id="sticker-lottie" placeholder="{ ... }"></textarea></label>
    </div>`,
    {
      confirmText: 'Save sticker',
      onConfirm: async (root) => {
        const kind = root.querySelector('#sticker-kind').value;
        const body = {
          name: root.querySelector('#sticker-name').value.trim(),
          chatId: root.querySelector('#sticker-chat').value.trim() || '__global__',
          kind,
        };
        if (kind === 'webp') {
          const file = root.querySelector('#sticker-file').files[0];
          if (!file) throw new Error('Choose a WebP file.');
          body.dataBase64 = await fileAsDataUrl(file);
        } else {
          body.lottiePayload = root.querySelector('#sticker-lottie').value.trim();
        }
        await api(`/api/accounts/${encodeURIComponent(state.selectedAccountId)}/stickers`, { method: 'POST', body });
        toast('Sticker saved.');
        await renderStickers();
      },
    },
  );
  document.getElementById('sticker-kind').addEventListener('change', (event) => {
    document.getElementById('sticker-file-field').classList.toggle('hidden', event.target.value !== 'webp');
    document.getElementById('sticker-lottie-field').classList.toggle('hidden', event.target.value !== 'lottie');
  });
}

function systemSections() {
  const categories = [...new Set(state.envFields.map((field) => field.category))];
  return [
    { id: 'runtime', label: 'Runtime & updates', detail: 'Version, restart, and safe update' },
    { id: 'network', label: 'Control panel network', detail: 'Host and port binding' },
    { id: 'subagent-outbox', label: 'Sub-agent outbox', detail: 'Pending and terminal callbacks' },
    ...categories.map((category) => ({
      id: `env:${category}`,
      label: category,
      detail: `${state.envFields.filter((field) => field.category === category).length} environment settings`,
    })),
  ];
}

function renderSubagentOutboxSection() {
  const snapshot = state.subagentOutbox;
  const notice = snapshot.error
    ? `<div class="notice warning"><strong>Outbox unavailable.</strong> ${escapeHtml(snapshot.error)}</div>`
    : '<div class="notice">Completed results remain stored while a callback is pending or in dead letter. Discard stops delivery attempts without immediately deleting the result or its output files; normal idle cleanup still applies.</div>';
  const rows = snapshot.entries.length
    ? snapshot.entries.map((entry) => {
      const stateLabel = entry.state === 'dead_letter' ? 'Dead letter' : 'Pending';
      const stateClass = entry.state === 'dead_letter' ? 'danger' : 'warning';
      const files = (entry.output_files || []).length
        ? entry.output_files.map((file) => `${escapeHtml(file.name)} <span class="cell-subtitle">${escapeHtml(formatBytes(file.size_bytes))}</span>`).join('<br>')
        : '<span class="cell-subtitle">No declared output files</span>';
      const status = entry.callback_status ? `HTTP ${entry.callback_status}` : 'No HTTP status';
      const updated = entry.updated_at
        ? formatDate(Number(entry.updated_at) * 1000)
        : 'Unknown';
      return `<tr>
        <td><span class="cell-title mono">${escapeHtml(entry.session_id)}</span><span class="cell-subtitle">Sequence ${escapeHtml(entry.callback_sequence || 0)} · ${escapeHtml(updated)}</span></td>
        <td><span class="badge ${stateClass}">${stateLabel}</span><span class="cell-subtitle">${escapeHtml(status)}</span></td>
        <td>${files}</td>
        <td><span class="cell-subtitle outbox-error">${escapeHtml(entry.callback_error || 'Waiting for the next delivery attempt.')}</span></td>
        <td><div class="row-actions"><button class="button secondary small retry-callback" data-session="${escapeHtml(entry.session_id)}" type="button">Retry</button><button class="button danger small discard-callback" data-session="${escapeHtml(entry.session_id)}" type="button">Discard</button></div></td>
      </tr>`;
    }).join('')
    : `<tr><td colspan="5"><div class="empty-state">${snapshot.loaded && !snapshot.error ? 'No pending or dead-letter callbacks.' : 'Loading sub-agent outbox…'}</div></td></tr>`;
  return `
    ${notice}
    <section class="panel spaced-panel">
      <header class="panel-header"><div><h2>Sub-agent callback outbox</h2><p>Inspect durable completion delivery without exposing server paths or file contents.</p></div><div class="row-actions"><span class="badge">${escapeHtml(snapshot.count || 0)} retained</span><button id="refresh-subagent-outbox" class="button secondary small" type="button">Refresh</button></div></header>
      <div class="table-wrap"><table><thead><tr><th>Session</th><th>Delivery</th><th>Outputs</th><th>Last error</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
}

function renderRuntimeSystemSection() {
  const status = state.updateStatus;
  if (!status) return '<section class="panel"><div class="empty-state">Update status is unavailable.</div></section>';
  const current = status.current || {};
  const available = status.available;
  const compatibilityNotice = status.compatibilityChanged
    ? `<div class="notice warning"><strong>Compatibility change detected.</strong> This update changes compatibility v${escapeHtml(current.compatibilityVersion)} → v${escapeHtml(available?.compatibilityVersion || 'unknown')}. Configuration, dependencies, or deployment steps may need attention. The panel will ask for explicit confirmation.</div>`
    : '';
  const updateBadge = status.updateAvailable
    ? `<span class="badge ${status.compatibilityChanged ? 'warning' : 'success'}">${status.behind} commit${status.behind === 1 ? '' : 's'} available</span>`
    : '<span class="badge success">Up to date</span>';
  return `
    <section class="panel spaced-panel">
      <header class="panel-header"><div><h2>Runtime & updates</h2><p>Updates use the configured upstream branch and only allow fast-forward changes.</p></div>${updateBadge}</header>
      <div class="panel-body">
        <div class="runtime-version-grid">
          <div class="version-card"><span>Installed version</span><strong>v${escapeHtml(current.version || 'unknown')}</strong><small class="mono">${escapeHtml(current.commit || 'no commit')}</small></div>
          <div class="version-card"><span>Compatibility</span><strong>v${escapeHtml(current.compatibilityVersion || 'unknown')}</strong><small>Incremented when manual migration may be required</small></div>
          <div class="version-card"><span>Available version</span><strong>${available ? `v${escapeHtml(available.version)}` : 'Unavailable'}</strong><small class="mono">${escapeHtml(available?.commit || status.upstream || 'no upstream')}</small></div>
        </div>
        <div class="notice ${status.canUpdate || !status.updateAvailable ? '' : 'warning'}">${escapeHtml(status.message)}</div>
        ${compatibilityNotice}
        <div class="system-actions">
          <button id="check-update" class="button secondary" type="button">Check for updates</button>
          <button id="run-update" class="button primary" type="button" ${status.canUpdate ? '' : 'disabled'}>Update & restart</button>
          <button id="restart-system" class="button danger" type="button">Restart services</button>
        </div>
        <p class="field-help">Restart works with the bundled start.sh supervisor. Without a supervisor, the process stops and must be started externally.</p>
      </div>
    </section>`;
}

function renderNetworkSystemSection() {
  const hostField = state.envFields.find((field) => field.key === 'CONTROL_PANEL_HOST');
  const portField = state.envFields.find((field) => field.key === 'CONTROL_PANEL_PORT');
  const panelHost = hostField?.value || hostField?.defaultValue || '127.0.0.1';
  const panelPort = portField?.value || portField?.defaultValue || '8080';
  const hostPreset = ['127.0.0.1', '0.0.0.0'].includes(panelHost) ? panelHost : 'custom';
  return `
    <section class="panel spaced-panel">
      <header class="panel-header"><div><h2>Control panel network</h2><p>Choose where the admin server listens after the next restart.</p></div><span class="badge warning">Restart</span></header>
      <div class="panel-body"><div class="form-grid">
        <label class="form-field"><span class="field-label">Access scope</span><select id="panel-host-preset"><option value="127.0.0.1" ${hostPreset === '127.0.0.1' ? 'selected' : ''}>This machine only</option><option value="0.0.0.0" ${hostPreset === '0.0.0.0' ? 'selected' : ''}>All IPv4 interfaces (Tailscale/LAN)</option><option value="custom" ${hostPreset === 'custom' ? 'selected' : ''}>Specific IP or hostname</option></select></label>
        <label class="form-field"><span class="field-label">Host</span><input id="panel-host-custom" value="${escapeHtml(panelHost)}" placeholder="100.x.y.z or hostname"></label>
        <label class="form-field"><span class="field-label">Port</span><input id="panel-port" type="number" min="1" max="65535" value="${escapeHtml(panelPort)}"></label>
        <div class="form-field full"><p class="field-help">Use 0.0.0.0 to retain localhost access and expose the panel through Tailscale/LAN. A specific Tailscale IP binds only that interface.</p><button id="save-panel-network" class="button primary" type="button">Save network settings</button></div>
      </div></div>
    </section>`;
}

function renderEnvironmentSystemSection(category) {
  return `
    <div class="notice warning">Restart-marked values are persisted immediately and take effect after a service restart. Secret values are never returned to the browser.</div>
    <section class="panel"><header class="panel-header"><div><h2>${escapeHtml(category)}</h2><p>Only this configuration section is shown.</p></div></header><div class="panel-body"><div class="env-toolbar"><input id="env-search" type="search" placeholder="Search ${escapeHtml(category)} settings"><button id="save-env" class="button primary" type="button">Save section</button></div><div id="env-list" class="env-list"></div></div></section>`;
}

function renderSystemShell() {
  const sections = systemSections();
  if (!sections.some((section) => section.id === state.systemSection)) {
    state.systemSection = 'runtime';
  }
  const selected = sections.find((section) => section.id === state.systemSection) || sections[0];
  const body = selected.id === 'runtime'
    ? renderRuntimeSystemSection()
    : selected.id === 'network'
      ? renderNetworkSystemSection()
      : selected.id === 'subagent-outbox'
        ? renderSubagentOutboxSection()
      : renderEnvironmentSystemSection(selected.id.slice(4));
  content.innerHTML = `
    ${pageHeader('System', 'Settings are split into focused sections so unrelated controls stay out of the way.')}
    <div class="system-layout">
      <aside class="panel system-section-nav" aria-label="System sections">${sections.map((section) => `<button class="system-section-button ${section.id === selected.id ? 'active' : ''}" data-system-section="${escapeHtml(section.id)}" type="button"><strong>${escapeHtml(section.label)}</strong><small>${escapeHtml(section.detail)}</small></button>`).join('')}</aside>
      <div class="system-section-content">${body}</div>
    </div>`;

  document.querySelectorAll('[data-system-section]').forEach((button) => button.addEventListener('click', () => {
    state.systemSection = button.dataset.systemSection;
    sessionStorage.setItem('wazzap_system_section', state.systemSection);
    void withPreservedListScroll('.system-section-nav', async () => {
      if (state.systemSection === 'subagent-outbox') {
        await refreshSubagentOutbox();
      } else {
        renderSystemShell();
      }
    });
  }));

  if (selected.id === 'runtime') {
    document.getElementById('check-update')?.addEventListener('click', async () => {
      const button = document.getElementById('check-update');
      button.disabled = true;
      button.textContent = 'Checking…';
      try {
        state.updateStatus = await api('/api/system/update-status?refresh=1');
        renderSystemShell();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
        button.textContent = 'Check for updates';
      }
    });
    document.getElementById('restart-system')?.addEventListener('click', showRestartModal);
    document.getElementById('run-update')?.addEventListener('click', showUpdateModal);
  } else if (selected.id === 'network') {
    const hostPresetInput = document.getElementById('panel-host-preset');
    const customHostInput = document.getElementById('panel-host-custom');
    const syncHostPreset = () => {
      if (hostPresetInput.value !== 'custom') customHostInput.value = hostPresetInput.value;
      customHostInput.disabled = hostPresetInput.value !== 'custom';
    };
    hostPresetInput.addEventListener('change', syncHostPreset);
    syncHostPreset();
    document.getElementById('save-panel-network').addEventListener('click', () => {
      void saveControlPanelNetwork().catch((error) => toast(error.message, 'error'));
    });
  } else if (selected.id === 'subagent-outbox') {
    document.getElementById('refresh-subagent-outbox')?.addEventListener('click', () => {
      void refreshSubagentOutbox();
    });
    document.querySelectorAll('.retry-callback').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/system/subagent-outbox/${encodeURIComponent(button.dataset.session)}/retry`, {
            method: 'POST',
            body: {},
          });
          toast('Callback queued for an immediate retry.');
          await refreshSubagentOutbox();
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false;
        }
      });
    });
    document.querySelectorAll('.discard-callback').forEach((button) => {
      button.addEventListener('click', () => {
        const sessionId = button.dataset.session;
        openModal(
          'Discard callback',
          'This permanently stops automatic callback delivery for this completion.',
          `<div class="notice warning">The completion result and output files remain available until normal idle cleanup, but its callback envelope is removed. Session: <span class="mono">${escapeHtml(sessionId)}</span></div>`,
          {
            danger: true,
            confirmText: 'Discard callback',
            onConfirm: async () => {
              await api(`/api/system/subagent-outbox/${encodeURIComponent(sessionId)}/discard`, {
                method: 'POST',
                body: {},
              });
              toast('Callback discarded; automatic retries are stopped.');
              await refreshSubagentOutbox();
            },
          },
        );
      });
    });
  } else {
    const category = selected.id.slice(4);
    renderEnvRows(category);
    document.getElementById('env-search').addEventListener('input', () => renderEnvRows(category));
    document.getElementById('save-env').addEventListener('click', saveEnvironment);
  }
}

async function refreshSubagentOutbox() {
  state.subagentOutbox = {
    ...state.subagentOutbox,
    error: '',
  };
  if (state.page === 'system' && state.systemSection === 'subagent-outbox') {
    renderSystemShell();
  }
  try {
    const data = await api('/api/system/subagent-outbox');
    state.subagentOutbox = {
      entries: data.entries || [],
      count: data.count || 0,
      error: '',
      loaded: true,
    };
  } catch (error) {
    state.subagentOutbox = {
      entries: [],
      count: 0,
      error: error.message,
      loaded: true,
    };
  }
  if (state.page === 'system' && state.systemSection === 'subagent-outbox') {
    renderSystemShell();
  }
}

async function renderSystem(refreshUpdate = false) {
  const [environment, updateStatus] = await Promise.all([
    api('/api/system/environment'),
    refreshUpdate || !state.updateStatus
      ? api('/api/system/update-status?refresh=1')
      : Promise.resolve(state.updateStatus),
  ]);
  state.envFields = environment.fields || [];
  state.updateStatus = updateStatus;
  renderSystemShell();
  if (state.systemSection === 'subagent-outbox') {
    await refreshSubagentOutbox();
  }
}

function showRestartingState(message) {
  content.innerHTML = `${pageHeader('Restarting', message)}<section class="panel"><div class="panel-body"><div class="skeleton"></div><p class="field-help">This page will reconnect automatically.</p></div></section>`;
  setTimeout(() => window.location.reload(), 6_000);
}

function showRestartModal() {
  openModal('Restart services', 'The Node gateway and Python bridge will briefly disconnect.', '<div class="notice warning">WhatsApp and bridge connections will reconnect after the supervisor starts both services again.</div>', {
    danger: true,
    confirmText: 'Restart now',
    onConfirm: async () => {
      await api('/api/system/restart', { method: 'POST', body: {} });
      showRestartingState('A controlled service restart was requested.');
    },
  });
}

function showUpdateModal() {
  const status = state.updateStatus;
  if (!status?.canUpdate) return;
  const warning = status.compatibilityChanged
    ? `<div class="notice warning"><strong>Compatibility changes from v${escapeHtml(status.current.compatibilityVersion)} to v${escapeHtml(status.available?.compatibilityVersion || 'unknown')}.</strong><br>Review environment, dependency, and deployment requirements. Continue only if you are prepared to adjust them after restart.</div>`
    : '<div class="notice">The repository will be fast-forwarded, then the gateway and bridge will restart.</div>';
  openModal('Apply update', status.message, warning, {
    danger: status.compatibilityChanged,
    confirmText: status.compatibilityChanged ? 'I understand, update' : 'Update & restart',
    onConfirm: async () => {
      const result = await api('/api/system/update', {
        method: 'POST',
        body: { confirmCompatibilityChange: status.compatibilityChanged },
      });
      state.updateStatus = result.status || state.updateStatus;
      if (result.updated) {
        showRestartingState('The update was applied and services are restarting.');
      } else {
        toast(result.status?.message || 'Already up to date.');
        renderSystemShell();
      }
    },
  });
}

async function saveControlPanelNetwork() {
  const preset = document.getElementById('panel-host-preset').value;
  const host = (preset === 'custom'
    ? document.getElementById('panel-host-custom').value
    : preset).trim();
  const port = document.getElementById('panel-port').value.trim();
  if (!host) throw new Error('Host is required.');
  const data = await api('/api/system/environment', {
    method: 'PUT',
    body: { values: { CONTROL_PANEL_HOST: host, CONTROL_PANEL_PORT: port } },
  });
  state.envFields = data.fields || [];
  toast('Network settings saved. Use Restart services to apply the new address.');
  renderSystemShell();
}

function renderEnvRows(category) {
  const search = document.getElementById('env-search')?.value.toLowerCase() || '';
  const filtered = state.envFields.filter((field) => {
    return field.category === category
      && (!search || field.key.toLowerCase().includes(search) || field.description.toLowerCase().includes(search));
  });
  document.getElementById('env-list').innerHTML = filtered.length
    ? filtered.map((field) => `<label class="env-row"><div><div class="env-key"><code>${escapeHtml(field.key)}</code>${field.restartRequired ? '<span class="badge warning">Restart</span>' : '<span class="badge success">Hot reload</span>'}</div><p>${escapeHtml(field.description || 'No description available.')}</p></div><div class="${field.secret ? 'secret-input-wrap' : ''}"><input class="env-input" data-key="${escapeHtml(field.key)}" data-secret="${field.secret}" data-original="${escapeHtml(field.value)}" type="${field.secret ? 'password' : 'text'}" value="${escapeHtml(field.value)}" placeholder="${field.secret && field.configured ? 'Configured — leave blank to keep' : escapeHtml(field.defaultValue || 'Empty')}">${field.secret && field.configured ? '<span class="badge success">Configured</span>' : ''}</div></label>`).join('')
    : '<div class="empty-state">No settings in this section match the search.</div>';
}

async function saveEnvironment() {
  const values = {};
  document.querySelectorAll('.env-input').forEach((input) => {
    const secret = input.dataset.secret === 'true';
    if (secret) {
      if (input.value) values[input.dataset.key] = input.value;
    } else if (input.value !== input.dataset.original) {
      values[input.dataset.key] = input.value;
    }
  });
  if (!Object.keys(values).length) {
    toast('No environment changes to save.');
    return;
  }
  const oldToken = state.token;
  const data = await api('/api/system/environment', { method: 'PUT', body: { values } });
  if (values.CONTROL_PANEL_TOKEN) {
    state.token = values.CONTROL_PANEL_TOKEN;
    sessionStorage.setItem('wazzap_admin_token', state.token);
  }
  state.envFields = data.fields || [];
  const restart = data.restartRequiredKeys || [];
  toast(restart.length ? `Saved. Restart required for: ${restart.join(', ')}` : 'Environment section saved.');
  try {
    await new Promise((resolve) => setTimeout(resolve, values.CONTROL_PANEL_TOKEN ? 500 : 50));
    renderSystemShell();
  } catch (error) {
    if (!values.CONTROL_PANEL_TOKEN) state.token = oldToken;
    toast(error.message, 'error');
  }
}

async function renderLogs() {
  const data = await api('/api/logs?limit=200');
  state.logs = data.entries || [];
  const rows = state.logs.length
    ? state.logs.map((entry) => `<li class="log-row"><time>${formatDate(entry.timestamp)}</time><span class="log-action">${escapeHtml(entry.action)}</span><span>${escapeHtml(entry.detail)}</span><span class="badge ${entry.outcome === 'failure' ? 'danger' : entry.outcome === 'success' ? 'success' : ''}">${escapeHtml(entry.outcome)}</span></li>`).join('')
    : '<li class="empty-state">No control panel audit events yet.</li>';
  content.innerHTML = `${pageHeader('Logs', 'Persistent audit trail for control panel changes.')}<section class="panel"><div class="panel-body"><ul class="log-list">${rows}</ul></div></section>`;
}

async function renderPage() {
  setLoading();
  try {
    if (state.page === 'overview') {
      await loadOverview();
      renderOverview();
    } else if (state.page === 'accounts') {
      await renderAccounts();
    } else if (state.page === 'chats') {
      await renderChats();
    } else if (state.page === 'models') {
      await renderModels();
    } else if (state.page === 'activation') {
      await renderActivation();
    } else if (state.page === 'stickers') {
      await renderStickers();
    } else if (state.page === 'system') {
      await renderSystem();
    } else if (state.page === 'logs') {
      await renderLogs();
    }
  } catch (error) {
    content.innerHTML = `${pageHeader('Unable to load', error.message)}<div class="notice warning">Check the gateway logs and try refreshing this section.</div>`;
    toast(error.message, 'error');
  }
}

async function navigate(page) {
  state.page = page;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  sidebar.classList.remove('open');
  await renderPage();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = document.getElementById('admin-token').value;
  state.token = token;
  loginError.textContent = '';
  try {
    await api('/api/overview');
    sessionStorage.setItem('wazzap_admin_token', token);
    showPanel();
    await navigate('overview');
  } catch (error) {
    state.token = '';
    loginError.textContent = error.message;
  }
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => navigate(item.dataset.page));
});
document.getElementById('refresh-button').addEventListener('click', renderPage);
document.getElementById('logout-button').addEventListener('click', () => lockPanel());
document.getElementById('menu-button').addEventListener('click', () => sidebar.classList.toggle('open'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    sidebar.classList.remove('open');
  }
});

async function bootstrap() {
  try {
    const status = await fetch('/api/auth/status').then((response) => response.json());
    if (!status.configured) {
      setupHelp.classList.remove('hidden');
      loginCopy.textContent = 'The panel is installed, but its API is locked until an admin token is configured.';
      return;
    }
    if (!state.token) return;
    await api('/api/overview');
    showPanel();
    await navigate('overview');
  } catch (error) {
    loginError.textContent = error.message;
  }
}

bootstrap();
