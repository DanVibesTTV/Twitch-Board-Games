// Stream sessions end to end in Node: a real session server (fake Twitch), the streamer's
// overlay Session hosting through RelayHost + LanHost (stream mode), and viewers' phones as
// follower Sessions through RelayClient + LanClient — Texas Hold 'em with private cards,
// a phone that drops and comes back, and an open game (Ludo) kept in lockstep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../core/session.js';
import { createRegistry } from '../core/registry.js';
import { DevBridge } from '../bridges/dev.js';
import { LocalBridge } from '../bridges/local.js';
import { LanHost, LanClient } from '../net/lan.js';
import { RelayHost, RelayClient } from '../net/relay.js';
import { startSessionServer } from '../app/session-server.mjs';
import * as holdem from '../games/holdem/logic.js';
import * as ludo from '../games/ludo/logic.js';

const load = (id) => JSON.parse(readFileSync(new URL(`../games/${id}/manifest.json`, import.meta.url)));
const registry = () => createRegistry([load('holdem'), load('ludo')], async (id) => (id === 'holdem' ? holdem : ludo));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(10); }
  throw new Error(`timed out waiting for ${what}`);
}

const USERS = {
  'tok-streamer-000': { user_id: '100', login: 'danvibes', display: 'DanVibes' },
  'tok-alice-000000': { user_id: '201', login: 'alice', display: 'Alice' },
  'tok-bob-00000000': { user_id: '202', login: 'bob', display: 'Bob' },
};
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const fakeTwitch = async (url, init = {}) => {
  const v = USERS[(init.headers?.Authorization ?? '').replace(/^(OAuth|Bearer) /, '')];
  if (String(url).endsWith('/validate')) return v ? reply(200, { client_id: 'c', login: v.login, user_id: v.user_id, expires_in: 9999 }) : reply(401, {});
  if (String(url).includes('/helix/users')) return reply(200, { data: v ? [{ display_name: v.display }] : [] });
  return reply(404, {});
};

const config = { afterGame: 'menu', predictions: false, botDelayMs: 5, autoSingleMoveMs: 5, turnSeconds: 600, lobbySeconds: 600, overSeconds: 0.05 };

