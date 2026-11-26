// Dev bridge: type chat messages into a box on the overlay ("alice: !join red").
// Pretends to support everything and logs outgoing calls, so the whole flow
// (including predictions) can be tested without Twitch.

import { Bridge } from './bridge.js';

export class DevBridge extends Bridge {
  capabilities = { chat: true, sendChat: true, whisper: true, predictions: true, extension: false };

  constructor(options) {
    super(options);
    const log = (...a) => console.info('[dev-bridge]', ...a);
    this.prediction = {
      create: async (title, outcomes, seconds) => log('prediction.create', title, outcomes, seconds),
      lock: async () => log('prediction.lock'),
      resolve: async (i) => log('prediction.resolve', i),
      cancel: async () => log('prediction.cancel'),
    };
    this.log = log;
  }

  async connect() { this.status('connected', 'dev console'); }
  async sendChat(text) { this.log('chat →', text); }
  async whisper(user, text) { this.log(`whisper → ${user}:`, text); }

  // "name: text" or just "text" (sent as the streamer). Names starting with @ are mods.
  inject(line) {
    const m = /^\s*(@?[\w-]+)\s*:\s*(.*)$/.exec(line);
    const rawName = m ? m[1] : 'streamer';
    const text = m ? m[2] : line;
    const name = rawName.replace(/^@/, '');
    const isBroadcaster = name === 'streamer';
    this.emit('chat', {
      platform: 'dev',
      text,
      user: { id: name.toLowerCase(), login: name.toLowerCase(), name, isBroadcaster, isMod: isBroadcaster || rawName.startsWith('@') },
    });
  }
}
