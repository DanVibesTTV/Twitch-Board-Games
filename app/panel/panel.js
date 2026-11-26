// Control panel for the companion app (http://127.0.0.1:8765/panel/).

const H = { 'Content-Type': 'application/json', 'X-BoardGames': '1' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let status = null;
let login = null;   // pending device code { user_code, verification_uri }
let version = null;

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
  const base = `${location.origin}`;
  $('version').textContent = `v${status.version}`;
  $('obs-url').value = `${base}/?bridge=node`;
  $('preview').href = `${base}/?bridge=node&preview=1`;
  $('data-dir').value = status.dataDir;
  $('set-autoCheck').checked = status.settings.autoCheck;
  $('set-openPanel').checked = status.settings.openPanel;
  $('set-twitchClientId').value = status.settings.twitchClientId;
  $('set-updateRepo').value = status.settings.updateRepo;
  renderTwitch(status.twitch);
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
  if (status) { status.twitch = st; renderTwitch(st); }
});
events.addEventListener('update', (ev) => renderUpdate(JSON.parse(ev.data)));

refresh().catch((err) => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="note">${esc(err.message)}</p>`); });
