// Stream sessions: the same LanHost / LanClient messages as same-WiFi play (net/lan.js), carried
// over the internet through the session server (app/session-server.mjs) instead of the WiFi.
// Both classes have the transport interface of net/transport.js.
//
//   RelayHost   — in the streamer's overlay. host() connects to /ws/host; phones appear as peers
//                 named by the server ("p7"), each with a Twitch-checked user (userOf(peerId)).
//                 A dropped connection is retried quietly; phones that are still there afterwards
//                 stay the same peers, so a network blip doesn't end anybody's game.
//   RelayClient — on a viewer's phone. connect(streamerLogin) logs in with the viewer's Twitch
//                 token, then passes messages. Reconnects after a drop and repeats its first
//                 message (the LanClient hello), so the host takes the phone back in.

import { Emitter } from '../core/emitter.js';

export const DEFAULT_SESSION_SERVER = 'https://games.danvibes.net';

const wsUrl = (base, path) => `${String(base).replace(/\/+$/, '').replace(/^http/, 'ws')}${path}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class RelayHost extends Emitter {
  // server: https URL of the session server; session: the streamer's login; key: from POST /api/sessions.
  constructor({ server, session, key, WebSocketImpl = globalThis.WebSocket, retryMs = [1000, 2000, 5000, 10000, 20000] }) {
    super();
    Object.assign(this, { server, session, key, WebSocketImpl, retryMs });
    this.users = new Map();   // peerId → user ({ id, login, name }) from the server
    this.ws = null;
    this.stopped = false;
    this.connected = false;
  }

  userOf(peerId) { return this.users.get(peerId) ?? null; }

  // Resolves once the server accepted us (first connection); retries in the background after that.
  host() {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      let first = true;
      let attempt = 0;
      const open = () => {
        if (this.stopped) return;
        const ws = new this.WebSocketImpl(wsUrl(this.server, `/ws/host?session=${encodeURIComponent(this.session)}&key=${encodeURIComponent(this.key)}`));
        this.ws = ws;
        let replay = null; // peers we knew before a reconnect, until the server lists them again
        ws.onmessage = (e) => {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'ready') {
            attempt = 0;
            this.connected = true;
            replay = this.users.size ? new Set(this.users.keys()) : null;
            // Peers the server doesn't list again within a moment really left.
            if (replay) setTimeout(() => { for (const id of replay ?? []) this.#left(id); replay = null; }, 1500);
            this.emit('status', { connected: true, name: m.name });
            if (first) { first = false; resolve({ port: null, addresses: [], session: m.session, name: m.name }); }
          } else if (m.t === 'join') {
            const known = this.users.has(m.peer);
            this.users.set(m.peer, m.user);
            if (known && replay?.has(m.peer)) { replay.delete(m.peer); return; }
            this.emit('peer', { peerId: m.peer, user: m.user });
          } else if (m.t === 'msg') {
            // After a reconnect the server repeats each phone's hello; the host already has it.
            if (!this.#isReplayedHello(m)) this.emit('peerMessage', { peerId: m.peer, data: m.data });
          } else if (m.t === 'leave') {
            this.#left(m.peer);
          }
        };
        ws.onclose = (e) => {
          if (this.ws !== ws) return;
          this.connected = false;
          if (this.stopped) return;
          if (first) { first = false; reject(new Error(e.code === 1006 ? "Couldn't reach the session server." : `Session server refused the connection (${e.code}).`)); return; }
          if (e.code === 4000) { this.emit('status', { connected: false, replaced: true }); return; } // another overlay took over
          this.emit('status', { connected: false });
          setTimeout(open, this.retryMs[Math.min(attempt++, this.retryMs.length - 1)]);
        };
        ws.onerror = () => {};
      };
      this.#seen = new Set();
      open();
    });
  }

  #seen = new Set(); // peers whose hello the host has already handled

  #isReplayedHello(m) {
    let hello = false;
    try { hello = JSON.parse(m.data)?.t === 'hello'; } catch { /* not JSON */ }
    if (!hello) return false;
    if (this.#seen.has(m.peer)) return true;
    this.#seen.add(m.peer);
    return false;
  }

  #left(peerId) {
    if (!this.users.delete(peerId)) return;
    this.#seen.delete(peerId);
    this.emit('peerLeft', { peerId });
  }

  async stopHost() {
    this.stopped = true;
    this.connected = false;
    try { this.ws?.close(1000, 'stopped'); } catch { /* already closed */ }
    this.ws = null;
    for (const peerId of [...this.users.keys()]) this.#left(peerId);
  }

  async sendTo(peerId, data) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'send', peer: peerId, data }));
  }

  kick(peerId, reason) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'kick', peer: peerId, reason }));
  }

  // (transport interface: discovery doesn't exist here)
  async discover() {}
  async stopDiscovery() {}
}

export class RelayClient extends Emitter {
  // getToken(): the viewer's current Twitch access token (async; may refresh it first).
  constructor({ server, getToken, WebSocketImpl = globalThis.WebSocket, retryMs = [1000, 2000, 4000, 8000, 15000] }) {
    super();
    Object.assign(this, { server, getToken, WebSocketImpl, retryMs });
    this.ws = null;
    this.hello = null;   // the first message we sent; repeated after a reconnect
    this.left = false;
    this.user = null;
    this.streamer = null;
  }

  // Resolves with { user, name, live } once logged in; rejects with a readable message.
  connect(session) {
    this.session = String(session).trim().replace(/^@/, '').toLowerCase();
    this.left = false;
    return this.#open(true);
  }

  #open(first, attempt = 0) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(wsUrl(this.server, `/ws/play?session=${encodeURIComponent(this.session)}`));
      this.ws = ws;
      let authed = false;
      ws.onopen = async () => {
        try { ws.send(JSON.stringify({ t: 'auth', token: await this.getToken() })); } catch (err) { reject(err); ws.close(); }
      };
      ws.onmessage = (e) => {
        if (!authed) {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'auth-ok') {
            authed = true;
            attempt = 0;
            this.user = m.user;
            this.streamer = m.name;
            if (!first && this.hello) ws.send(this.hello);
            if (!first) this.emit('reconnected', {});
            resolve({ user: m.user, name: m.name, live: m.live });
          } else if (m.t === 'auth-fail') {
            this.authFailed = m.reason;
            reject(new Error(m.reason));
          }
          return;
        }
        const data = e.data;
        if (data === '{"t":"host-gone"}') return this.emit('hostGone', {});
        if (data === '{"t":"host-back"}') return this.emit('hostBack', {});
        this.emit('message', { data });
      };
      ws.onerror = () => {};
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        if (!authed) {
          if (first) return reject(new Error(this.authFailed ?? (e.code === 1006 ? "Couldn't reach the stream. Check your internet connection, or the streamer hasn't turned on phone players." : `Connection refused (${e.code}).`)));
        }
        if (this.left) return;
        // Final reasons: logged in elsewhere, removed by the streamer, login rejected, stream full.
        const final = { 4001: this.authFailed ?? 'Your Twitch login expired — log in again.', 4002: 'You joined from another device.', 4003: e.reason || 'The streamer removed you.', 4004: 'This stream is full.', 4005: 'Too many messages — slow down.' }[e.code];
        if (final || attempt >= this.retryMs.length) return this.emit('closed', { reason: final ?? 'Lost the connection to the stream.' });
        this.emit('reconnecting', {});
        delay(this.retryMs[attempt]).then(() => (this.left ? null : this.#open(false, attempt + 1).catch(() => {})));
      };
    });
  }

  async send(data) {
    if (!this.hello) this.hello = data;
    if (this.ws?.readyState === 1) this.ws.send(data);
  }

  async disconnect() {
    this.left = true;
    try { this.ws?.close(1000, 'left'); } catch { /* already closed */ }
    this.ws = null;
  }

  async discover() {}
  async stopDiscovery() {}
}
