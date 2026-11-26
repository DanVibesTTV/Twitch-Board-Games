// Control panel for the companion app (http://127.0.0.1:8765/panel/).

const H = { 'Content-Type': 'application/json', 'X-BoardGames': '1' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let status = null;
let login = null;   // pending device code { user_code, verification_uri }
let botLogin = null;
let version = null;

// ---- OBS URL options (defaults match main.js; only changed values go into the URL) ----
const DEFAULTS = { game: '', mode: '', after: 'menu', turn: 30, lobby: 45, vote: 15, bots: true, predictions: true, stats: true, prefix: '!', volume: 0.8, mute: false, fps: '60' };
let options = { ...DEFAULTS };
let games = [];   // manifests, for the game and mode lists

function optionInputs() { return [...document.querySelectorAll('[data-opt]')]; }

function readOptions() {
  const o = {};
  for (const el of optionInputs()) {
    const k = el.dataset.opt;
    if (el.type === 'checkbox') o[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') o[k] = el.value === '' ? DEFAULTS[k] : Number(el.value);
    else o[k] = el.value;
  }
  if (!o.prefix.trim()) o.prefix = '!';
  return o;
}

function writeOptions(o) {
  for (const el of optionInputs()) {
    const v = o[el.dataset.opt] ?? DEFAULTS[el.dataset.opt];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
  }
}

function renderModes() {
  const m = games.find((g) => g.id === $('obs-options').querySelector('[data-opt=game]').value);
  const select = document.querySelector('[data-opt=mode]');
  const keep = options.mode;
  select.innerHTML = '<option value="">game\'s default</option>' + (m?.modes ?? []).map((md) => `<option value="${esc(md.id)}">${esc(md.name)}</option>`).join('');
  select.value = (m?.modes ?? []).some((md) => md.id === keep) ? keep : '';
  $('mode-field').hidden = !m?.modes?.length;
}

// Booleans that default to true are written as =0 when switched off; the rest only when they differ.
function obsQuery(o) {
  const q = new URLSearchParams({ bridge: 'node' });
  for (const [k, def] of Object.entries(DEFAULTS)) {
    let v = o[k];
    if (k === 'mode' && !o.game) continue;
    if (v === def || v === undefined || (typeof def === 'number' && Number(v) === def)) continue;
    if (typeof def === 'boolean') v = v ? '1' : '0';
    if (v === '') continue;
    q.set(k, String(v));
  }
  return q.toString().replace(/%21/g, '!');
}

function renderUrl() {
  $('obs-url').value = `${location.origin}/?${obsQuery(options)}`;
  $('preview').href = `${location.origin}/?${obsQuery(options)}&preview=1`;
  $('volume-label').textContent = `${Math.round(options.volume * 100)}%${options.mute ? ' (muted)' : ''}`;
}

let saveTimer;
function onOptionChange(ev) {
  options = readOptions();
  if (ev?.target?.dataset.opt === 'game') { renderModes(); options = readOptions(); }
  renderUrl();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('/api/settings', { obsOptions: options }).then(() => { $('options-msg').textContent = 'Saved'; setTimeout(() => { $('options-msg').textContent = ''; }, 1500); })
      .catch((err) => { $('options-msg').textContent = err.message; });
  }, 400);
}