async function setup() {
  const server = await startSessionServer({ port: 0, fetch: fakeTwitch, log: {} });
  const url = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${url}/api/sessions`, { method: 'POST', headers: { Authorization: 'OAuth tok-streamer-000' } }).then((r) => r.json());

  // The streamer's overlay: chat bridge whose private screens are the phones (like bridges/node.js).
  const bridge = new DevBridge();
  bridge.sendChat = async () => {};
  bridge.prediction = null;
  bridge.phoneUsers = new Set();
  bridge.login = 'danvibes';
  bridge.streamLive = true;
  bridge.capabilities = { ...bridge.capabilities, privateView: true };
  bridge.privateViewFor = (u) => bridge.phoneUsers.has(u.id);
  const overlay = new Session({ bridge, registry: registry(), config });
  const transport = new RelayHost({ server: url, session: opened.session, key: opened.key, retryMs: [50] });
  const lanHost = new LanHost({
    session: overlay, transport, stream: true, hostName: 'DanVibes', appVersion: '0.16.0', graceMs: 400,
    onChange: () => { bridge.phoneUsers = new Set([...lanHost.players.map((u) => u.id), ...lanHost.away.keys()]); },
  });
  await lanHost.start();
  const streamer = (text) => bridge.emit('chat', { platform: 'dock', text, user: { id: '100', login: 'danvibes', name: 'DanVibes', isBroadcaster: true, isMod: true } });

  const phones = [];
  async function phone(token, id, name, version = '0.16.3') {
    const pb = new LocalBridge({ playerName: name, playerId: id });
    const s = new Session({ bridge: pb, registry: registry(), follower: true });
    const t = new RelayClient({ server: url, getToken: async () => token, retryMs: [50, 100] });
    const events = [];
    const client = new LanClient({ session: s, transport: t, user: pb.user, appVersion: version, onChange: (c) => events.push(c) });
    const got = [];
    t.on('message', ({ data }) => got.push(JSON.parse(data)));
    const info = await client.join('danvibes');
    const p = { s, t, client, events, got, info, tap: (text) => client.send(text) };
    phones.push(p);
    return p;
  }
  const close = async () => {
    for (const p of phones) await p.client.leave().catch(() => {});
    await lanHost.stop();
    overlay.toMenu?.();
    await server.close();
  };
  return { server, url, overlay, bridge, lanHost, transport, streamer, phone, close };
}

test('stream session: viewers join Hold\'em from their phones and each sees only their own cards', async () => {
  const env = await setup();
  try {
    const alice = await env.phone('tok-alice-000000', '201', 'Alice');
    const bob = await env.phone('tok-bob-00000000', '202', 'Bob');
    assert.deepEqual(alice.info.user, { id: '201', login: 'alice', name: 'Alice' });
    await until(() => env.lanHost.players.length === 2, 4000, 'both phones');
    assert.deepEqual(env.lanHost.players.map((u) => u.name).sort(), ['Alice', 'Bob']);

    env.streamer('!bg play holdem');
    await until(() => alice.s.phase === 'lobby' && bob.s.phase === 'lobby', 4000, 'phones in the lobby');
    assert.equal(env.overlay.seats.filter((x) => x.occupant?.type === 'human').length, 0, 'nobody is seated automatically');

    // a chat viewer without the app is turned away; phone viewers tap Join
    env.bridge.emit('chat', { platform: 'twitch', text: '!join', user: { id: '300', login: 'chatter', name: 'Chatter' } });
    assert.equal(env.overlay.seats.filter((x) => x.occupant?.type === 'human').length, 0);
    alice.tap('!join');
    bob.tap('!join');
    await until(() => env.overlay.seats.filter((x) => x.occupant?.type === 'human').length === 2, 4000, 'two seats');
    const seatOf = (id) => env.overlay.seats.findIndex((x) => x.occupant?.user?.id === id);
    assert.equal(env.overlay.seats[seatOf('201')].occupant.user.name, 'Alice', 'the seat carries the Twitch-checked name');

    env.streamer('!bg bots 3');
    env.streamer('!bg start');
    await until(() => alice.s.phase === 'playing' && bob.s.phase === 'playing', 6000, 'game on the phones');

    // Play: phones tap check/call whenever it's their turn; compare views after every update.
    let checked = 0;
    for (let i = 0; i < 300 && checked < 25 && env.overlay.phase === 'playing'; i++) {
      await wait(15);
      for (const [p, id] of [[alice, '201'], [bob, '202']]) {
        const g = env.overlay.activeSeatIdx.indexOf(seatOf(id));
        if (g < 0 || !p.s.game?.state) continue;
        const truth = env.overlay.game.viewFor(g);
        const mine = p.s.game.state;
        if (mine.hand !== truth.hand || mine.street !== truth.street) continue;
        assert.deepEqual(mine.players[g].cards, truth.players[g].cards, 'own cards match the host');
        mine.players.forEach((pl, o) => {
          if (o !== g && !env.overlay.game.state.players[o].shown) assert.ok(pl.cards.every((c) => c === -1), 'other players\' cards stay hidden');
        });
        checked++;
        const d = env.overlay.decision;
        if (d?.seat === g && p.tapped !== d) { p.tapped = d; p.tap('!2'); }
      }
    }
    assert.ok(checked >= 10, `compared ${checked} views`);
    // nothing a phone received ever held another player's hole cards
    const theirs = (p, other) => p.got.filter((m) => m.t === 'hstart' || m.t === 'hupdate').some((m) => {
      const v = m.spec?.view ?? m.view;
      const o = env.overlay.activeSeatIdx.indexOf(seatOf(other));
      return v?.players?.[o]?.cards?.some((c) => c >= 0) && !v.players[o].shown;
    });
    assert.equal(theirs(alice, '202'), false);
    assert.equal(theirs(bob, '201'), false);
  } finally {
    await env.close();
  }
});

test('stream session: a phone that drops keeps its seat and gets its cards back', async () => {
  const env = await setup();
  try {
    const alice = await env.phone('tok-alice-000000', '201', 'Alice');
    await until(() => env.lanHost.players.length === 1);
    env.streamer('!bg play holdem');
    await until(() => alice.s.phase === 'lobby');
    alice.tap('!join');
    await until(() => env.overlay.seats.some((x) => x.occupant?.user?.id === '201'));
    env.streamer('!bg bots 2');
    env.streamer('!bg start');
    await until(() => alice.s.phase === 'playing', 6000, 'playing');

    // the phone's connection breaks (network switch): the transport reconnects by itself
    alice.got.length = 0;
    alice.t.ws.close(4999, 'network changed');
    await until(() => alice.got.some((m) => m.t === 'hstart'), 4000, 'cards resent after the reconnect');
    assert.ok(env.overlay.seats.some((x) => x.occupant?.type === 'human' && x.occupant.user.id === '201'), 'still seated');
    const g = env.overlay.activeSeatIdx.indexOf(env.overlay.seats.findIndex((x) => x.occupant?.user?.id === '201'));
    const resent = alice.got.find((m) => m.t === 'hstart').spec.view;
    assert.equal(resent.you, g);
    assert.deepEqual(resent.players[g].cards, env.overlay.game.viewFor(g).players[g].cards);

    // gone for good: after the grace period a bot takes over the seat
    await alice.client.leave();
    await until(() => env.overlay.seats.find((x) => x.occupant?.replaced === 'Alice'), 3000, 'bot takes over');
  } finally {
    await env.close();
  }
});

test('stream session: an open game (Ludo) stays in lockstep on the phone; versions must match up to the patch number', async () => {
  const env = await setup();
  try {
    const old = await env.phone('tok-bob-00000000', '202', 'Bob', '0.15.0');
    await until(() => old.events.some((e) => e.error), 4000, 'refused');
    assert.match(old.events.find((e) => e.error).error, /different versions/);

    const alice = await env.phone('tok-alice-000000', '201', 'Alice');
    await until(() => env.lanHost.players.length === 1);
    env.streamer('!bg play ludo');
    await until(() => alice.s.phase === 'lobby');
    alice.tap('!join');
    await until(() => env.overlay.seats.some((x) => x.occupant?.user?.id === '201'));
    env.streamer('!bg bots 2');
    env.streamer('!bg start');
    await until(() => alice.s.phase === 'playing', 6000, 'playing');
    let tapped = null;
    for (let i = 0; i < 30; i++) {
      await wait(15);
      const d = env.overlay.decision;
      const g = env.overlay.activeSeatIdx.indexOf(env.overlay.seats.findIndex((x) => x.occupant?.user?.id === '201'));
      if (d?.seat === g && d !== tapped) { tapped = d; alice.tap('!1'); } // once per turn, like a person
    }
    // (fast bots and no animations: a whole game takes a few seconds, so compare mid-game)
    await until(() => env.overlay.phase === 'playing' && alice.s.game && JSON.stringify(alice.s.game.state) === JSON.stringify(env.overlay.game.state), 3000, 'same board on the phone');
    assert.ok(alice.got.filter((m) => m.t === 'apply').length > 5, 'moves arrived as lockstep applies');
  } finally {
    await env.close();
  }
});
