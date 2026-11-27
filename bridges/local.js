// Local bridge: one person playing on this device (the Android app, or a browser with
// ?bridge=local). There is no chat — the touch HUD turns taps into the same commands
// chat would send (!bg play ludo, !join, !3, …), so the Session works unchanged.
// The local player counts as the broadcaster, so they can start and stop games.

import { Bridge } from './bridge.js';

export class LocalBridge extends Bridge {
  // privateView: this screen belongs to one player, so it may show their secret cards.
  capabilities = { chat: true, sendChat: false, whisper: false, predictions: false, extension: false, local: true, privateView: true };

  constructor(options = {}) {
    super(options);
    const name = String(options.playerName ?? '').trim().slice(0, 25) || 'You';
    // playerId: a random id per phone (main.js keeps it), so players stay apart in same-WiFi games.
    const id = String(options.playerId ?? '').trim() || 'local-player';
    this.user = { id, login: 'you', name, isBroadcaster: true, isMod: true };
  }

  async connect() { this.status('connected', 'on this device'); }

  // Sends a command as the local player, exactly as if it was typed in chat.
  send(text) {
    this.emit('chat', { platform: 'local', text, user: this.user });
  }
}