async function loadGames() {
  try {
    const ids = await (await fetch('/games/index.json')).json();
    games = (await Promise.all(ids.map((id) => fetch(`/games/${id}/manifest.json`).then((r) => r.json()).catch(() => null)))).filter(Boolean);
  } catch { games = []; }
  const select = document.querySelector('[data-opt=game]');
  select.insertAdjacentHTML('beforeend', games.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} lobby</option>`).join(''));
}

async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.startsWith('{') ? JSON.parse(text).error : text || `HTTP ${res.status}`);
  return text ? JSON.parse(text) : {};
}

function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

async function refresh() {
  status = await api('/api/status');
  $('version').textContent = `v${status.version}`;
  if (!refresh.loaded) {
    refresh.loaded = true;
    options = { ...DEFAULTS, ...status.settings.obsOptions };
    writeOptions(options);
    renderModes();
    writeOptions(options);
  }
  renderUrl();
  $('data-dir').value = status.dataDir;
  $('set-autoCheck').checked = status.settings.autoCheck;
  $('set-openPanel').checked = status.settings.openPanel;
  $('set-twitchClientId').value = status.settings.twitchClientId;
  $('set-updateRepo').value = status.settings.updateRepo;
  renderTwitch(status.twitch);
  renderBot(status.twitchBot);
  renderUpdate(status.update);
}

function renderTwitch(st) {
  const el = $('twitch-body');
  const label = {
    connected: `Connected to chat as <b>${esc(st.login)}</b>`,
    connecting: 'Connecting…',
    'logging-in': 'Waiting for you to confirm on Twitch…',
    'logged-out': 'Not logged in',
    error: 'Problem',
  }[st.state] ?? esc(st.state);
  let html = `<div class="state ${esc(st.state)}"><i></i>${label}</div>`;
  if (st.detail && !(st.state === 'logging-in' && login)) html += `<p class="muted">${esc(st.detail)}</p>`;

  if (status?.clientIdSource === 'none') {
    html += `<p class="note">No Twitch client ID is set up yet, so logging in isn't possible. Open <b>Settings</b> below and paste the client ID of a Twitch app
      (register one at <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener">dev.twitch.tv/console</a>, Client Type <b>Public</b>, OAuth Redirect URL <code>http://localhost</code>).</p>`;
  } else if (st.state === 'logging-in' && login) {
    html += `<p>Open <a href="${esc(login.verification_uri)}" target="_blank" rel="noopener">${esc(login.verification_uri.replace(/^https?:\/\//, ''))}</a> and confirm this code:</p>
      <div class="code">${esc(login.user_code)}</div>
      <p class="muted">Log in with the channel you stream on. Game messages are sent to chat from that account.</p>
      <div class="actions"><a class="button twitch" href="${esc(login.verification_uri)}" target="_blank" rel="noopener">Open Twitch</a></div>`;
  } else if (st.state === 'logged-out' || (st.state === 'error' && !st.login)) {
    html += `<p class="muted">Logging in lets the overlay read and write chat and run Twitch predictions (Affiliate/Partner channels).
      The app asks for: read chat, send chat, manage predictions.</p>
      <div class="actions"><button class="twitch" id="login">Log in with Twitch</button></div>`;
  } else if (st.login) {
    html += `<div class="actions"><button id="logout">Log out</button></div>`;
  }
  el.innerHTML = html;
  $('login')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      login = await api('/api/twitch/login', {});
      window.open(login.verification_uri, '_blank', 'noopener');
      renderTwitch({ state: 'logging-in' });
    } catch (err) { toast(err.message); ev.target.disabled = false; }
  });
  $('logout')?.addEventListener('click', async () => {
    if (!confirm('Log out of Twitch? The overlay stops reading chat until you log in again.')) return;
    await api('/api/twitch/logout', {}).catch((err) => toast(err.message));
  });
}

function renderBot(st) {
  const el = $('bot-body');
  if (!status?.twitch?.login || status.clientIdSource === 'none') { el.innerHTML = ''; return; }
  let html = '<h3>Bot account <span class="muted">(optional)</span></h3>';
  if (st.state === 'connected') {
    html += `<div class="state connected"><i></i>Game messages are posted by <b>${esc(st.login)}</b></div>`;
    if (st.detail) html += `<p class="muted">${esc(st.detail)}</p>`;
    html += `<p class="muted">Tip: make <b>${esc(st.login)}</b> a moderator (<code>/mod ${esc(st.login)}</code>) so slow mode, follower-only mode and link filters don't block it. If the bot can't post, messages come from your account instead.</p>
      <div class="actions"><button id="bot-logout">Disconnect bot</button></div>`;
  } else if (st.state === 'logging-in' && botLogin) {
    html += `<p><b>Open this link in a private/incognito window</b> (so you can log in as the bot, not as yourself), log in with the bot account and confirm the code:</p>
      <div class="copy"><input id="bot-link" readonly value="${esc(botLogin.verification_uri)}"><button data-copy="bot-link">Copy link</button></div>
      <div class="code">${esc(botLogin.user_code)}</div>
      <div class="actions"><button id="bot-cancel">Cancel</button></div>`;
  } else {
    html += `<p class="muted">Game messages are posted from your own account (<b>${esc(status.twitch.login)}</b>). Connect a second Twitch account to have them come from your bot instead. The bot only needs permission to send chat messages.</p>`;
    if (st.detail) html += `<p class="note">${esc(st.detail)}</p>`;
    html += '<div class="actions"><button class="twitch" id="bot-login">Connect bot account</button></div>';
  }
  el.innerHTML = html;
  $('bot-login')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      botLogin = await api('/api/twitch/bot/login', {});
      renderBot({ state: 'logging-in' });
    } catch (err) { toast(err.message); ev.target.disabled = false; }
  });
  $('bot-cancel')?.addEventListener('click', () => { botLogin = null; api('/api/twitch/bot/logout', {}).catch(() => {}); });
  $('bot-logout')?.addEventListener('click', async () => {
    if (!confirm('Disconnect the bot account? Game messages will come from your own account again.')) return;
    await api('/api/twitch/bot/logout', {}).catch((err) => toast(err.message));
  });
}

