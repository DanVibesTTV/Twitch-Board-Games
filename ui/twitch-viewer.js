// The viewer's Twitch login in the phone app (for joining streams). Uses the device login through
// the session server (app/session-server.mjs → /api/login/*): the app shows a code, the viewer
// confirms it on twitch.tv/activate, and the app receives a token. Saved on the phone; refreshed
// through the session server when it runs out.

const KEY = 'boardgames.twitch.viewer';
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

// { user: { id, login, name }, access_token, refresh_token, expires_at } or null
export function savedViewer() {
  const v = store.get();
  return v?.user?.id && v.access_token ? v : null;
}

export function logOutViewer() { store.set(null); }

async function post(server, path, body) {
  const res = await fetch(`${String(server).replace(/\/+$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function save(reply) {
  const v = { user: reply.user, access_token: reply.access_token, refresh_token: reply.refresh_token, expires_at: Date.now() + (reply.expires_in ?? 3600) * 1000 };
  store.set(v);
  return v;
}

// Device login. onCode({ user_code, verification_uri }) shows the code; resolves with the viewer.
// cancel() (returned via the signal object) stops polling.
export async function logInViewer(server, onCode, signal = {}) {
  const start = await post(server, '/api/login/start');
  onCode(start);
  let wait = Math.max(2, start.interval ?? 5) * 1000;
  const until = Date.now() + (start.expires_in ?? 1800) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, wait));
    if (signal.cancelled) throw new Error('cancelled');
    const reply = await post(server, '/api/login/poll', { device_code: start.device_code });
    if (reply.pending) continue;
    return save(reply);
  }
  throw new Error('The code expired — try again.');
}

// The current access token, refreshed first when it is about to run out.
export async function viewerToken(server) {
  const v = savedViewer();
  if (!v) throw new Error('Log in with Twitch first.');
  if (v.expires_at - Date.now() > 5 * 60_000) return v.access_token;
  try {
    return save(await post(server, '/api/login/refresh', { refresh_token: v.refresh_token })).access_token;
  } catch (err) {
    if (err.status === 400) { logOutViewer(); throw new Error('Your Twitch login expired — log in again.'); }
    return v.access_token; // server unreachable: try the old token
  }
}
