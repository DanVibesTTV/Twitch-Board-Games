// The companion app itself (started by app/companion.mjs, which restarts it after updates).
//   - serves the overlay at http://127.0.0.1:8765/, the control panel at /panel/ and the
//     streamer dock (an OBS custom browser dock) at /dock/
//   - connects to Twitch (chat in/out, predictions) for ?bridge=node
//   - stores the overlay's data (viewer stats, trivia settings) in a file
//   - checks GitHub for updates and installs them on request

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { Twitch } from './twitch.mjs';
import { Updater, DEFAULT_REPO } from './updater.mjs';
import { PhoneSessions } from './phone-sessions.mjs';

export const RESTART_CODE = 75;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
const UPDATE_EVERY_MS = 6 * 3600 * 1000;

export async function startServer({ port: portArg, openPanel } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const store = await new Store().open();
  const settings = store.settings;
  const port = Number(portArg ?? settings.port ?? 8765);
  const appInfo = JSON.parse(await readFile(join(root, 'app', 'twitch-app.json'), 'utf8').catch(() => '{}'));
  const clientId = settings.twitchClientId || appInfo.clientId || '';

  const twitch = new Twitch({ store, clientId });
  const updater = new Updater({ root, store, version: pkg.version, repo: settings.updateRepo || DEFAULT_REPO });

  // ---- Server-Sent Events to the overlay and the panel ----
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };
  twitch.on('chat', (msg) => broadcast('chat', msg));

  // ---- Phone players (stream sessions, app/phone-sessions.mjs) ----
  // The overlay hosts viewers' phones through the session server; we only open the session.
  const phones = new PhoneSessions({ store, twitch });
  phones.on('change', (st) => broadcast('streamSession', st));
  phones.on('status', (st) => broadcast('streamStatus', st));

  // ---- Streamer dock ----
  // The overlay (where the Session runs) POSTs its dock snapshot to /api/dock/state; it goes only
  // to the dock's own stream (/api/dock/events), never to the overlay/panel stream, because for
  // hidden-information games it holds the streamer's private cards. The dock's buttons POST chat
  // commands to /api/dock/command, which reach the overlay as the streamer's own chat.
  const docks = new Set();
  let dockState = null;
  const dockInfo = () => ({ connected: docks.size });
  const toDocks = (event, data) => { for (const res of docks) send(res, event, data); };
  twitch.on('botState', (st) => {
    broadcast('twitchBot', st);
    console.log(`[twitch] bot account: ${st.state === 'none' ? 'not connected' : st.state}${st.login ? ` (${st.login})` : ''}${st.detail ? `: ${st.detail}` : ''}`);
  });
  twitch.on('state', (st) => {
    broadcast('twitch', st);
    console.log(`[twitch] ${st.state}${st.detail ? `: ${st.detail}` : ''}`);
  });

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this PC (blocks DNS-rebinding tricks from websites).
      if (!allowedHosts.has(req.headers.host)) { res.writeHead(403).end('forbidden host'); return; }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return await serveFile(res, url.pathname);
    } catch (err) {
      console.error('[server]', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err.message ?? err));
    }
  });

  async function api(req, res, url) {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      send(res, 'hello', { version: pkg.version });
      send(res, 'twitch', twitch.state);
      send(res, 'twitchBot', twitch.botState);
      send(res, 'dock', dockInfo());
      send(res, 'streamSession', phones.public);
      send(res, 'streamStatus', phones.status);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && path === '/api/dock/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      send(res, 'hello', { version: pkg.version, overlays: clients.size });
      if (dockState) send(res, 'state', dockState);
      docks.add(res);
      broadcast('dock', dockInfo()); // the overlay now sends its snapshot and offers hidden games
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); docks.delete(res); broadcast('dock', dockInfo()); });
      return;
    }
    // Everything else needs our header. Websites can't add it without CORS permission,
    // which this server never grants, so they can't post to your chat or log you out.
    if (req.headers['x-boardgames'] !== '1') return json(res, 403, { error: 'missing X-BoardGames header' });
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, {
        version: pkg.version, port, dataDir: store.dir,
        twitch: twitch.state, twitchBot: twitch.botState, clientIdSource: settings.twitchClientId ? 'settings' : appInfo.clientId ? 'app' : 'none',
        update: await updater.status(),
        settings: { autoCheck: settings.autoCheck !== false, openPanel: settings.openPanel !== false, updateRepo: updater.repo, twitchClientId: settings.twitchClientId ?? '', obsOptions: settings.obsOptions ?? {} },
      });
    }
    // overlay storage
    if (req.method === 'GET' && path === '/api/kv') return json(res, 200, store.getAll());
    if (path.startsWith('/api/kv/')) {
      const key = decodeURIComponent(path.slice('/api/kv/'.length));
      if (!key.startsWith('boardgames.')) return json(res, 400, { error: 'bad key' });
      if (req.method === 'PUT') { store.set(key, body.value); return json(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { store.delete(key); return json(res, 200, { ok: true }); }
    }
    // streamer dock
    if (req.method === 'POST' && path === '/api/dock/state') {
      dockState = body && typeof body === 'object' ? body : null;
      toDocks('state', dockState);
      return json(res, 200, { ok: true, docks: docks.size });
    }
    if (req.method === 'POST' && path === '/api/dock/command') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 200 || /[\r\n]/.test(text)) return json(res, 400, { error: 'bad command' });
      if (!clients.size) return json(res, 409, { error: 'the overlay is not open — add it to OBS (or open it in a browser) first' });
      const login = twitch.state.login ?? 'streamer';
      const user = { id: twitch.main?.userId ?? 'streamer', login, name: login, isBroadcaster: true, isMod: true };
      broadcast('dockCommand', { platform: 'dock', text, user });
      return json(res, 200, { ok: true });
    }
    // Twitch
    if (req.method === 'POST' && path === '/api/chat') return json(res, 200, await twitch.sendChat(body.text));
    if (req.method === 'POST' && path === '/api/prediction') return json(res, 200, await twitch.predict(body.action, body));
    if (req.method === 'POST' && path === '/api/twitch/login') return json(res, 200, await twitch.login());
    if (req.method === 'POST' && path === '/api/twitch/logout') { await twitch.logout(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && path === '/api/twitch/bot/login') return json(res, 200, await twitch.loginBot());
    if (req.method === 'POST' && path === '/api/twitch/bot/logout') { await twitch.logoutBot(); return json(res, 200, { ok: true }); }
    // updates
    if (req.method === 'POST' && path === '/api/update/check') return json(res, 200, await updater.check());
    if (req.method === 'POST' && path === '/api/update/install') {
      const result = await updater.install();
      json(res, 200, { ...result, restarting: true });
      setTimeout(() => shutdown(RESTART_CODE), 300);
      return;
    }
    // settings (some take effect after a restart)
    if (req.method === 'POST' && path === '/api/settings') {
      const patch = {};
      if ('autoCheck' in body) patch.autoCheck = !!body.autoCheck;
      if ('openPanel' in body) patch.openPanel = !!body.openPanel;
      if ('twitchClientId' in body) patch.twitchClientId = String(body.twitchClientId).trim();
      if (body.obsOptions && typeof body.obsOptions === 'object') {
        patch.obsOptions = Object.fromEntries(Object.entries(body.obsOptions)
          .filter(([k, v]) => /^[a-z]+$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 30));
      }
      if ('updateRepo' in body) patch.updateRepo = /^[\w.-]+\/[\w.-]+$/.test(body.updateRepo) ? body.updateRepo : DEFAULT_REPO;
      await store.saveSettings(patch);
      return json(res, 200, { ok: true, restartNeeded: 'twitchClientId' in body || 'updateRepo' in body });
    }
    if (req.method === 'POST' && path === '/api/phones') {
      try {
        await phones.configure({ enabled: body.enabled, server: body.server });
        return json(res, 200, { ok: true, phones: phones.public });
      } catch (err) { return json(res, 400, { error: err.message }); }
    }
    if (req.method === 'POST' && path === '/api/phones/status') {
      phones.report(body);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/restart') { json(res, 200, { ok: true }); setTimeout(() => shutdown(RESTART_CODE), 300); return; }
    if (req.method === 'POST' && path === '/api/open-data') { openPath(store.dir); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'unknown endpoint' });
  }

  async function serveFile(res, pathname) {
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (/^\/(panel|dock)(\/|$)/.test(pathname)) file = normalize(join(root, 'app', decodeURIComponent(pathname)));
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  }

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    twitch.close();
    phones.close();
    for (const c of clients) c.end();
    await store.flush();
    server.close();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is already in use: is the companion app already running in another window?`);
      console.error(`To use another port: node app/companion.mjs ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });

  const base = `http://127.0.0.1:${port}`;
  console.log('');
  console.log(`  Stream Board Games companion v${pkg.version}`);
  console.log(`  Control panel:  ${base}/panel/`);
  console.log(`  OBS overlay:    ${base}/?bridge=node`);
  console.log(`  Streamer dock:  ${base}/dock/   (OBS: Docks → Custom Browser Docks)`);
  console.log(`  Data folder:    ${store.dir}`);
  console.log('  Keep this window open while you stream. Ctrl+C stops it.');
  console.log('');

  await twitch.start();
  if (phones.settings.enabled) phones.open();

  const checkUpdates = async () => {
    const st = await updater.check();
    if (st.available) console.log(`[update] version ${st.latest.version} is available: install it from the control panel`);
    else if (st.error && !st.error.includes('no releases')) console.log(`[update] ${st.error}`);
    broadcast('update', st);
  };
  if (settings.autoCheck !== false) {
    checkUpdates();
    setInterval(checkUpdates, UPDATE_EVERY_MS).unref();
  }

  if (openPanel ?? settings.openPanel !== false) openPath(`${base}/panel/`);
  return { server, store, twitch, updater, port, phones };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new Error('request too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// Opens a URL or folder with the system's default app.
function openPath(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${target}"`]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref(); } catch { /* no desktop */ }
}

// Command line: [port] [--no-panel]. Used when run directly and by the .exe (app/sea-main.mjs).
export function runServerCli(args = process.argv.slice(2)) {
  startServer({ port: args.find((a) => /^\d+$/.test(a)), openPanel: args.includes('--no-panel') ? false : process.env.BOARDGAMES_RESTARTED ? false : undefined })
    .catch((err) => { console.error(err); process.exit(1); });
}

// Run directly (the launcher starts this file).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runServerCli();