function renderUpdate(u) {
  const el = $('update-body');
  let html = `<p>Installed: <b>v${esc(u.current)}</b>${u.latest ? ` · latest: <b>v${esc(u.latest.version)}</b>` : ''}${u.available ? '<span class="badge-new">update available</span>' : ''}</p>`;
  if (u.error) html += `<p class="muted">${esc(u.error)}</p>`;
  else if (u.latest && !u.available) html += '<p class="muted">You have the newest version.</p>';
  if (u.available && u.latest.notes) html += `<p><b>What's new</b> (<a href="${esc(u.latest.url)}" target="_blank" rel="noopener">release page</a>)</p><div class="notes">${esc(u.latest.notes)}</div>`;
  if (u.gitClone) html += '<p class="note">This folder is a git clone, so the app won\'t overwrite it. Update with <code>git pull</code>.</p>';
  html += `<div class="actions">
    <button id="check">${u.installing ? 'Installing…' : 'Check now'}</button>
    ${u.available && !u.gitClone ? `<button class="primary" id="install" ${u.installing ? 'disabled' : ''}>Install v${esc(u.latest.version)}</button>` : ''}
    ${u.lastCheck ? `<span class="muted">checked ${new Date(u.lastCheck).toLocaleTimeString()}</span>` : ''}
  </div>`;
  el.innerHTML = html;
  $('check').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try { renderUpdate(await api('/api/update/check', {})); } catch (err) { toast(err.message); ev.target.disabled = false; }
  });
  $('install')?.addEventListener('click', async (ev) => {
    if (!confirm(`Install v${u.latest.version}?\n\nThe app restarts for a moment. Your stats are backed up first. The overlay switches to the new version the next time it's on the game select screen.`)) return;
    ev.target.disabled = true;
    ev.target.textContent = 'Installing…';
    try {
      await api('/api/update/install', {});
      toast('Installed. Restarting…', 6000);
    } catch (err) { toast(err.message, 6000); ev.target.disabled = false; ev.target.textContent = `Install v${u.latest.version}`; }
  });
}

document.addEventListener('click', (ev) => {
  const id = ev.target.dataset?.copy;
  if (!id) return;
  navigator.clipboard.writeText($(id).value).then(() => toast('Copied'), () => { $(id).select(); toast('Press Ctrl+C to copy'); });
});
$('obs-options').addEventListener('input', onOptionChange);
$('obs-options').addEventListener('change', onOptionChange);
$('reset-options').addEventListener('click', () => {
  options = { ...DEFAULTS };
  writeOptions(options);
  renderModes();
  onOptionChange();
});
$('open-data').addEventListener('click', () => api('/api/open-data', {}).catch((err) => toast(err.message)));
$('save-settings').addEventListener('click', async () => {
  try {
    const r = await api('/api/settings', {
      autoCheck: $('set-autoCheck').checked,
      openPanel: $('set-openPanel').checked,
      twitchClientId: $('set-twitchClientId').value,
      updateRepo: $('set-updateRepo').value.trim(),
    });
    const changed = $('set-twitchClientId').value !== status.settings.twitchClientId || $('set-updateRepo').value.trim() !== status.settings.updateRepo;
    if (r.restartNeeded && changed) {
      $('settings-msg').textContent = 'Saved. Restarting the app…';
      await api('/api/restart', {});
    } else {
      $('settings-msg').textContent = 'Saved.';
      refresh();
    }
  } catch (err) { $('settings-msg').textContent = err.message; }
});

// Live updates; a new "hello" after a restart reloads the panel.
const events = new EventSource('/api/events');
events.addEventListener('hello', (ev) => {
  const v = JSON.parse(ev.data).version;
  if (version && v !== version) { location.reload(); return; }
  if (version) refresh();
  version = v;
});
events.addEventListener('twitch', (ev) => {
  const st = JSON.parse(ev.data);
  if (st.state !== 'logging-in') login = null;
  if (status) { status.twitch = st; renderTwitch(st); renderBot(status.twitchBot); }
});
events.addEventListener('twitchBot', (ev) => {
  const st = JSON.parse(ev.data);
  if (st.state !== 'logging-in') botLogin = null;
  if (status) { status.twitchBot = st; renderBot(st); }
});
events.addEventListener('update', (ev) => renderUpdate(JSON.parse(ev.data)));

loadGames().then(refresh).catch((err) => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="note">${esc(err.message)}</p>`); });
