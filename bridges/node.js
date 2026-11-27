// Companion app bridge: the overlay is served by `node app/companion.mjs` on this PC,
// which logs in to Twitch itself (chat in/out, predictions) and saves stats to a file.
//
//   http://127.0.0.1:8765/?bridge=node
//
// Chat and status arrive over Server-Sent Events (/api/events); sending goes through POST.
//
// Streamer dock (http://127.0.0.1:8765/dock/ as an OBS custom browser dock): while one is open,
// the streamer has a private screen, so hidden-information games (Texas Hold 'em) can be played —
// by the streamer, against bots. The dock's buttons arrive as the streamer's own chat commands.

import { Bridge } from './bridge.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-BoardGames': '1' };

export class NodeBridge extends Bridge {
  capabilities = { chat: true, sendChat: true, whisper: false, predictions: true, extension: false, privateView: false };
  docks = 0;
  login = null; // the streamer's Twitch login
  streamSession = null;      // phone players: what the companion opened (app/phone-sessions.mjs)
  phoneUsers = new Set();    // ids of viewers connected with the phone app (ui/stream-host.js)
  streamLive = false;

  constructor(options) {
    super(options);
    this.base = options.base ?? '';
    this.prediction = {
      create: (title, outcomes, seconds) => this.post('/api/prediction', { action: 'create', title, outcomes, seconds }),
      lock: () => this.post('/api/prediction', { action: 'lock' }),
      resolve: (index) => this.post('/api/prediction', { action: 'resolve', index }),
      cancel: () => this.post('/api/prediction', { action: 'cancel' }),
    };
  }

  async connect() {
    if (typeof EventSource === 'undefined') { this.status('error', 'EventSource not available'); return; }
    this.status('connecting', 'companion app');
    const es = (this.es = new EventSource(`${this.base}/api/events`));
    es.addEventListener('chat', (ev) => {
      try { this.emit('chat', JSON.parse(ev.data)); } catch { /* ignore bad event */ }
    });
    es.addEventListener('dockCommand', (ev) => {
      try { this.emit('chat', JSON.parse(ev.data)); } catch { /* ignore bad event */ }
    });
    es.addEventListener('streamSession', (ev) => {
      try { this.streamSession = JSON.parse(ev.data); } catch { return; }
      this.emit('streamSession', this.streamSession);
    });
    es.addEventListener('dock', (ev) => {
      let info;
      try { info = JSON.parse(ev.data); } catch { return; }
      this.docks = Number(info.connected) || 0;
      this.#updatePrivateView();
      this.emit('dock', { connected: this.docks });
    });
    es.addEventListener('twitch', (ev) => {
      let st;
      try { st = JSON.parse(ev.data); } catch { return; }
      if (st.login) this.login = String(st.login).toLowerCase();
      if (st.state === 'connected') this.status('connected', `#${st.login}`);
      else if (st.state === 'logged-out') this.status('error', 'log in to Twitch in the companion app');
      else this.status(st.state === 'error' ? 'error' : 'connecting', st.detail || st.state);
    });
    // The app restarted with a different version (after an update): tell main.js.
    es.addEventListener('hello', (ev) => {
      let info;
      try { info = JSON.parse(ev.data); } catch { return; }
      if (this.version && info.version !== this.version) this.emit('appUpdated', info);
      this.version ??= info.version;
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) { es.close(); this.scheduleReconnect(); }
      else this.status('disconnected', 'companion app not running?');
    };
  }

  async sendChat(text) { return this.post('/api/chat', { text }); }

  // Private screens: the streamer's dock (while open), and viewers playing on their phones.
  privateViewFor(user) {
    return (this.docks > 0 && this.isStreamer(user)) || this.phoneUsers.has(user?.id);
  }

  // ui/stream-host.js: whether phones can connect, and who is connected.
  setPhones({ live, users }) {
    this.streamLive = !!live;
    this.phoneUsers = new Set(users ?? []);
    this.#updatePrivateView();
  }

  reportPhones(status) { return this.post('/api/phones/status', status); }

  #updatePrivateView() {
    const had = this.capabilities.privateView;
    this.capabilities.privateView = this.docks > 0 || this.streamLive;
    if (had !== this.capabilities.privateView) this.emit('capabilities', this.capabilities);
  }

  isStreamer(user) {
    return !!user && (user.isBroadcaster || (!!this.login && user.login?.toLowerCase() === this.login));
  }

  // The dock snapshot (Session.dockState()) — the server passes it to the dock only.
  pushDock(state) { return this.post('/api/dock/state', state); }

  async post(path, body) {
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  close() {
    this.closed = true;
    this.es?.close();
  }
}
