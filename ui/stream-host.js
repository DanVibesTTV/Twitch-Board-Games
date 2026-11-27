// Phone players on stream (companion app only): when the streamer turns on "Phone players" in the
// control panel, the companion opens a session on the session server (app/phone-sessions.mjs)
// and tells the overlay. This module then hosts the overlay's game for viewers' phones — the
// same LanHost as same-WiFi play (net/lan.js), over the internet (net/relay.js), with Twitch-
// checked identities. Secret-card games give each phone only its own cards.

import { LanHost } from '../net/lan.js';
import { RelayHost } from '../net/relay.js';

export function startStreamHost({ session, bridge, hud, appVersion }) {
  let current = null; // { key, host, transport }
  let retry = null;

  const report = () => {
    const host = current?.host;
    const users = host ? [...host.players.map((u) => u.id), ...host.away.keys()] : [];
    bridge.setPhones({ live: !!current?.transport.connected, users });
    bridge.reportPhones?.({ connected: !!current?.transport.connected, players: host ? host.players.map((u) => u.name) : [] })?.catch?.(() => {});
    if (hud) {
      const join = current?.transport.connected ? current.session : null;
      if (hud.phoneJoin !== join) { hud.phoneJoin = join; hud.refresh(); }
    }
  };

  const stop = async () => {
    clearTimeout(retry);
    const c = current;
    current = null;
    if (c) await c.host.stop().catch(() => {});
    report();
  };

  const start = async (st) => {
    await stop();
    const transport = new RelayHost({ server: st.server, session: st.session, key: st.key });
    const host = new LanHost({
      session, transport, stream: true,
      hostName: st.name ?? st.session,
      appVersion: appVersion?.(),
      onChange: report,
    });
    const c = { key: st.key, host, transport, session: st.session };
    current = c;
    transport.on('status', ({ replaced }) => {
      if (replaced) session.emit('toast', 'Phone players: another overlay took over (is the overlay open twice?)');
      report();
    });
    try {
      await host.start();
      report();
    } catch (err) {
      console.warn('[phones]', err.message);
      if (current !== c) return;
      current = null;
      report();
      retry = setTimeout(() => (bridge.streamSession?.key === st.key ? start(st) : null), 15000);
    }
  };

  const apply = (st) => {
    if (st?.state === 'open' && st.key) {
      if (current?.key !== st.key) start(st);
    } else if (current) stop();
  };

  bridge.on('streamSession', apply);
  if (bridge.streamSession) apply(bridge.streamSession);
  return { stop, get host() { return current?.host ?? null; } };
}
