// Session server (app/session-server.mjs): Twitch checks, sessions, the host/phone relay, the
// device login proxy, and the small WebSocket server (app/ws.mjs) underneath. Twitch is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSessionServer } from '../app/session-server.mjs';

const USERS = {
  'tok-streamer-000': { user_id: '100', login: 'danvibes', display: 'DanVibes' },
  'tok-alice-000000': { user_id: '201', login: 'alice', display: 'Alice' },
  'tok-bob-00000000': { user_id: '202', login: 'bob', display: 'Bob_' },
  'tok-new-00000000': { user_id: '203', login: 'newbie', display: 'Newbie' },
};

function fakeTwitch() {
  const calls = [];
  let polls = 0;
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const auth = init.headers?.Authorization ?? '';
    const token = auth.replace(/^(OAuth|Bearer) /, '');
    if (u.endsWith('/oauth2/validate')) {
      const v = USERS[token];
      return v ? reply(200, { client_id: 'cid', login: v.login, user_id: v.user_id, expires_in: 3600 }) : reply(401, { message: 'invalid access token' });
    }
    if (u.includes('/helix/users')) {
      const v = USERS[token];
      return reply(200, { data: v ? [{ display_name: v.display }] : [] });
    }
    const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    if (u.endsWith('/oauth2/device')) {
      if (body.scopes === '') return reply(400, { message: 'missing scope' }); // Twitch wants a scope
      return reply(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate', interval: 5, expires_in: 1800, scopes: body.scopes });
    }
    if (u.endsWith('/oauth2/token')) {
      if (body.grant_type === 'refresh_token') return body.refresh_token === 'ref-1' ? reply(200, { access_token: 'tok-new-00000000', refresh_token: 'ref-2', expires_in: 14000 }) : reply(400, { message: 'Invalid refresh token' });
      if (++polls < 2) return reply(400, { message: 'authorization_pending' });
      return reply(200, { access_token: 'tok-new-00000000', refresh_token: 'ref-1', expires_in: 14000 });
    }
    return reply(404, {});
  };
  return { fetch, calls };
}

async function start() {
  const tw = fakeTwitch();
  const app = await startSessionServer({ port: 0, fetch: tw.fetch, log: { log() {}, warn() {}, error() {} } });
  const base = `http://127.0.0.1:${app.port}`;
  return { app, tw, base, ws: base.replace('http', 'ws') };
}

const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

// A WebSocket that collects messages; next(pred) waits for one.
function socket(url) {
  const ws = new WebSocket(url);
  const got = [];
  let closed = null;
  ws.onmessage = (e) => got.push(e.data);
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; };
  const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error(`timed out; got ${JSON.stringify(got)} closed ${JSON.stringify(closed)}`);
  };
  return {
    ws, got,
    open: () => new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('could not connect')); }),
    send: (v) => ws.send(typeof v === 'string' ? v : JSON.stringify(v)),
    next: (pred = () => true) => until(() => { const i = got.findIndex((t) => { try { return pred(JSON.parse(t), t); } catch { return pred(null, t); } }); return i >= 0 ? JSON.parse(got.splice(i, 1)[0]) : null; }),
    raw: (pred) => until(() => { const i = got.findIndex(pred); return i >= 0 ? got.splice(i, 1)[0] : null; }),
    closed: () => until(() => closed),
    close: () => ws.close(),
  };
}

