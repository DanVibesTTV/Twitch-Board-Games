// "Phone players" in the companion app: opens the streamer's session on the session server
// (app/session-server.mjs) with their Twitch login, and hands the overlay what it needs to host
// it (server URL, session name, host key). The overlay then hosts the game for viewers' phones
// (ui/stream-host.js); this module never sees game traffic.
//
// Settings: phones = { enabled, server }.  State (sent to the overlay and the panel as
// 'streamSession'): { enabled, server, state: 'off' | 'waiting-login' | 'opening' | 'open' | 'error',
// detail, session, name, key }.

import { EventEmitter } from 'node:events';

export const DEFAULT_SESSION_SERVER = 'https://games.danvibes.net';
const RETRY_MS = 60_000;

export class PhoneSessions extends EventEmitter {
  constructor({ store, twitch, fetch = globalThis.fetch, log = console }) {
    super();
    Object.assign(this, { store, twitch, fetch, log });
    this.state = { state: 'off' };
    this.status = { connected: false, players: [] }; // reported by the overlay
    this.retry = null;
    twitch.on('state', (st) => {
      if (!this.settings.enabled) return;
      if (st.state === 'connected' && this.state.state !== 'open' && this.state.state !== 'opening') this.open();
      if (st.state === 'logged-out') this.#set({ state: 'waiting-login', detail: 'log in with Twitch first' });
    });
  }

  get settings() {
    const p = this.store.settings.phones ?? {};
    return { enabled: !!p.enabled, server: cleanUrl(p.server) ?? DEFAULT_SESSION_SERVER };
  }

  // What the overlay needs (includes the host key: only sent over the local overlay stream).
  get public() {
    const { enabled, server } = this.settings;
    return { enabled, server, ...this.state };
  }

  async configure({ enabled, server }) {
    const next = { ...this.settings };
    if (enabled !== undefined) next.enabled = !!enabled;
    if (server !== undefined) {
      const url = cleanUrl(server);
      if (server && !url) throw new Error('The session server address must start with https:// (or http:// for testing).');
      next.server = url ?? DEFAULT_SESSION_SERVER;
    }
    await this.store.saveSettings({ phones: next });
    if (next.enabled) await this.open();
    else { clearTimeout(this.retry); this.#set({ state: 'off', detail: '', session: null, name: null, key: null }); }
  }

  async open() {
    clearTimeout(this.retry);
    const { enabled, server } = this.settings;
    if (!enabled) return this.#set({ state: 'off' });
    const account = this.twitch.main;
    if (!account.auth?.access_token) return this.#set({ state: 'waiting-login', detail: 'log in with Twitch first' });
    this.#set({ state: 'opening', detail: '' });
    try {
      let res = await this.#post(server, account.auth.access_token);
      if (res.status === 401 && await account.refresh().then(() => true, () => false)) res = await this.#post(server, account.auth.access_token);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      this.#set({ state: 'open', detail: '', session: body.session, name: body.name, key: body.key });
      this.log.log?.(`[phones] session "${body.session}" is open on ${server}`);
    } catch (err) {
      const detail = err.cause?.code === 'ENOTFOUND' || /fetch failed/.test(err.message) ? `can't reach ${server}` : err.message;
      this.#set({ state: 'error', detail: `${detail} — retrying every minute`, key: null });
      this.log.warn?.(`[phones] could not open the session: ${detail}`);
      this.retry = setTimeout(() => this.open(), RETRY_MS);
      this.retry.unref?.();
    }
  }

  // The overlay reports whether it is connected and who is there.
  report({ connected, players }) {
    this.status = {
      connected: !!connected,
      players: Array.isArray(players) ? players.slice(0, 200).map((p) => String(p).slice(0, 25)) : [],
    };
    this.emit('status', this.status);
  }

  #post(server, token) {
    return this.fetch(`${server}/api/sessions`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.public);
  }

  close() { clearTimeout(this.retry); }
}

function cleanUrl(value) {
  const v = String(value ?? '').trim().replace(/\/+$/, '');
  if (!v) return null;
  return /^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/i.test(v) ? v : null;
}
