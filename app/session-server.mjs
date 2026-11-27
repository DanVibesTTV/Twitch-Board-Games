// Stream Board Games session server: lets viewers play a streamer's game from the phone app.
//
//   node app/session-server.mjs [--port 8790] [--host 127.0.0.1]
//   StreamBoardGames.exe --session-server [--port 8790]
//
// It runs somewhere the internet can reach (DanVibes: a mini PC behind a Cloudflare Tunnel,
// https://games.danvibes.net — see docs/SESSION_SERVER.md) and only passes messages along:
//
//   streamer's overlay ──host socket──▶  session server  ◀──player sockets── viewers' phones
//
// The game itself runs in the streamer's overlay (the same LanHost code as same-WiFi play,
// net/lan.js). This server checks everybody's Twitch login, so the overlay knows exactly who
// each phone belongs to, and never looks inside the messages.
//
// HTTP (JSON):
//   GET  /health                         { ok, version, sessions, players }
//   POST /api/sessions                   Authorization: OAuth <streamer token> → { session, name, key }
//                                        (one session per streamer, named by their login; a new
//                                        call replaces the key and disconnects the old host)
//   GET  /api/sessions/<login>           { open, live, name, players }   (for the app's join screen)
//   POST /api/login/start                → { user_code, verification_uri, device_code, interval, expires_in }
//   POST /api/login/poll  {device_code}  → { pending } | { access_token, refresh_token, expires_in, user }
//   POST /api/login/refresh {refresh_token} → same as poll
//   (/api/login/* do the Twitch device login for the app — browsers can't call id.twitch.tv directly.)
//
// WebSockets:
//   /ws/host?session=<login>&key=<key>   the overlay. Server → host: ready {session, name},
//       join {peer, user}, msg {peer, data}, leave {peer}. Host → server: send {peer, data}, kick {peer, reason}.
//   /ws/play?session=<login>             a phone. First message { t: 'auth', token }; then
//       server → phone: auth-ok {user, name, live} | auth-fail {reason}, host-gone, host-back,
//       and after that every other message is the host's own text, passed through unchanged.
//       Phone → server: any text, passed to the host as msg. The phone's first message after
//       auth (its "hello") is kept and replayed to a host that reconnects.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { acceptWebSocket } from './ws.mjs';

const ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const defaultClientId = JSON.parse(readFileSync(new URL('./twitch-app.json', import.meta.url), 'utf8')).clientId;

const LIMITS = {
  playersPerSession: 100,
  messageBytes: 64 * 1024,
  messagesPerSecond: 20,        // per phone
  authMs: 15000,                // a phone must log in this fast
  idleSessionMs: 6 * 3600_000,  // forget sessions whose host is gone this long and nobody waits
};

