// Keeps streamerbot/BoardGames.sb in sync with the code it should contain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { SB_ACTIONS } from '../bridges/streamerbot.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('BoardGames.sb holds the bridge + resolve actions with the current C#', () => {
  const raw = Buffer.from(read('../streamerbot/BoardGames.sb').trim(), 'base64');
  assert.equal(raw.subarray(0, 4).toString(), 'SBAE');
  const pack = JSON.parse(gunzipSync(raw.subarray(4)).toString('utf8'));
  const actions = pack.data.actions;
  assert.deepEqual(actions.map((a) => a.name).sort(), [SB_ACTIONS.bridge, SB_ACTIONS.resolve].sort());

  const bridge = actions.find((a) => a.name === SB_ACTIONS.bridge);
  const code = Buffer.from(bridge.subActions[0].byteCode, 'base64').toString('utf8').replace(/\r\n/g, '\n').trim();
  assert.equal(code, read('../streamerbot/BoardGamesBridge.cs').trim(),
    'BoardGamesBridge.cs changed — re-export the actions from Streamer.bot into BoardGames.sb');

  const resolve = actions.find((a) => a.name === SB_ACTIONS.resolve);
  assert.equal(resolve.subActions[0].winningIndex, '%winnerIndex0%');
  for (const k of ['commands', 'timers', 'websocketServers', 'websocketClients']) {
    assert.equal(pack.data[k]?.length ?? 0, 0, `pack should not contain ${k}`);
  }
});
