// Same-WiFi multiplayer screens (touch mode): Host / Join on the game select screen, the player
// name prompt, the list of games found on the WiFi, and the joined phone's waiting states.
//
// Hosting happens in place: the phone's Session becomes the host (net/lan.js LanHost).
// Joining reloads the page with ?join=<address>; main.js then starts a follower Session and this
// class connects it (LanClient). Leaving reloads without ?join.
//
// Join a stream (needs a session server, net/relay.js): the same follower Session, connected to a
// streamer's overlay over the internet. Twitch login first (ui/twitch-viewer.js), then the page
// reloads with ?stream=<streamer login>.

import { LanHost, LanClient } from '../net/lan.js';
import { RelayClient } from '../net/relay.js';
import { savedViewer, logInViewer, logOutViewer, viewerToken } from './twitch-viewer.js';

const STREAM_KEY = 'boardgames.stream.last';

const NAME_KEY = 'boardgames.player.name';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function savedPlayerName() { return store.get(NAME_KEY); }

export class LanUi {
  // transport: from net/transport.js (null = no WiFi play here). joinAddress: set on a joined phone.
  constructor({ session, bridge, transport, appVersion = null, joinAddress = null, streamName = null, sessionServer = null, setStatus = () => {} }) {
    Object.assign(this, { session, bridge, transport, appVersion, joinAddress, streamName, sessionServer, setStatus });
    this.host = null;
    this.client = null;
    this.hostName = null;
    this.modal = document.createElement('div');
    this.modal.className = 'lan-modal';
    this.modal.addEventListener('click', (e) => {
      const act = e.target.closest?.('[data-lan]')?.dataset.lan;
      if (act) this.action(act, e.target.closest('[data-lan]'));
    });
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.modal.querySelector('[data-enter]')?.click();
    });
    document.body.append(this.modal);
    if (joinAddress) this.#join(joinAddress);
    else if (streamName) this.#joinStream(streamName);
  }

  get available() { return !!this.transport; }
  get joined() { return !!this.joinAddress || !!this.streamName; }
  get stream() { return !!this.streamName; }
  attach(hud) { this.hud = hud; }

  // What the joined phone's HUD shows instead of its own controls.
  get waitingText() {
    const who = this.hostName ? esc(this.hostName) : this.stream ? esc(this.streamName) : 'the host';
    if (this.offline) return `${who}'s overlay is offline — waiting for it to come back…`;
    if (this.client?.waiting) return `A game is running at ${who}'s — you join the next one.`;
    return this.session.phase === 'lobby' ? `Waiting for ${who} to start…` : `Waiting for ${who} to pick a game…`;
  }

  // Block on the game select screen (hosting status or the Host/Join buttons).
  menuHtml() {
    if (this.joined || (!this.available && !this.sessionServer)) return '';
    if (this.host) {
      const players = this.host.players;
      const addr = this.host.info?.addresses?.find((a) => !a.startsWith('bc:')) ?? this.host.info?.addresses?.[0] ?? '';
      return `<div class="lan-box hosting" data-lan-box>
        <div class="lan-title">📶 Hosting on this WiFi${addr && !addr.startsWith('bc:') ? ` · address <b>${esc(addr)}</b>` : ''}</div>
        <div class="lan-players">${players.length ? players.map((u) => `<span>${esc(u.name)}</span>`).join('') : '<em>Waiting for players to join…</em>'}</div>
        <div class="lan-hint">Pick a game: everyone connected plays. Empty seats become bots.</div>
        <button class="lan-btn ghost" data-lan="stop">Stop hosting</button>
      </div>`;
    }
    const name = savedPlayerName();
    return `<div class="lan-box" data-lan-box>
      ${this.available ? `<button class="lan-btn" data-lan="host">📶 Host a WiFi game</button>
      <button class="lan-btn" data-lan="join">🔗 Join a WiFi game</button>` : ''}
      ${this.sessionServer ? '<button class="lan-btn" data-lan="stream">📺 Join a stream</button>' : ''}
      ${name && this.available ? `<button class="lan-btn ghost lan-name" data-lan="rename" aria-label="Change your name">✏️ ${esc(name)}</button>` : ''}
    </div>`;
  }

  async action(act, el) {
    try {
      if (act === 'host') { await this.#ensureName(); await this.#startHost(); }
      if (act === 'stop') { await this.host?.stop(); this.host = null; this.#status(); this.hud?.refresh(); }
      if (act === 'join') { await this.#ensureName(); this.#openJoin(); }
      if (act === 'rename') { if (await this.#askName(savedPlayerName())) this.hud?.refresh(); }
      if (act === 'pick') this.#goJoin(el.dataset.address);
      if (act === 'manual') {
        const v = this.modal.querySelector('input[name="address"]')?.value.trim();
        if (v) this.#goJoin(v);
      }
      if (act === 'stream') this.#openStream();
      if (act === 'stream-go') await this.#goStream(this.modal.querySelector('input[name="streamer"]')?.value);
      if (act === 'twitch-logout') { logOutViewer(); this.#openStream(); }
      if (act === 'login-cancel') { this.loginSignal && (this.loginSignal.cancelled = true); this.#closeModal(); }
      if (act === 'cancel') this.#closeModal();
      if (act === 'leave') this.#leave();
    } catch (err) {
      console.error('[lan]', err);
      this.#message('Something went wrong', esc(err.message ?? err));
    }
  }

  // ── name ──
  // Asked once before the first WiFi game; the ✏️ button on the game select screen changes it.
  #ensureName() {
    const saved = savedPlayerName();
    if (saved) { this.bridge.user.name = saved; return Promise.resolve(saved); }
    return this.#askName('').then((name) => name ?? new Promise(() => {})); // cancelled: stop here
  }

  // Resolves with the new name, or null when cancelled.
  #askName(current) {
    return new Promise((resolve) => {
      this.#showModal(`
        <h2>${current ? 'Change your name' : 'Your name'}</h2>
        <p>Shown to the other players in WiFi games.</p>
        <input name="player" maxlength="20" autocomplete="off" autocapitalize="words" enterkeyhint="done" placeholder="e.g. Dan" value="${esc(current ?? '')}">
        <div class="lan-row"><button class="lan-btn ghost" data-lan="name-cancel">Cancel</button><button class="lan-btn" data-lan="name-ok" data-enter>${current ? 'Save' : 'OK'}</button></div>`);
      const input = this.modal.querySelector('input');
      setTimeout(() => { input.focus(); input.select(); }, 50);
      const finish = (name) => { input.blur(); this.#closeModal(); resolve(name); };
      this.modal.querySelector('[data-lan="name-cancel"]').addEventListener('click', () => finish(null), { once: true });
      this.modal.querySelector('[data-lan="name-ok"]').addEventListener('click', () => {
        const name = input.value.trim().slice(0, 20);
        if (!name) { input.focus(); return; }
        store.set(NAME_KEY, name);
        this.bridge.user.name = name;
        finish(name);
      });
    });
  }

  // ── hosting ──
  async #startHost() {
    if (this.session.phase !== 'menu') this.session.toMenu();
    this.host = new LanHost({
      session: this.session,
      transport: this.transport,
      hostName: this.bridge.user.name,
      appVersion: this.appVersion,
      onChange: () => { this.#status(); this.hud?.refresh(); },
    });
    await this.host.start();
    this.#status();
    this.hud?.refresh();
  }

  // ── joining ──
  #openJoin() {
    const found = new Map(); // address → name
    const render = () => {
      const list = this.modal.querySelector('.lan-found');
      if (!list) return;
      list.innerHTML = found.size
        ? [...found].map(([address, name]) => `<button class="lan-btn" data-lan="pick" data-address="${esc(address)}">🎲 ${esc(name)}</button>`).join('')
        : '<em>Looking for games on this WiFi…</em>';
    };
    this.#showModal(`
      <h2>Join a WiFi game</h2>
      <div class="lan-found"></div>
      <p>Not listed? Type the address the host's phone shows:</p>
      <div class="lan-row"><input name="address" inputmode="decimal" autocomplete="off" placeholder="192.168.1.23" enterkeyhint="go"><button class="lan-btn" data-lan="manual" data-enter>Join</button></div>
      <div class="lan-row"><button class="lan-btn ghost" data-lan="cancel">Cancel</button></div>`);
    render();
    const offs = [
      this.transport.on('found', ({ name, address }) => { found.set(address, name); render(); }),
      this.transport.on('lost', ({ name, address }) => {
        for (const [a, n] of found) if (a === address || n === name) found.delete(a);
        render();
      }),
    ];
    this.transport.discover().catch((err) => console.warn('[lan] discovery failed', err));
    this.closeJoin = () => { for (const off of offs) off(); this.transport.stopDiscovery().catch(() => {}); };
  }

  #goJoin(address) {
    this.closeJoin?.();
    const q = new URLSearchParams(location.search);
    q.set('join', address);
    location.search = q.toString();
  }

  async #join(address) {
    this.setStatus('connecting…');
    this.client = new LanClient({
      session: this.session,
      transport: this.transport,
      user: this.bridge.user,
      appVersion: this.appVersion,
      onChange: (c) => {
        if (c.hostName) this.hostName = c.hostName;
        if (c.error) return this.#message("Couldn't join", esc(c.error), true);
        if (c.closed) return this.#message('Disconnected', esc(c.reason || 'The connection to the host was lost.'), true);
        this.#status();
        this.hud?.refresh();
      },
    });
    try {
      await this.client.join(address);
    } catch (err) {
      this.#message("Couldn't join", `${esc(err.message ?? err)}<br>Both phones must be on the same WiFi.`, true);
    }
  }

  // ── joining a stream ──
  #openStream() {
    const viewer = savedViewer();
    this.#showModal(`
      <h2>Join a stream</h2>
      <p>Play on a streamer's table from your phone. They need the Stream Board Games companion app with <b>Phone players</b> turned on.</p>
      <div class="lan-row"><input name="streamer" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Streamer's Twitch name" enterkeyhint="go" maxlength="26" value="${esc(store.get(STREAM_KEY) ?? '')}"><button class="lan-btn" data-lan="stream-go" data-enter>Join</button></div>
      <p class="lan-hint">${viewer ? `Logged in with Twitch as <b>${esc(viewer.user.name)}</b> · <a href="#" data-lan="twitch-logout">log out</a>` : 'You log in with Twitch once, so the streamer knows who you are.'}</p>
      <div class="lan-row"><button class="lan-btn ghost" data-lan="cancel">Cancel</button></div>`);
    setTimeout(() => this.modal.querySelector('input')?.focus(), 50);
  }

  async #goStream(raw) {
    const name = String(raw ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!/^\w{1,25}$/.test(name)) return this.modal.querySelector('input')?.focus();
    store.set(STREAM_KEY, name);
    this.modal.querySelector('input')?.blur();
    let info = null;
    try {
      info = await fetch(`${this.sessionServer}/api/sessions/${encodeURIComponent(name)}`).then((r) => r.json());
    } catch {
      return this.#message("Couldn't reach the stream", 'Check your internet connection and try again.');
    }
    if (!info.open) return this.#message('Not open yet', `<b>${esc(name)}</b> hasn't turned on phone players. Ask them to switch on <b>Phone players</b> in the companion app.`);
    if (!savedViewer() && !(await this.#twitchLogin())) return;
    const q = new URLSearchParams(location.search);
    q.delete('join');
    q.set('stream', name);
    location.search = q.toString();
  }

  // Twitch device login: shows the code, waits until it is confirmed. Resolves true when logged in.
  async #twitchLogin() {
    this.loginSignal = { cancelled: false };
    this.#showModal('<h2>Log in with Twitch</h2><p>Getting a code…</p>');
    try {
      await logInViewer(this.sessionServer, ({ user_code, verification_uri }) => {
        this.#showModal(`
          <h2>Log in with Twitch</h2>
          <p>Open <a href="${esc(verification_uri)}" target="_blank" rel="noopener"><b>twitch.tv/activate</b></a> and enter this code:</p>
          <div class="lan-code">${esc(user_code)}</div>
          <p class="lan-hint">This phone stays logged in. Waiting for Twitch…</p>
          <div class="lan-row"><a class="lan-btn" href="${esc(verification_uri)}?device-code=${encodeURIComponent(user_code)}" target="_blank" rel="noopener">Open Twitch</a><button class="lan-btn ghost" data-lan="login-cancel">Cancel</button></div>`);
      }, this.loginSignal);
      return true;
    } catch (err) {
      if (err.message !== 'cancelled') this.#message("Couldn't log in", esc(err.message));
      return false;
    }
  }

  async #joinStream(name) {
    if (!savedViewer()) return this.#message('Log in with Twitch', 'Log in again to join the stream.', true);
    this.setStatus('connecting…');
    const transport = new RelayClient({ server: this.sessionServer, getToken: () => viewerToken(this.sessionServer) });
    transport.on('hostGone', () => { this.offline = true; this.#status(); this.hud?.refresh(); });
    transport.on('hostBack', () => { this.offline = false; this.#status(); this.hud?.refresh(); });
    transport.on('reconnecting', () => this.setStatus('reconnecting…'));
    transport.on('reconnected', () => this.#status());
    this.client = new LanClient({
      session: this.session,
      transport,
      user: this.bridge.user,
      appVersion: this.appVersion,
      onChange: (c) => {
        if (c.hostName) this.hostName = c.hostName;
        if (c.error) return this.#message("Couldn't join", esc(c.error), true);
        if (c.closed) return this.#message('Disconnected', esc(c.reason || 'The connection to the stream was lost.'), true);
        this.#status();
        this.hud?.refresh();
      },
    });
    try {
      const info = await this.client.join(name);
      this.offline = !transport.ws || info?.live === false;
      this.hostName ??= transport.streamer;
      this.#status();
      this.hud?.refresh();
    } catch (err) {
      this.#message("Couldn't join", esc(err.message ?? err), true);
    }
  }

  #leave() {
    this.client?.leave().catch(() => {});
    const q = new URLSearchParams(location.search);
    q.delete('join');
    q.delete('stream');
    location.search = q.toString();
  }

  // Taps on a joined phone go to the host.
  send(text) { this.client?.send(text); }

  // ── modal + status ──
  #status() {
    if (this.stream) this.setStatus(this.hostName ? `📺 ${this.hostName}'s stream${this.offline ? ' · offline' : ''}` : 'connecting…');
    else if (this.joined) this.setStatus(this.hostName ? `at ${this.hostName}'s` : 'connecting…');
    else if (this.host) this.setStatus(`hosting · ${this.host.players.length} joined`);
    else this.setStatus(null);
  }

  #showModal(html) {
    this.closeJoin?.();
    this.closeJoin = null;
    this.modal.innerHTML = `<div class="lan-card">${html}</div>`;
    this.modal.classList.add('show');
  }

  #closeModal() {
    this.closeJoin?.();
    this.closeJoin = null;
    this.modal.classList.remove('show');
    this.modal.innerHTML = '';
  }

  // leave = the button takes a joined phone back to playing alone.
  #message(title, html, leave = false) {
    this.#showModal(`<h2>${esc(title)}</h2><p>${html}</p>
      <div class="lan-row"><button class="lan-btn" data-lan="${leave ? 'leave' : 'cancel'}" data-enter>${leave ? 'Back to playing alone' : 'OK'}</button></div>`);
  }
}
