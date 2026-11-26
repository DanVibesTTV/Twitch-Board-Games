// Common bridge interface. Every bridge:
//   - emits 'chat' with a normalized message { user: {id, login, name, isMod, isBroadcaster}, text, platform }
//   - emits 'status' with { state: 'connecting'|'connected'|'disconnected'|'error', detail }
//   - exposes `capabilities` and implements what they promise:
//       sendChat(text)                         → Promise
//       whisper(userLoginOrId, text)           → Promise
//       prediction.create(title, outcomes[], seconds) / .lock() / .resolve(outcomeIndex) / .cancel() → Promise

import { Emitter } from '../core/emitter.js';

export class Bridge extends Emitter {
  capabilities = { chat: true, sendChat: false, whisper: false, predictions: false, extension: false };

  constructor(options = {}) {
    super();
    this.options = options;
    this.prediction = {
      create: (title, outcomes, seconds) => this.unsupported('predictions'),
      lock: () => this.unsupported('predictions'),
      resolve: (index) => this.unsupported('predictions'),
      cancel: () => this.unsupported('predictions'),
    };
  }

  async connect() {}
  async sendChat(text) { return this.unsupported('sendChat'); }
  async whisper(user, text) { return this.unsupported('whisper'); }

  unsupported(what) {
    return Promise.reject(new Error(`${this.constructor.name} does not support ${what}`));
  }

  status(state, detail = '') {
    this.state = state;
    this.emit('status', { state, detail, bridge: this.constructor.name });
  }

  // Reconnect with backoff; subclasses call this from their socket close handler.
  scheduleReconnect() {
    if (this.closed) return;
    this.retry = Math.min((this.retry ?? 0) + 1, 6);
    const ms = 1000 * 2 ** (this.retry - 1);
    this.status('disconnected', `retrying in ${ms / 1000}s`);
    setTimeout(() => this.connect(), ms);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

// Picks the first non-empty value — the apps don't agree on field names,
// and they change between versions, so the bridges normalize defensively.
export const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
