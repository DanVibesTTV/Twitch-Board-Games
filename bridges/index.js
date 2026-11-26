import { AnonIrcBridge } from './irc-anon.js';
import { LumiaBridge } from './lumia.js';
import { StreamerBotBridge } from './streamerbot.js';
import { DevBridge } from './dev.js';

export const BRIDGES = {
  irc: AnonIrcBridge,
  lumia: LumiaBridge,
  streamerbot: StreamerBotBridge,
  dev: DevBridge,
  // node: NodeBridge — local companion app, planned
};

export function createBridge(kind, options) {
  const Cls = BRIDGES[kind];
  if (!Cls) throw new Error(`Unknown bridge "${kind}". Use one of: ${Object.keys(BRIDGES).join(', ')}`);
  return new Cls(options);
}
