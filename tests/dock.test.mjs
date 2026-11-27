// Streamer dock: seat by username (!bg seat), kick (!bg kick), placeholders that become the real
// user on their first chat message, the dock snapshot (only the streamer's own secret cards),
// and the companion server relaying dock state and commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { DevBridge } from '../bridges/dev.js';
import { NodeBridge } from '../bridges/node.js';
import * as ludo from '../games/ludo/logic.js';
import * as holdem from '../games/holdem/logic.js';
import { cardText } from '../games/holdem/cards.js';

const ludoManifest = JSON.parse(readFileSync(new URL('../games/ludo/manifest.json', import.meta.url)));
const holdemManifest = JSON.parse(readFileSync(new URL('../games/holdem/manifest.json', import.meta.url)));
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Timers that never fire unless the test runs them.
function heldScheduler() {
  const timers = new Map(); let id = 0;
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: (i) => timers.delete(i),
    count: () => timers.size,
  };
}
const fastScheduler = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 3)); t.unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t),
};

function setup({ manifest = ludoManifest, logic = ludo, bridge = new DevBridge(), scheduler = heldScheduler(), config = {} } = {}) {
  bridge.said = [];
  bridge.sendChat = async (t) => bridge.said.push(t);
  bridge.prediction = { create: async () => {}, lock: async () => {}, resolve: async () => {}, cancel: async () => {} };
  const registry = createRegistry([{ ...manifest, needs: [] }], async () => logic);
  const s = new Session({ bridge, registry, scheduler, config: { predictions: false, ...config } });
  return { s, bridge };
}
const occ = (s, n) => s.seats[n - 1].occupant;

test('dock: !bg seat puts a username in a seat; they become the real user when they chat', async () => {
  const { s, bridge } = setup();
  await s.openLobby('ludo');
  bridge.inject('@mod: !bg seat 2 @DanVibes');
  assert.equal(occ(s, 2).type, 'human');
  assert.deepEqual({ ...occ(s, 2).user }, { id: 'pending:danvibes', login: 'danvibes', name: 'DanVibes', isMod: false, isBroadcaster: false, pending: true }, 'display name keeps its spelling');
  assert.match(bridge.said.at(-1), /DanVibes is seated as .*say anything in chat/);

  bridge.inject('viewer: !bg seat 1 someone');
  assert.equal(occ(s, 1), null, 'only mods can seat people');

  // seat by name works too; seating the same user again moves them
  const name3 = s.seats[2].name.toLowerCase();
  bridge.inject(`@mod: !bg seat ${name3} danvibes`);
  assert.equal(occ(s, 2), null);
  assert.equal(occ(s, 3).user.login, 'danvibes');

  // first chat message: the placeholder becomes the real user (and !join doesn't move them)
  bridge.inject('DanVibes: !join');
  assert.equal(occ(s, 3).user.id, 'danvibes');
  assert.equal(occ(s, 3).user.pending, undefined);
  assert.equal(s.seats.filter((x) => x.occupant?.type === 'human').length, 1);

  bridge.inject('@mod: !bg seat 9 bob');
  assert.match(bridge.said.at(-1), /Usage: !bg seat/);
  bridge.inject('@mod: !bg seat 1 not-a-valid-name!');
  assert.match(bridge.said.at(-1), /Usage: !bg seat/);
});

test('dock: !bg kick frees a lobby seat by number, seat name or username', async () => {
  const { s, bridge } = setup();
  await s.openLobby('ludo');
  bridge.inject('alice: !join');
  bridge.inject('bob: !join');
  bridge.inject('@mod: !bg bot 3');
  assert.equal(occ(s, 1).user.name, 'alice');
  bridge.inject('@mod: !bg kick 1');
  assert.equal(occ(s, 1), null);
  bridge.inject('@mod: !bg kick @Bob');
  assert.equal(occ(s, 2), null);
  bridge.inject(`@mod: !bg kick ${s.seats[2].name.toLowerCase()}`);
  assert.equal(occ(s, 3), null, 'a bot seat can be emptied in the lobby');
  bridge.inject('carol: !bg kick 1');
  assert.ok(bridge.said.every((t) => !t.includes('carol')), 'non-mods cannot kick');
});

