// Keeps the streamer dock up to date (companion app only, bridges/node.js): after anything the
// dock shows changes, sends Session.dockState() to the companion server, which passes it on to
// the dock page only. Nothing is sent while no dock is open.

const EVENTS = ['phase', 'seats', 'entrants', 'decision', 'gameEvents', 'gameOver', 'lobbyInfo', 'lobbyTimer'];

export function startDockLink({ session, bridge, delayMs = 60 }) {
  let timer = null;
  let sending = false;
  let again = false;

  const push = async () => {
    timer = null;
    if (!bridge.docks) return;
    if (sending) { again = true; return; }
    sending = true;
    try { await bridge.pushDock(session.dockState()); } catch (err) { console.warn('[dock] update failed', err); }
    sending = false;
    if (again) { again = false; schedule(); }
  };
  const schedule = () => { timer ??= setTimeout(push, delayMs); };

  for (const ev of EVENTS) session.on(ev, schedule);
  bridge.on('dock', schedule);           // a dock (re)connected: send it the current state
  bridge.on('capabilities', schedule);   // games became playable or not
  return { refresh: schedule };
}
