import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarGz, compareVersions, Updater } from '../app/updater.mjs';
import { Twitch, normalizeChat, uniqueTitles } from '../app/twitch.mjs';
import { Store, dataDir } from '../app/store.mjs';
import { useCompanionStorage, storage } from '../core/storage.js';

// ---- tiny tar writer for the tests (ustar, with a pax header for long names) ----
function tarEntry(name, data, type = '0') {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function tarGz(files, top = 'Owner-Repo-abc123') {
  const parts = [tarEntry('pax_global_header', '52 comment=abc123\n', 'g'), tarEntry(`${top}/`, '', '5')];
  for (const [name, data] of Object.entries(files)) {
    const full = `${top}/${name}`;
    if (full.length > 100) {
      const rec = ` path=${full}\n`;
      let len = rec.length + 2; len = String(len + String(len).length - 2).length + rec.length;
      parts.push(tarEntry('PaxHeader', `${len}${rec}`, 'x'));
    }
    parts.push(tarEntry(full, data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('tar.gz reader: strips the top folder, keeps long names, skips folders and pax headers', () => {
  const long = `games/${'x'.repeat(120)}/file.js`;
  const files = extractTarGz(tarGz({ 'index.html': '<html>', 'app/companion.mjs': 'x', [long]: 'long' }));
  assert.deepEqual([...files.keys()].sort(), ['app/companion.mjs', 'index.html', long].sort());
  assert.equal(files.get(long).toString(), 'long');
});

test('version compare', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.8.0', '0.8.1'), -1);
});

test('data folder per OS', () => {
  assert.equal(dataDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\a\\AppData\\Roaming', 'TwitchBoardGames'));
  assert.equal(dataDir({ BOARDGAMES_DATA: '/x' }, 'linux'), '/x');
});

async function tempStore() {
  return new Store(await mkdtemp(join(tmpdir(), 'bg-store-'))).open();
}

test('updater: checks releases, installs files, keeps edited sounds.json, removes files dropped upstream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bg-root-'));
  await mkdir(join(root, 'sounds'));
  await writeFile(join(root, 'sounds/sounds.json'), '{"dice":"my.mp3"}');
  await writeFile(join(root, 'mine.txt'), 'streamer file');
  const store = await tempStore();
  store.set('boardgames.stats.v1', '{"x":1}');
  await writeFile(join(store.dir, 'installed-files.json'), JSON.stringify(['old.js', 'mine.txt']));
  await writeFile(join(root, 'old.js'), 'old');

  const pkg = (v) => JSON.stringify({ version: v });
  const tarball = tarGz({ 'index.html': 'new', 'package.json': pkg('0.9.0'), 'app/companion.mjs': 'c', 'sounds/sounds.json': '{}', 'mine.txt': 'upstream', '.github/workflows/x.yml': 'ci' });
  const fetch = async (url) => {
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify({ tag_name: 'v0.9.0', name: 'v0.9.0', body: 'notes', html_url: 'h', tarball_url: 'https://t/tar' }));
    }
    if (url === 'https://t/tar') return new Response(tarball);
    return new Response('nope', { status: 404 });
  };
  const u = new Updater({ root, store, version: '0.8.0', fetch, log: { log() {} } });
  const st = await u.check();
  assert.equal(st.available, true);
  assert.equal(st.latest.notes, 'notes');
  const r = await u.install();
  assert.equal(r.version, '0.9.0');
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), 'new');
  assert.equal(await readFile(join(root, 'sounds/sounds.json'), 'utf8'), '{"dice":"my.mp3"}', 'edited sounds.json kept');
  await assert.rejects(stat(join(root, 'old.js')), 'file removed upstream is deleted');
  await assert.rejects(stat(join(root, '.github')), '.github is not installed');
  assert.ok((await readdir(store.files.backups)).includes('data-before-v0.8.0.json'), 'stats backed up first');
});

test('updater: refuses git clones and downloads that are not this project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bg-root-'));
  const store = await tempStore();
  const fetch = async (url) => url.endsWith('/latest')
    ? new Response(JSON.stringify({ tag_name: 'v1.0.0', tarball_url: 'https://t/tar' }))
    : new Response(tarGz({ 'readme.md': 'something else' }));
  const u = new Updater({ root, store, version: '0.8.0', fetch });
  await u.check();
  await assert.rejects(u.install(), /doesn't look like/);
  await mkdir(join(root, '.git'));
  await assert.rejects(u.install(), /git pull/);
});

