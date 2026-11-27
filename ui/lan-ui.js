// Same-WiFi multiplayer screens (touch mode): Host / Join on the game select screen, the player
// name prompt, the list of games found on the WiFi, and the joined phone's waiting states.
//
// Hosting happens in place: the phone's Session becomes the host (net/lan.js LanHost).
// Joining reloads the page with ?join=<address>; main.js then starts a follower Session and this
// class connects it (LanClient). Leaving reloads without ?join.

import { LanHost, LanClient } from '../net/lan.js';

const NAME_KEY = 'boardgames.player.name';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function savedPlayerName() { return store.get(NAME_KEY); }

export class LanUi {
  // transport: from net/transport.js (null = no WiFi play here). joinAddress: set on a joined phone.
  constructor({ session, bridge, transport, appVersion = null, joinAddress = null, setStatus = () => {} }) {
    Object.assign(this, { session, bridge, transport, appVersion, joinAddress, setStatus });
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
  }

  get available() { return !!this.transport; }
  get joined() { return !!this.joinAddress; }
  attach(hud) { this.hud = hud; }

  // What the joined phone's HUD shows instead of its own controls.
  get waitingText() {
    const who = this.hostName ? esc(this.hostName) : 'the host';
    if (this.client?.waiting) return `A game is running at ${who}'s — you join the next one.`;
    return this.session.phase === 'lobby' ? `Waiting for ${who} to start…` : `Waiting for ${who} to pick a game…`;
  }

  // Block on the game select screen (hosting status or the Host/Join buttons).
  menuHtml() {
    if (!this.available || this.joined) return '';
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
    return `<div class="lan-box" data-lan-box>
      <button class="lan-btn" data-lan="host">📶 Host a WiFi game</button>
      <button class="lan-btn" data-lan="join">🔗 Join a WiFi game</button>
    </div>`;
  }

  async action(act, el) {
    try {
      if (act === 'host') { await this.#ensureName(); await this.#startHost(); }
      if (act === 'stop') { await this.host?.stop(); this.host = null; this.#status(); this.hud?.refresh(); }
      if (act === 'join') { await this.#ensureName(); this.#openJoin(); }
      if (act === 'pick') this.#goJoin(el.dataset.address);
      if (act === 'manual') {
        const v = this.modal.querySelector('input[name="address"]')?.value.trim();
        if (v) this.#goJoin(v);
      }
      if (act === 'cancel') this.#closeModal();
      if (act === 'leave') this.#leave();
    } catch (err) {
      console.error('[lan]', err);
      this.#message('Something went wrong', esc(err.message ?? err));
    }
  }

  // ── name ──
  #ensureName() {
    const saved = savedPlayerName();
    if (saved) { this.bridge.user.name = saved; return Promise.resolve(saved); }
    return new Promise((resolve) => {
      this.#showModal(`
        <h2>Your name</h2>
        <p>Shown to the other players.</p>
        <input name="player" maxlength="20" autocomplete="off" autocapitalize="words" enterkeyhint="done" placeholder="e.g. Dan">
        <div class="lan-row"><button class="lan-btn ghost" data-lan="cancel">Cancel</button><button class="lan-btn" data-lan="name-ok" data-enter>OK</button></div>`);
      const input = this.modal.querySelector('input');
      setTimeout(() => input.focus(), 50);
      const ok = this.modal.querySelector('[data-lan="name-ok"]');
      ok.addEventListener('click', () => {
        const name = input.value.trim().slice(0, 20);
        if (!name) { input.focus(); return; }
        store.set(NAME_KEY, name);
        this.bridge.user.name = name;
        input.blur();
        this.#closeModal();
        resolve(name);
      }, { once: true });
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

  #leave() {
    this.client?.leave().catch(() => {});
    const q = new URLSearchParams(location.search);
    q.delete('join');
    location.search = q.toString();
  }

  // Taps on a joined phone go to the host.
  send(text) { this.client?.send(text); }

  // ── modal + status ──
  #status() {
    if (this.joined) this.setStatus(this.hostName ? `at ${this.hostName}'s` : 'connecting…');
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
