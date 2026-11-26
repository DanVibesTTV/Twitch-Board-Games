import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamerBotBridge, SB_ACTIONS } from '../bridges/streamerbot.js';

// Minimal fake of the browser WebSocket + Streamer.bot server replies.
class FakeWS {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.sent = []; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, status: 'ok' }) }), 0);
  }
  close() {}
}

test('Streamer.bot bridge sends the documented requests', async () => {
  globalThis.WebSocket = FakeWS;
  const b = new StreamerBotBridge({});
  const chats = [];
  b.on('chat', (c) => chats.push(c));
  await b.connect();
  await new Promise((r) => setTimeout(r, 10));
  const ws = FakeWS.last;
  assert.deepEqual(ws.sent[0].events, { Twitch: ['ChatMessage'] });

  await b.sendChat('hello');
  await b.whisper('alice', 'your cards');
  await b.prediction.create('Who wins Ludo?', ['alice (Red)', 'Bot | Green'], 60);
  await b.prediction.lock();
  await b.prediction.resolve(1);
  await b.prediction.cancel();

  const calls = ws.sent.slice(1).map((m) => [m.request, m.action.name, m.args]);
  assert.deepEqual(calls, [
    ['DoAction', SB_ACTIONS.bridge, { op: 'chat', message: 'hello' }],
    ['DoAction', SB_ACTIONS.bridge, { op: 'whisper', user: 'alice', message: 'your cards' }],
    ['DoAction', SB_ACTIONS.bridge, { op: 'predictionCreate', title: 'Who wins Ludo?', outcomes: 'alice (Red)|Bot / Green', seconds: '60' }],
    ['DoAction', SB_ACTIONS.bridge, { op: 'predictionLock' }],
    ['DoAction', SB_ACTIONS.resolve, { winnerIndex0: '1', winnerIndex: '2', winnerTitle: 'Bot / Green' }],
    ['DoAction', SB_ACTIONS.bridge, { op: 'predictionCancel' }],
  ]);

  ws.onmessage({ data: JSON.stringify({ event: { source: 'Twitch', type: 'ChatMessage' }, data: { text: '!join', user: { id: '9', login: 'z', name: 'Z', role: 1 } } }) });
  assert.equal(chats[0].text, '!join');
  b.close();
});