test('chat events are normalized; mods and broadcaster recognized', () => {
  const ev = { chatter_user_id: '7', chatter_user_login: 'modguy', chatter_user_name: 'ModGuy', message: { text: '!bg start' }, badges: [{ set_id: 'moderator' }] };
  assert.deepEqual(normalizeChat(ev, '1').user, { id: '7', login: 'modguy', name: 'ModGuy', isBroadcaster: false, isMod: true });
  assert.equal(normalizeChat({ ...ev, chatter_user_id: '1', badges: [] }, '1').user.isBroadcaster, true);
});

test('prediction outcome titles fit Twitch limits and stay unique', () => {
  const t = uniqueTitles(['A very very long player name here', 'A very very long player name here', '']);
  assert.ok(t.every((x) => x.length <= 25));
  assert.equal(new Set(t).size, 3);
  assert.equal(t[2], 'Seat 3');
});

class FakeWS {
  static last = null;
  constructor(url) { this.url = url; FakeWS.last = this; }
  close() { this.closed = true; }
  receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
}

test('twitch: validates, subscribes to chat on welcome, emits chat, drops own echoes, runs predictions', async () => {
  const store = await tempStore();
  await store.saveAuth({ access_token: 'tok', refresh_token: 'ref' });
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : Object.fromEntries(opts.body)) : null });
    if (url.endsWith('/oauth2/validate')) return new Response(JSON.stringify({ login: 'dan', user_id: '1', scopes: ['user:read:chat', 'user:write:chat', 'channel:manage:predictions'] }));
    if (url.endsWith('/chat/messages')) return new Response(JSON.stringify({ data: [{ message_id: 'm1', is_sent: true }] }));
    if (url.endsWith('/predictions') && opts.method === 'POST') return new Response(JSON.stringify({ data: [{ id: 'p1', outcomes: [{ id: 'o1', title: 'a' }, { id: 'o2', title: 'b' }] }] }));
    return new Response('{}');
  };
  const t = new Twitch({ store, clientId: 'cid', fetch, WebSocketImpl: FakeWS, log: { warn() {}, error() {} } });
  const chats = [];
  t.on('chat', (c) => chats.push(c));
  await t.start();
  clearInterval(t.validateTimer);
  FakeWS.last.receive({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'S1', keepalive_timeout_seconds: 30 } } });
  await new Promise((r) => setTimeout(r, 10));
  const sub = calls.find((c) => c.url.endsWith('/eventsub/subscriptions'));
  assert.equal(sub.body.transport.session_id, 'S1');
  assert.equal(t.state.state, 'connected');

  const note = (id, user, text) => FakeWS.last.receive({ metadata: { message_type: 'notification', subscription_type: 'channel.chat.message' },
    payload: { event: { message_id: id, chatter_user_id: user, chatter_user_login: 'u' + user, message: { text }, badges: [] } } });
  note('x1', '5', '!join');
  await t.sendChat('Lobby open, type !join');
  note('m1', '1', 'Lobby open, type !join');   // our own message coming back
  note('x2', '1', '!bg start');                 // the streamer typing
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(chats.map((c) => c.text), ['!join', '!bg start']);

  await t.predict('create', { title: 'Who wins?', outcomes: ['a', 'b'], seconds: 10 });
  assert.equal(calls.at(-1).body.prediction_window, 30, 'window raised to the Twitch minimum');
  await t.predict('resolve', { index: 1 });
  assert.deepEqual([calls.at(-1).method, calls.at(-1).body.status, calls.at(-1).body.winning_outcome_id], ['PATCH', 'RESOLVED', 'o2']);
  t.close();
});

test('twitch: an expired token is refreshed once and the new refresh token saved', async () => {
  const store = await tempStore();
  await store.saveAuth({ access_token: 'old', refresh_token: 'r1' });
  let validates = 0;
  const fetch = async (url, opts = {}) => {
    if (url.endsWith('/validate')) return ++validates === 1 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ login: 'dan', user_id: '1', scopes: [] }));
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2' }));
    return new Response('{}');
  };
  const t = new Twitch({ store, clientId: 'cid', fetch, WebSocketImpl: FakeWS, log: { warn() {}, error() {} } });
  await t.start();
  t.close();
  const saved = await store.loadAuth();
  assert.deepEqual([saved.access_token, saved.refresh_token, saved.login], ['new', 'r2', 'dan']);
});

test('store: data saved to file, daily backup made', async () => {
  const store = await tempStore();
  store.set('boardgames.stats.v1', '{"a":1}');
  await store.flush();
  assert.equal(JSON.parse(await readFile(store.files.data, 'utf8'))['boardgames.stats.v1'], '{"a":1}');
  const again = await new Store(store.dir).open();
  assert.equal(again.getAll()['boardgames.stats.v1'], '{"a":1}');
  assert.equal((await readdir(store.files.backups)).filter((n) => /^data-\d/.test(n)).length, 1);
});