export async function startSessionServer({
  port = 8790, host = '127.0.0.1', clientId = defaultClientId,
  fetch: fetchFn = globalThis.fetch, log = console, now = () => Date.now(),
} = {}) {
  const sessions = new Map(); // login → session
  const tokenCache = new Map(); // sha256(token) → { user, until }
  let viewerScopes = ''; // Twitch may insist on a scope; then we fall back to a read-only one (see loginStart)
  let nextPeer = 1;

  // ---------- Twitch ----------

  async function whoIs(token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) return null;
    const hash = createHash('sha256').update(token).digest('hex');
    const hit = tokenCache.get(hash);
    if (hit && hit.until > now()) return hit.user;
    const res = await fetchFn(`${ID}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (!res.ok) return null;
    const v = await res.json();
    if (!v.user_id || !v.login) return null;
    let name = v.login;
    try {
      const r = await fetchFn(`${HELIX}/users?id=${encodeURIComponent(v.user_id)}`, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': v.client_id } });
      if (r.ok) name = (await r.json()).data?.[0]?.display_name || name;
    } catch { /* the login will do */ }
    const user = { id: String(v.user_id), login: String(v.login).toLowerCase(), name: String(name).slice(0, 25) };
    tokenCache.set(hash, { user, until: now() + Math.min(10 * 60_000, (v.expires_in ?? 600) * 1000) });
    if (tokenCache.size > 5000) for (const [k, e] of tokenCache) if (e.until <= now()) tokenCache.delete(k);
    return user;
  }

  const form = (o) => new URLSearchParams(o);

  async function loginStart() {
    let res = await fetchFn(`${ID}/device`, { method: 'POST', body: form({ client_id: clientId, scopes: viewerScopes }) });
    if (!res.ok && viewerScopes === '') {
      viewerScopes = 'chat:read';
      res = await fetchFn(`${ID}/device`, { method: 'POST', body: form({ client_id: clientId, scopes: viewerScopes }) });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, body.message || 'Twitch login is unavailable');
    return {
      device_code: body.device_code, user_code: body.user_code,
      verification_uri: body.verification_uri, interval: body.interval ?? 5, expires_in: body.expires_in ?? 1800,
    };
  }

  async function tokenReply(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.message === 'authorization_pending' || body.message === 'slow_down') return { pending: true };
      throw httpError(400, body.message || 'login failed');
    }
    const user = await whoIs(body.access_token);
    if (!user) throw httpError(502, 'Twitch did not accept the new login');
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in, user };
  }

  async function loginPoll(deviceCode) {
    if (typeof deviceCode !== 'string' || !deviceCode) throw httpError(400, 'device_code missing');
    return tokenReply(await fetchFn(`${ID}/token`, {
      method: 'POST',
      body: form({ client_id: clientId, scopes: viewerScopes, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    }));
  }

  async function loginRefresh(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) throw httpError(400, 'refresh_token missing');
    return tokenReply(await fetchFn(`${ID}/token`, { method: 'POST', body: form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }) }));
  }

  // ---------- sessions ----------

  function sessionFor(user) {
    let s = sessions.get(user.login);
    if (!s) {
      s = { login: user.login, name: user.name, key: null, host: null, hostGoneAt: now(), players: new Map() };
      sessions.set(user.login, s);
    }
    s.name = user.name;
    return s;
  }

  const toHost = (s, msg) => s.host?.send(JSON.stringify(msg));
  const toPlayers = (s, msg) => { const t = JSON.stringify(msg); for (const p of s.players.values()) p.ws.send(t); };

  function attachHost(s, ws) {
    if (s.host) s.host.close(4000, 'another overlay took over');
    s.host = ws;
    toHost(s, { t: 'ready', session: s.login, name: s.name });
    // Phones that were already waiting (or stayed through an overlay reload): introduce them again.
    for (const [peer, p] of s.players) {
      toHost(s, { t: 'join', peer, user: p.user });
      if (p.hello) toHost(s, { t: 'msg', peer, data: p.hello });
    }
    toPlayers(s, { t: 'host-back' });
    ws.on('message', (text) => {
      let m;
      try { m = JSON.parse(text); } catch { return; }
      const p = s.players.get(m.peer);
      if (!p) return;
      if (m.t === 'send' && typeof m.data === 'string') p.ws.send(m.data);
      else if (m.t === 'kick') p.ws.close(4003, String(m.reason ?? 'removed by the streamer').slice(0, 100));
    });
    ws.on('close', () => {
      if (s.host !== ws) return;
      s.host = null;
      s.hostGoneAt = now();
      toPlayers(s, { t: 'host-gone' });
    });
  }

  function attachPlayer(s, ws) {
    let peer = null;
    let user = null;
    let rate = { start: now(), count: 0 };
    const authTimer = setTimeout(() => ws.close(4001, 'log in first'), LIMITS.authMs);
    authTimer.unref?.();

    ws.on('message', async (text) => {
      if (!user) {
        if (peer === 'checking') return;
        let m;
        try { m = JSON.parse(text); } catch { return ws.close(4001, 'log in first'); }
        if (m.t !== 'auth') return ws.close(4001, 'log in first');
        peer = 'checking';
        let who = null;
        try { who = await whoIs(m.token); } catch (err) { log.warn?.(`[session] Twitch check failed: ${err.message}`); }
        clearTimeout(authTimer);
        if (!ws.open) return;
        if (!who) { ws.send(JSON.stringify({ t: 'auth-fail', reason: 'Your Twitch login expired — log in again.' })); return ws.close(4001, 'login failed'); }
        if (s.players.size >= LIMITS.playersPerSession) { ws.send(JSON.stringify({ t: 'auth-fail', reason: 'This stream is full.' })); return ws.close(4004, 'full'); }
        // Same account on a second phone: the newer connection wins.
        for (const [id, p] of s.players) if (p.user.id === who.id) p.ws.close(4002, 'You joined from another device.');
        user = who;
        peer = `p${nextPeer++}`;
        s.players.set(peer, { ws, user, hello: null });
        ws.send(JSON.stringify({ t: 'auth-ok', user, name: s.name, live: !!s.host }));
        toHost(s, { t: 'join', peer, user });
        return;
      }
      // Simple flood guard per phone.
      if (now() - rate.start > 1000) rate = { start: now(), count: 0 };
      if (++rate.count > LIMITS.messagesPerSecond) return ws.close(4005, 'too many messages');
      const p = s.players.get(peer);
      if (p && !p.hello) p.hello = text;
      toHost(s, { t: 'msg', peer, data: text });
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!user || s.players.get(peer)?.ws !== ws) return;
      s.players.delete(peer);
      toHost(s, { t: 'leave', peer });
    });
  }

  const sweep = setInterval(() => {
    for (const [login, s] of sessions) {
      if (!s.host && !s.players.size && now() - s.hostGoneAt > LIMITS.idleSessionMs) sessions.delete(login);
    }
  }, 60_000);
  sweep.unref?.();

  // ---------- HTTP ----------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    // The phone app runs in a WebView on its own origin, so the public endpoints allow any origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        const players = [...sessions.values()].reduce((n, s) => n + s.players.size, 0);
        if (path === '/') return text(res, 200, `Stream Board Games session server v${pkg.version} — ${sessions.size} session(s), ${players} phone(s) connected.\n`);
        return json(res, 200, { ok: true, version: pkg.version, sessions: sessions.size, players });
      }
      const info = /^\/api\/sessions\/([a-z0-9_]{1,25})$/i.exec(path);
      if (req.method === 'GET' && info) {
        const s = sessions.get(info[1].toLowerCase());
        return json(res, 200, { open: !!s?.key, live: !!s?.host, name: s?.name ?? null, players: s?.players.size ?? 0 });
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (path === '/api/sessions') {
        const token = /^OAuth (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
        const user = token ? await whoIs(token) : null;
        if (!user) return json(res, 401, { error: 'Twitch login not accepted' });
        const s = sessionFor(user);
        s.key = randomBytes(24).toString('hex');
        if (s.host) s.host.close(4000, 'session restarted');
        log.log?.(`[session] ${user.login} opened their session`);
        return json(res, 200, { session: s.login, name: s.name, key: s.key });
      }
      if (path === '/api/login/start') return json(res, 200, await loginStart());
      if (path === '/api/login/poll') return json(res, 200, await loginPoll(body.device_code));
      if (path === '/api/login/refresh') return json(res, 200, await loginRefresh(body.refresh_token));
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.status ? err.message : 'server error' });
      if (!err.status) log.error?.('[session] request failed', err);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const login = String(url.searchParams.get('session') ?? '').toLowerCase();
    const s = sessions.get(login);
    const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (url.pathname === '/ws/host') {
      if (!s?.key || url.searchParams.get('key') !== s.key) return reject('403 Forbidden');
      const ws = acceptWebSocket(req, socket, head, { maxBytes: 1024 * 1024 });
      if (ws) attachHost(s, ws);
    } else if (url.pathname === '/ws/play') {
      // Only streamers who opened a session (companion app → Phone players). Phones may still
      // connect while the overlay itself is reloading.
      if (!s?.key) return reject('404 Not Found');
      const ws = acceptWebSocket(req, socket, head, { maxBytes: LIMITS.messageBytes });
      if (ws) attachPlayer(s, ws);
    } else reject('404 Not Found');
  });

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  const address = server.address();
  return {
    server, sessions, port: address.port,
    close: () => new Promise((ok) => {
      clearInterval(sweep);
      for (const s of sessions.values()) { s.host?.close(1001, 'server stopping'); for (const p of s.players.values()) p.ws.close(1001, 'server stopping'); }
      server.close(() => ok());
      server.closeAllConnections?.();
    }),
  };
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function text(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(value);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024) throw httpError(413, 'too big');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'bad JSON'); }
}

export async function runSessionServerCli(args = process.argv.slice(2)) {
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const port = Number(opt('--port', process.env.PORT ?? 8790));
  const host = opt('--host', '127.0.0.1');
  try {
    const app = await startSessionServer({ port, host, clientId: opt('--client-id', defaultClientId) });
    console.log(`\n  Stream Board Games session server v${pkg.version}`);
    console.log(`  Listening on http://${host}:${app.port}  (point the Cloudflare Tunnel at this address)\n`);
    const stop = () => app.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    console.error(`\n[session] could not start: ${err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runSessionServerCli();
