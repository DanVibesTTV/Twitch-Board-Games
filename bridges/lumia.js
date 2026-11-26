// Lumia Stream bridge via its local WebSocket API (ws://127.0.0.1:39231/api?token=…).
// Docs: https://dev.lumiastream.com/docs/websockets/listen-to-events
//
// IMPORTANT: Lumia executes every JSON message sent on this socket as a command.
// Never send pings/acks here — only real commands (plus the one subscribe message).

import { Bridge, first } from './bridge.js';

export class LumiaBridge extends Bridge {
  // Whispers aren't in Lumia's documented send API, so we don't promise them.
  capabilities = { chat: true, sendChat: true, whisper: false, predictions: true, extension: false };

  constructor(options) {
    super(options);
    this.outcomes = [];
    this.prediction = {
      create: (title, outcomes, seconds) => {
        // Lumia splits outcomes on commas, so strip commas from names.
        this.outcomes = outcomes.map((o) => o.replace(/,/g, ' '));
        return this.send({
          type: 'create-prediction',
          params: { name: title, value: this.outcomes.join(','), duration: seconds, platform: 'twitch' },
        });
      },
      // Twitch locks automatically when the prediction window ends; Lumia has no documented lock command.
      lock: async () => {},
      // Lumia resolves by outcome *title* and acts on the last prediction created through Lumia.
      resolve: (index) => this.send({
        type: 'end-prediction',
        params: { name: 'RESOLVED', value: this.outcomes[index], platform: 'twitch' },
      }),
      cancel: () => this.send({ type: 'end-prediction', params: { name: 'CANCELED', platform: 'twitch' } }),
    };
  }

  async connect() {
    const { token, host = '127.0.0.1', port = 39231, secure = false } = this.options;
    if (!token) {
      this.status('error', 'add ?token=… (Lumia → Settings → API)');
      return;
    }
    const url = `${secure ? 'wss' : 'ws'}://${host}:${port}/api?token=${encodeURIComponent(token)}&name=BoardGames`;
    this.status('connecting', `${host}:${port}`);
    const ws = (this.ws = new WebSocket(url));
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ subscribe: ['chat'] }));
      this.status('connected', 'Lumia Stream');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const chat = normalizeLumiaChat(msg);
      if (chat) this.emit('chat', chat);
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.status('error', 'is Lumia running and the token right?');
  }

  async sendChat(text) {
    return this.send({ type: 'chatbot-message', params: { value: text, platform: 'twitch' } });
  }

  async send(body) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Lumia not connected');
    this.ws.send(JSON.stringify(body));
  }
}

// Also used by the in-overlay adapter (Overlay.on('chat', …)), which delivers the same `data` object.
export function normalizeLumiaChat(msg) {
  if (msg?.type && msg.type !== 'chat') return null;
  const data = msg?.data ?? msg;
  const x = data?.extraSettings ?? data ?? {};
  const text = first(data?.message, x.message);
  if (typeof text !== 'string') return null;
  const levels = x.userLevels ?? {};
  const login = first(x.username, data?.username, 'unknown');
  return {
    platform: first(msg?.origin, data?.origin, 'twitch'),
    text,
    user: {
      id: String(first(x.userId, data?.userId, login)),
      login,
      name: first(x.displayname, data?.displayname, login),
      isBroadcaster: !!levels.broadcaster,
      isMod: !!(levels.mod || levels.broadcaster),
    },
  };
}