test('dock: during a game, kick hands the seat to a bot and seat fills a bot seat', async () => {
  const { s, bridge } = setup({ scheduler: fastScheduler, config: { turnSeconds: 600, botDelayMs: 1, autoSingleMoveMs: 1 } });
  await s.openLobby('ludo');
  bridge.inject('alice: !join');
  bridge.inject('@mod: !bg bot 2');
  bridge.inject('@mod: !bg bots 2');
  await s.start();
  await tick();
  assert.equal(s.phase, 'playing');
  bridge.inject('@mod: !bg seat 1 bob');
  assert.match(bridge.said.at(-1), /taken/, 'a human seat cannot be replaced mid-game');
  bridge.inject('@mod: !bg seat 2 Bob');
  assert.equal(occ(s, 2).user.login, 'bob');
  assert.match(bridge.said.at(-1), /Bob takes over/);
  bridge.inject('@mod: !bg seat 4 carol');
  assert.match(bridge.said.at(-1), /isn't part of this game/, 'seats that are not in the game stay out');
  bridge.inject('@mod: !bg kick alice');
  assert.equal(occ(s, 1).type, 'bot');
  assert.equal(occ(s, 1).replaced, 'alice');
  s.stop();
});

test('dock: hidden games only seat players who have a private screen', async () => {
  const bridge = new DevBridge();
  bridge.privateViewFor = (u) => !!u.isBroadcaster;
  const { s } = setup({ manifest: holdemManifest, logic: holdem, bridge });
  await s.openLobby('holdem');
  bridge.inject('viewer: !join');
  assert.equal(s.seats.filter((x) => x.occupant?.type === 'human').length, 0);
  assert.match(bridge.said.at(-1), /private screen/);
  bridge.inject('@mod: !bg seat 2 viewer');
  assert.equal(occ(s, 2), null, 'mods cannot seat viewers either');
  bridge.inject('streamer: !join');
  assert.equal(s.seats.find((x) => x.occupant?.type === 'human')?.occupant.user.name, 'streamer');
});

test('dock state: the streamer sees only their own cards, and plays from the dock', async () => {
  const bridge = new DevBridge();
  bridge.privateViewFor = (u) => !!u.isBroadcaster;
  const { s } = setup({ manifest: holdemManifest, logic: holdem, bridge, scheduler: fastScheduler, config: { turnSeconds: 600, botDelayMs: 1, autoSingleMoveMs: 1 } });
  await s.openLobby('holdem');
  bridge.inject('streamer: !join');
  bridge.inject('@mod: !bg bots 4');
  await s.start();

  let checked = 0, moves = 0;
  for (let i = 0; i < 400 && s.phase === 'playing'; i++) {
    await tick();
    const st = s.dockState();
    if (!st.mine) continue;
    const g = st.mine.seat - 1;
    const gameSeat = s.activeSeatIdx.indexOf(g);
    const mine = s.game.viewFor(gameSeat).players[gameSeat].cards.map(cardText);
    const p = st.mine.private;
    assert.deepEqual(p.cards.map((c) => c.text), mine);
    // nobody else's hole cards anywhere in the snapshot
    const json = JSON.stringify(st);
    const board = new Set(p.board.map((c) => c.text));
    for (let o = 0; o < s.activeSeatIdx.length; o++) {
      if (o === gameSeat) continue;
      const theirs = s.game.viewFor(o).players[o].cards.map(cardText);
      for (const c of theirs) if (!mine.includes(c) && !board.has(c)) assert.ok(!json.includes(`"${c}"`), `seat ${o}'s ${c} leaked`);
    }
    checked++;
    if (st.mine.options) {
      const call = st.mine.options.find((o) => o.n === 2);
      assert.ok(call && !call.disabled, 'check/call is always available');
      bridge.inject('streamer: !2');
      moves++;
    }
    if (moves >= 6) break;
  }
  assert.ok(checked > 3 && moves >= 3, `checked ${checked} snapshots, made ${moves} moves`);
  assert.equal(s.dockState().streamerSeat, s.seats.findIndex((x) => x.occupant?.user?.name === 'streamer') + 1);
  s.stop();
  assert.equal(s.dockState().mine, null);
});

test('dock state: lobby snapshot lists seats, placeholders and games', async () => {
  const { s, bridge } = setup();
  assert.equal(s.dockState().phase, 'menu');
  assert.deepEqual(s.dockState().games.map((g) => g.id), ['ludo']);
  await s.openLobby('ludo');
  bridge.inject('@mod: !bg seat 1 Zed');
  const st = s.dockState();
  assert.equal(st.seats.length, ludoManifest.seats.length);
  assert.deepEqual(st.seats[0].user, { login: 'zed', name: 'Zed', pending: true });
  assert.equal(st.seats[0].n, 1);
  assert.doesNotThrow(() => JSON.stringify(st));
});

test('node bridge: private screen only for the streamer while a dock is open', () => {
  const b = new NodeBridge({});
  b.login = 'danvibes';
  assert.equal(b.capabilities.privateView, false);
  assert.equal(b.privateViewFor({ isBroadcaster: true }), false);
  b.docks = 1;
  assert.equal(b.privateViewFor({ isBroadcaster: true }), true);
  assert.equal(b.privateViewFor({ login: 'DanVibes' }), true, 'a placeholder with the streamer\'s login');
  assert.equal(b.privateViewFor({ login: 'viewer' }), false);
});

// ---------------- companion server ----------------

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => ok({ status: res.statusCode, body: data }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

// An open event stream that collects events.
function stream(port, path) {
  const events = [];
  let buf = '';
  let resRef;
  const ready = new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      resRef = res;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (ev) events.push({ event: ev, data: JSON.parse(data) });
        }
      });
      ok();
    });
    req.on('error', fail);
    req.end();
  });
  return { events, ready, close: () => resRef?.destroy(), wait: async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('event not received');
  } };
}

