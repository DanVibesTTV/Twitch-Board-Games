import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

// Raw requests so we can set any Host header.
function get(port, path, { host = `127.0.0.1:${port}`, headers = {}, method = 'GET', body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (res.headers['content-type']?.includes('event-stream') && data.includes('event: twitch')) { res.destroy(); ok({ status: res.statusCode, body: data }); } });
      res.on('end', () => ok({ status: res.statusCode, body: data }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

test('companion server: serves the overlay and panel, guards the API, stores overlay data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-server-'));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoCheck: false, openPanel: false }));
  process.env.BOARDGAMES_DATA = dir;
  const { startServer } = await import('../app/server.mjs');
  const log = console.log; console.log = () => {};
  const port = 20000 + Math.floor(Math.random() * 20000);
  const app = await startServer({ port, openPanel: false }).finally(() => { console.log = log; });
  try {
    const H = { 'X-BoardGames': '1', 'Content-Type': 'application/json' };
    assert.equal((await get(port, '/')).status, 200);
    assert.match((await get(port, '/panel/')).body, /companion/);
    assert.equal((await get(port, '/', { host: 'evil.example:80' })).status, 403, 'foreign Host header refused');
    assert.equal((await get(port, '/api/status')).status, 403, 'API needs the custom header');
    assert.equal((await get(port, '/api/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"text":"hi"}' })).status, 403);
    const st = JSON.parse((await get(port, '/api/status', { headers: H })).body);
    assert.equal(st.dataDir, dir);
    assert.equal(st.twitch.state, 'logged-out', 'fresh data folder: not logged in yet');
    assert.equal(st.clientIdSource, 'app');

    assert.equal((await get(port, '/api/kv/boardgames.stats.v1', { method: 'PUT', headers: H, body: JSON.stringify({ value: '{"a":1}' }) })).status, 200);
    assert.equal((await get(port, '/api/kv/notours', { method: 'PUT', headers: H, body: '{"value":"x"}' })).status, 400);
    assert.deepEqual(JSON.parse((await get(port, '/api/kv', { headers: H })).body), { 'boardgames.stats.v1': '{"a":1}' });

    const ev = await get(port, '/api/events');
    assert.match(ev.body, /event: hello/);
  } finally {
    app.twitch.close();
    await app.store.flush();
    app.server.closeAllConnections?.();
    app.server.close();
  }
});