test('session server: streamer opens a session, phones log in, messages pass both ways', async () => {
  const { app, base, ws } = await start();
  try {
    assert.equal((await post(base, '/api/sessions', {}, { Authorization: 'OAuth nope-nope-nope' })).status, 401);
    const opened = await post(base, '/api/sessions', {}, { Authorization: 'OAuth tok-streamer-000' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.session, 'danvibes');
    assert.equal(opened.body.name, 'DanVibes');
    assert.match(opened.body.key, /^[0-9a-f]{48}$/);

    let info = await fetch(`${base}/api/sessions/DanVibes`).then((r) => r.json());
    assert.deepEqual(info, { open: true, live: false, name: 'DanVibes', players: 0 });

    // wrong key → refused
    const bad = socket(`${ws}/ws/host?session=danvibes&key=wrong`);
    await assert.rejects(bad.open());

    const host = socket(`${ws}/ws/host?session=danvibes&key=${opened.body.key}`);
    await host.open();
    assert.deepEqual(await host.next((m) => m.t === 'ready'), { t: 'ready', session: 'danvibes', name: 'DanVibes' });

    const alice = socket(`${ws}/ws/play?session=danvibes`);
    await alice.open();
    alice.send('{"t":"hello"}'); // before logging in → thrown out
    assert.equal((await alice.closed()).code, 4001);

    const a = socket(`${ws}/ws/play?session=danvibes`);
    await a.open();
    a.send({ t: 'auth', token: 'tok-alice-000000' });
    const ok = await a.next((m) => m.t === 'auth-ok');
    assert.deepEqual(ok.user, { id: '201', login: 'alice', name: 'Alice' });
    assert.equal(ok.live, true);
    const join = await host.next((m) => m.t === 'join');
    assert.deepEqual(join.user, ok.user);

    a.send('{"t":"hello","protocol":1}');
    const msg = await host.next((m) => m.t === 'msg');
    assert.equal(msg.peer, join.peer);
    assert.equal(msg.data, '{"t":"hello","protocol":1}', 'phone messages reach the host unchanged');

    host.send({ t: 'send', peer: join.peer, data: '{"t":"welcome","hostName":"DanVibes"}' });
    assert.equal(await a.raw((t) => t.includes('welcome')), '{"t":"welcome","hostName":"DanVibes"}');

    // a big host message (lockstep start specs can be large) goes through
    const big = JSON.stringify({ t: 'start', spec: { pad: 'x'.repeat(200_000) } });
    host.send({ t: 'send', peer: join.peer, data: big });
    assert.equal((await a.raw((t) => t.startsWith('{"t":"start"'))).length, big.length);

    info = await fetch(`${base}/api/sessions/danvibes`).then((r) => r.json());
    assert.equal(info.players, 1);
    assert.equal(info.live, true);

    // the overlay reloads: phones hear about it, stay connected, and are introduced again with their hello
    host.close();
    await a.next((m) => m.t === 'host-gone');
    const host2 = socket(`${ws}/ws/host?session=danvibes&key=${opened.body.key}`);
    await host2.open();
    await host2.next((m) => m.t === 'ready');
    const again = await host2.next((m) => m.t === 'join');
    assert.equal(again.user.login, 'alice');
    assert.equal((await host2.next((m) => m.t === 'msg')).data, '{"t":"hello","protocol":1}');
    await a.next((m) => m.t === 'host-back');

    // same account on another phone: the old connection is closed
    const a2 = socket(`${ws}/ws/play?session=danvibes`);
    await a2.open();
    a2.send({ t: 'auth', token: 'tok-alice-000000' });
    await a2.next((m) => m.t === 'auth-ok');
    assert.equal((await a.closed()).code, 4002);
    const left = await host2.next((m) => m.t === 'leave');
    assert.equal(left.peer, again.peer);
    const j2 = await host2.next((m) => m.t === 'join');

    // the host can remove a phone
    host2.send({ t: 'kick', peer: j2.peer, reason: 'bye' });
    assert.deepEqual(await a2.closed(), { code: 4003, reason: 'bye' });
    await host2.next((m) => m.t === 'leave');

    // a new session key throws the old host out
    const reopened = await post(base, '/api/sessions', {}, { Authorization: 'OAuth tok-streamer-000' });
    assert.notEqual(reopened.body.key, opened.body.key);
    assert.equal((await host2.closed()).code, 4000);

    // no session for this streamer → phones can't connect
    const nobody = socket(`${ws}/ws/play?session=someone_else`);
    await assert.rejects(nobody.open());
    assert.deepEqual(await fetch(`${base}/api/sessions/someone_else`).then((r) => r.json()), { open: false, live: false, name: null, players: 0 });
  } finally {
    await app.close();
  }
});

test('session server: bad logins, floods and oversized messages are refused', async () => {
  const { app, base, ws } = await start();
  try {
    const { body } = await post(base, '/api/sessions', {}, { Authorization: 'OAuth tok-streamer-000' });
    const host = socket(`${ws}/ws/host?session=danvibes&key=${body.key}`);
    await host.open();

    const x = socket(`${ws}/ws/play?session=danvibes`);
    await x.open();
    x.send({ t: 'auth', token: 'not-a-real-token' });
    assert.equal((await x.next((m) => m.t === 'auth-fail')).t, 'auth-fail');
    assert.equal((await x.closed()).code, 4001);

    const b = socket(`${ws}/ws/play?session=danvibes`);
    await b.open();
    b.send({ t: 'auth', token: 'tok-bob-00000000' });
    await b.next((m) => m.t === 'auth-ok');
    for (let i = 0; i < 40; i++) b.send(`{"t":"cmd","text":"!${i}"}`);
    assert.equal((await b.closed()).code, 4005);

    const c = socket(`${ws}/ws/play?session=danvibes`);
    await c.open();
    c.send({ t: 'auth', token: 'tok-bob-00000000' });
    await c.next((m) => m.t === 'auth-ok');
    c.send('x'.repeat(70 * 1024));
    assert.equal((await c.closed()).code, 1009);
  } finally {
    await app.close();
  }
});

test('session server: device login for the app, with scope fallback and refresh', async () => {
  const { app, tw, base } = await start();
  try {
    const startRes = await post(base, '/api/login/start');
    assert.equal(startRes.status, 200);
    assert.equal(startRes.body.user_code, 'ABCD-EFGH');
    assert.equal(startRes.body.verification_uri, 'https://www.twitch.tv/activate');
    assert.equal(tw.calls.filter((u) => u.endsWith('/device')).length, 2, 'retried with a scope');

    assert.deepEqual((await post(base, '/api/login/poll', { device_code: 'dev-1' })).body, { pending: true });
    const done = await post(base, '/api/login/poll', { device_code: 'dev-1' });
    assert.equal(done.body.access_token, 'tok-new-00000000');
    assert.deepEqual(done.body.user, { id: '203', login: 'newbie', name: 'Newbie' });

    const refreshed = await post(base, '/api/login/refresh', { refresh_token: 'ref-1' });
    assert.equal(refreshed.body.refresh_token, 'ref-2');
    assert.equal((await post(base, '/api/login/refresh', { refresh_token: 'old' })).status, 400);
    assert.equal((await post(base, '/api/login/poll', {})).status, 400);

    // CORS for the app's WebView
    const pre = await fetch(`${base}/api/login/start`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(await fetch(`${base}/`).then((r) => r.text()), /session server/);
  } finally {
    await app.close();
  }
});