test('companion server: relays dock state to the dock only, and dock commands to the overlay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-dock-'));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoCheck: false, openPanel: false }));
  process.env.BOARDGAMES_DATA = dir;
  const { startServer } = await import('../app/server.mjs');
  const log = console.log; console.log = () => {};
  const port = 20000 + Math.floor(Math.random() * 20000);
  const app = await startServer({ port, openPanel: false }).finally(() => { console.log = log; });
  const H = { 'X-BoardGames': '1', 'Content-Type': 'application/json' };
  const open = [];
  try {
    assert.match((await http(port, '/dock/')).body, /Streamer dock/);
    assert.equal((await http(port, '/dock/dock.js')).status, 200);

    // no overlay open yet
    assert.equal((await http(port, '/api/dock/command', { method: 'POST', headers: H, body: '{"text":"!bg start"}' })).status, 409);
    assert.equal((await http(port, '/api/dock/command', { method: 'POST', body: '{"text":"!bg start"}' })).status, 403, 'needs the header');
    assert.equal((await http(port, '/api/dock/state', { method: 'POST', body: '{}' })).status, 403, 'needs the header');

    const overlay = stream(port, '/api/events'); open.push(overlay);
    await overlay.ready;
    await overlay.wait((e) => e.event === 'dock' && e.data.connected === 0);

    const dock = stream(port, '/api/dock/events'); open.push(dock);
    await dock.ready;
    await overlay.wait((e) => e.event === 'dock' && e.data.connected === 1);
    const hello = await dock.wait((e) => e.event === 'hello');
    assert.equal(hello.data.overlays, 1);

    const secret = { phase: 'playing', mine: { private: { cards: [{ text: 'A♠' }] } } };
    await http(port, '/api/dock/state', { method: 'POST', headers: H, body: JSON.stringify(secret) });
    assert.deepEqual((await dock.wait((e) => e.event === 'state')).data, secret);
    assert.ok(!overlay.events.some((e) => JSON.stringify(e.data).includes('A♠')), 'the private snapshot never goes to the overlay/panel stream');

    // a dock opened later gets the last snapshot right away
    const late = stream(port, '/api/dock/events'); open.push(late);
    await late.ready;
    assert.deepEqual((await late.wait((e) => e.event === 'state')).data, secret);

    assert.equal((await http(port, '/api/dock/command', { method: 'POST', headers: H, body: JSON.stringify({ text: '!bg kick 2' }) })).status, 200);
    const cmd = await overlay.wait((e) => e.event === 'dockCommand');
    assert.equal(cmd.data.text, '!bg kick 2');
    assert.equal(cmd.data.user.isBroadcaster, true);
    assert.equal((await http(port, '/api/dock/command', { method: 'POST', headers: H, body: JSON.stringify({ text: 'a\nb' }) })).status, 400);
    assert.equal((await http(port, '/api/dock/command', { method: 'POST', headers: H, body: JSON.stringify({ text: 'x'.repeat(300) }) })).status, 400);

    late.close(); dock.close();
    await overlay.wait((e) => e.event === 'dock' && e.data.connected === 0 && overlay.events.indexOf(e) > 2);
  } finally {
    for (const s of open) s.close();
    app.twitch.close();
    await app.store.flush();
    app.server.closeAllConnections?.();
    app.server.close();
  }
});
