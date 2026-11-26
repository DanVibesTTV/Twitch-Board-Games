// Read-only Twitch chat with zero setup: anonymous ("justinfan") IRC over WebSocket.
// Can't send chat, whisper or run predictions — the HUD shows all game messages instead.

import { Bridge } from './bridge.js';

export class AnonIrcBridge extends Bridge {
  capabilities = { chat: true, sendChat: false, whisper: false, predictions: false, extension: false };

  async connect() {
    const channel = (this.options.channel ?? '').toLowerCase().replace(/^#/, '');
    if (!channel) {
      this.status('error', 'add ?channel=yourname to the URL');
      return;
    }
    this.status('connecting', `#${channel}`);
    const ws = (this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443'));
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        if (line.includes(' 366 ')) { this.retry = 0; this.status('connected', `#${channel} (read-only)`); continue; }
        const msg = parsePrivmsg(line);
        if (msg) this.emit('chat', msg);
      }
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.status('error', 'IRC socket error');
  }
}

// "@tags :login!login@login.tmi.twitch.tv PRIVMSG #chan :text"
export function parsePrivmsg(line) {
  const m = /^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$/.exec(line);
  if (!m) return null;
  const tags = Object.fromEntries((m[1] ?? '').split(';').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  const badges = tags.badges ?? '';
  const login = m[2];
  return {
    platform: 'twitch',
    text: m[3],
    user: {
      id: tags['user-id'] || login,
      login,
      name: tags['display-name'] || login,
      isBroadcaster: badges.includes('broadcaster/'),
      isMod: tags.mod === '1' || badges.includes('broadcaster/'),
    },
  };
}
