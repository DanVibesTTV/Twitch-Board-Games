// Turns a normalized chat message into a command object, or null.
//
// Normalized chat message (every bridge produces this shape):
//   { user: { id, login, name, isMod, isBroadcaster }, text, platform }
//
// Commands:
//   !1 .. !99           → { kind: 'choose', index }
//   !roll / !r          → { kind: 'alias', alias: 'roll' } (any alias a game defines)
//   !join [seat]        → { kind: 'join', arg }
//   !leave              → { kind: 'leave' }
//   !bg <sub> [arg]     → { kind: 'admin', sub, arg }   (mods/broadcaster only)

const ALIASES = { r: 'roll' };

export function parseCommand(msg, prefix = '!') {
  const text = (msg?.text ?? '').trim();
  if (!text.startsWith(prefix)) return null;
  const [head, ...rest] = text.slice(prefix.length).trim().split(/\s+/);
  if (!head) return null;
  const word = head.toLowerCase();
  const arg = rest.join(' ').trim() || null;

  if (/^\d{1,2}$/.test(word)) return { kind: 'choose', index: Number(word) };
  if (word === 'join' || word === 'play') return { kind: 'join', arg: arg?.toLowerCase() ?? null };
  if (word === 'leave' || word === 'quit') return { kind: 'leave' };
  if (word === 'bg') {
    if (!(msg.user?.isMod || msg.user?.isBroadcaster)) return null;
    const [sub, ...subArgs] = (arg ?? '').split(/\s+/);
    return { kind: 'admin', sub: (sub || 'help').toLowerCase(), arg: subArgs.join(' ').toLowerCase() || null };
  }
  return { kind: 'alias', alias: ALIASES[word] ?? word, arg };
}
