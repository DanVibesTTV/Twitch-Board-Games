// Companion app "Phone players" (app/phone-sessions.mjs): opens the streamer's session on the
// session server with their Twitch login, refreshes an expired token once, retries on errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PhoneSessions, DEFAULT_SESSION_SERVER } from '../app/phone-sessions.mjs';

function fakes({ token = 'tok-1', replies = [] } = {}) {
  const store = { settings: {}, saveSettings: async (patch) => Object.assign(store.settings, patch) };
  const twitch = new EventEmitter();
  twitch.main = { auth: token ? { access_token: token } : null, refresh: async () => { twitch.main.auth.access_token = 'tok-2'; } };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const r = replies.shift() ?? { status: 200, body: { session: 'danvibes', name: 'DanVibes', key: 'k1' } };
    if (r.throw) throw new TypeError('fetch failed');
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  const log = { log() {}, warn() {} };
  return { store, twitch, fetch, calls, log };
}

test('phone sessions: off by default; turning on opens the session', async () => {
  const f = fakes();
  const p = new PhoneSessions(f);
  assert.deepEqual(p.settings, { enabled: false, server: DEFAULT_SESSION_SERVER });
  const seen = [];
  p.on('change', (st) => seen.push(st.state));
  await p.configure({ enabled: true, server: 'https://games.example.com/' });
  assert.deepEqual(f.store.settings.phones, { enabled: true, server: 'https://games.example.com' });
  assert.equal(f.calls[0].url, 'https://games.example.com/api/sessions');
  assert.equal(f.calls[0].auth, 'OAuth tok-1');
  assert.deepEqual(seen, ['opening', 'open']);
  assert.equal(p.public.key, 'k1');
  assert.equal(p.public.session, 'danvibes');

  await p.configure({ enabled: false });
  assert.equal(p.public.state, 'off');
  assert.equal(p.public.key, null);
  await assert.rejects(p.configure({ server: 'ftp://nope' }), /https/);
  p.close();
});

test('phone sessions: refreshes an expired token once; waits for login; retries when unreachable', async () => {
  const f = fakes({ replies: [{ status: 401, body: { error: 'Twitch login not accepted' } }] });
  f.store.settings.phones = { enabled: true };
  const p = new PhoneSessions(f);
  await p.open();
  assert.deepEqual(f.calls.map((c) => c.auth), ['OAuth tok-1', 'OAuth tok-2']);
  assert.equal(p.public.state, 'open');
  p.close();

  const g = fakes({ token: null });
  g.store.settings.phones = { enabled: true };
  const q = new PhoneSessions(g);
  await q.open();
  assert.equal(q.public.state, 'waiting-login');
  g.twitch.main.auth = { access_token: 'tok-9' };
  g.twitch.emit('state', { state: 'connected' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.public.state, 'open');
  q.close();

  const h = fakes({ replies: [{ throw: true }] });
  h.store.settings.phones = { enabled: true, server: 'https://down.example.com' };
  const r = new PhoneSessions(h);
  await r.open();
  assert.equal(r.public.state, 'error');
  assert.match(r.public.detail, /can't reach https:\/\/down\.example\.com/);
  r.close();
});