test('overlay storage: loads from the companion, copies old browser data over once, writes through', async () => {
  const sent = [];
  const fetch = async (url, opts = {}) => {
    if (opts.method) { sent.push([opts.method, decodeURIComponent(url.split('/api/kv/')[1]), opts.body && JSON.parse(opts.body).value]); return new Response('{}'); }
    return new Response(JSON.stringify({ 'boardgames.trivia.slots': '["general"]' }));
  };
  const localMap = new Map([['boardgames.stats.v1', '{"old":1}'], ['boardgames.trivia.slots', '["stale"]'], ['other', 'x']]);
  const local = { get length() { return localMap.size; }, key: (i) => [...localMap.keys()][i], getItem: (k) => localMap.get(k) ?? null };
  const { migrated } = await useCompanionStorage('', { fetch, local });
  assert.deepEqual(migrated, ['boardgames.stats.v1']);
  assert.equal(storage.getItem('boardgames.trivia.slots'), '["general"]', 'app data wins over the browser');
  assert.equal(storage.getItem('boardgames.stats.v1'), '{"old":1}');
  storage.setItem('boardgames.stats.v1', '{"new":2}');
  assert.deepEqual(sent.at(-1), ['PUT', 'boardgames.stats.v1', '{"new":2}']);
});

test('twitch bot account: posts as the bot, its echoes are ignored, falls back to the streamer, rejects the same account', async () => {
  const store = await tempStore();
  await store.saveAuth({ access_token: 'main', refresh_token: 'r' });
  await store.saveAuth({ access_token: 'bot', refresh_token: 'rb' }, 'bot');
  const posts = [];
  let botBroken = false;
  let botIsMain = false;
  const fetch = async (url, opts = {}) => {
    const token = (opts.headers?.Authorization ?? '').split(' ')[1];
    if (url.endsWith('/validate')) {
      return new Response(JSON.stringify(token === 'bot' && !botIsMain
        ? { login: 'dansbot', user_id: '9', scopes: ['user:write:chat'] }
        : { login: 'dan', user_id: '1', scopes: ['user:read:chat', 'user:write:chat', 'channel:manage:predictions'] }));
    }
    if (url.endsWith('/chat/messages')) {
      const body = JSON.parse(opts.body);
      if (token === 'bot' && botBroken) return new Response(JSON.stringify({ message: 'banned' }), { status: 403 });
      posts.push([token, body.sender_id, body.broadcaster_id]);
      return new Response(JSON.stringify({ data: [{ message_id: `m${posts.length}`, is_sent: true }] }));
    }
    return new Response('{}');
  };
  const t = new Twitch({ store, clientId: 'cid', fetch, WebSocketImpl: FakeWS, log: { warn() {}, error() {} } });
  const chats = [];
  t.on('chat', (c) => chats.push(c.text));
  await t.start();
  assert.equal(t.botState.state, 'connected');
  assert.equal(t.botState.login, 'dansbot');
  FakeWS.last.receive({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'S', keepalive_timeout_seconds: 30 } } });
  await new Promise((r) => setTimeout(r, 10));

  const r = await t.sendChat('Lobby open, type !join');
  assert.equal(r.from, 'dansbot');
  assert.deepEqual(posts.at(-1), ['bot', '9', '1'], 'sent with the bot token, bot as sender, into the streamer channel');
  FakeWS.last.receive({ metadata: { message_type: 'notification', subscription_type: 'channel.chat.message' },
    payload: { event: { message_id: 'm1', chatter_user_id: '9', chatter_user_login: 'dansbot', message: { text: 'Lobby open, type !join' }, badges: [] } } });
  assert.deepEqual(chats, [], 'bot echo dropped');

  botBroken = true;
  const r2 = await t.sendChat('Your turn');
  assert.equal(r2.from, 'dan', 'fell back to the streamer account');
  assert.match(t.botState.detail, /failed/);
  t.close();

  // Logging the bot in with the streaming account is refused.
  botIsMain = true;
  await store.saveAuth({ access_token: 'bot', refresh_token: 'rb' }, 'bot');
  const t2 = new Twitch({ store, clientId: 'cid', fetch, WebSocketImpl: FakeWS, log: { warn() {}, error() {} } });
  await t2.start();
  assert.equal(t2.botState.state, 'none');
  assert.match(t2.botState.detail, /private/);
  assert.equal(await store.loadAuth('bot'), null);
  t2.close();
});
