// Companion app bridge: the overlay is served by `node app/companion.mjs` on this PC,
// which logs in to Twitch itself (chat in/out, predictions) and saves stats to a file.
//
//   http://127.0.0.1:8765/?bridge=node
//
// Chat and status arrive over Server-Sent Events (/api/events); sending goes through POST.

import { Bridge } from './bridge.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-BoardGames': '1' };

export class NodeBridge extends Bridge {
  capabilities = { chat: true, sendChat: true, whisper: false, predictions: true, extension: false };

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
    es.addEventListener('twitch', (ev) => {
      let st;
      try { st = JSON.parse(ev.data); } catch { return; }
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
