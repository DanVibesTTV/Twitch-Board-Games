// Streamer dock: an OBS custom browser dock served by the companion app (http://127.0.0.1:8765/dock/).
// It shows what only the streamer may see (their own cards in hidden-information games) and the
// seat controls. State arrives from the overlay via /api/dock/events; every button sends an
// ordinary chat command (as the streamer) through /api/dock/command — the same commands a
// chatbot queue can use.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PHASES = { menu: 'game select', lobby: 'lobby', playing: 'playing', over: 'game over' };

let state = null;
let overlays = null;

// ---------------- sending ----------------

async function send(text) {
  const p = state?.prefix ?? '!';
  const cmd = text.startsWith('!') ? p + text.slice(1) : text;
  try {
    const res = await fetch('/api/dock/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BoardGames': '1' },
      body: JSON.stringify({ text: cmd }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    $('sent').textContent = `Sent: ${cmd}`;
  } catch (err) {
    $('sent').textContent = `Couldn't send ${cmd}: ${err.message}`;
  }
}

// Kicking takes two clicks (no browser dialogs inside OBS). The armed button survives re-renders.
let armed = null; // { cmd, until }
function confirmThen(btn, fn) {
  const cmd = btn.dataset.cmd;
  if (armed?.cmd === cmd && armed.until > Date.now()) { armed = null; applyArmed(); fn(); return; }
  armed = { cmd, until: Date.now() + 3000 };
  applyArmed();
  setTimeout(applyArmed, 3100);
}
function applyArmed() {
  const live = armed && armed.until > Date.now() ? armed.cmd : null;
  for (const b of document.querySelectorAll('button[data-confirm]')) {
    b.dataset.label ??= b.textContent;
    const on = b.dataset.cmd === live;
    b.classList.toggle('confirm', on);
    b.textContent = on ? 'Sure?' : b.dataset.label;
  }
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-cmd]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.confirm) confirmThen(btn, () => send(btn.dataset.cmd));
  else send(btn.dataset.cmd);
});

$('seat-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const seat = $('seat-pick').value;
  const user = $('seat-user').value.trim().replace(/^@/, '');
  if (!seat || !/^\w{1,25}$/.test(user)) { $('sent').textContent = 'Pick a seat and type a Twitch username.'; return; }
  send(`!bg seat ${seat} ${user}`);
  $('seat-user').value = '';
});
$('mode').addEventListener('change', () => send(`!bg mode ${$('mode').value}`));
$('bots-down').addEventListener('click', () => send(`!bg bots ${Math.max(0, (state?.botFillTo ?? 0) - 1)}`));
$('bots-up').addEventListener('click', () => send(`!bg bots ${Math.min(state?.game?.max ?? 0, (state?.botFillTo ?? 0) + 1)}`));

// ---------------- rendering ----------------

function render() {
  const s = state;
  const notice = !s ? 'Waiting for the overlay… Open it in OBS (browser source) or in a browser.'
    : overlays === 0 ? 'The overlay is not open — buttons only work while it runs in OBS or a browser.' : '';
  $('notice').hidden = !notice;
  $('notice').textContent = notice;
  if (!s) { for (const id of ['mine', 'menu', 'table', 'controls']) $(id).hidden = true; return; }

  $('title').textContent = s.phase === 'menu' || !s.game ? 'Board Games' : `${s.game.name}${s.mode ? ` · ${s.mode.name}` : ''}`;
  $('phase').textContent = PHASES[s.phase] ?? s.phase;

  renderMenu(s);
  renderMine(s);
  renderTable(s);
  applyArmed();

  $('controls').hidden = s.phase === 'menu';
  $('start').hidden = s.phase !== 'lobby';
  $('join').hidden = s.phase !== 'lobby' || !!s.streamerSeat;
  $('stop').hidden = s.phase !== 'playing';
  $('to-menu').hidden = s.phase === 'playing';
}

function renderMenu(s) {
  $('menu').hidden = s.phase !== 'menu';
  if (s.phase !== 'menu') return;
  $('games').innerHTML = s.games.map((g) => `
    <button data-cmd="!bg play ${esc(g.id)}" ${g.playable ? '' : 'disabled title="Needs something this setup doesn\'t have"'}>
      ${esc(g.name)}<em>${g.playable ? 'open lobby' : 'not available'}</em></button>`).join('');
}

function cardHtml(c, small = false) {
  return `<span class="pcard${c.red ? ' red' : ''}${small ? ' small' : ''}">${esc(c.text)}</span>`;
}

function renderMine(s) {
  const m = s.mine;
  $('mine').hidden = !m;
  if (!m) return;
  $('mine-seat').textContent = `seat ${m.seat} · ${m.name}`;
  const p = m.private;
  $('mine-title').textContent = p ? 'Your cards (private)' : 'Your seat';
  $('private').innerHTML = p ? `
    <div class="hand-title">${esc(p.title)}</div>
    <div class="cards">${p.cards.length ? p.cards.map((c) => cardHtml(c)).join('') : '<span class="muted">no cards right now</span>'}</div>
    ${p.board ? `<div class="board"><span class="muted small">Board</span><div class="cards">${
      [...p.board.map((c) => cardHtml(c, true)), ...Array(Math.max(0, 5 - p.board.length)).fill('<span class="pcard small empty"></span>')].join('')}</div></div>` : ''}
    ${p.facts?.length ? `<div class="facts">${p.facts.map(([k, v]) => `<div><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}` : '';

  const myTurn = !!m.options;
  const turn = $('turn');
  turn.classList.toggle('mine', myTurn);
  turn.dataset.ends = s.turn?.endsAt ?? '';
  turn.dataset.text = myTurn ? `Your move${s.turn?.prompt && !p ? ` — ${s.turn.prompt}` : ''}` : s.turn ? `Waiting for ${s.turn.label}` : '';
  tick();
  $('moves').innerHTML = myTurn ? m.options.map((o) => `
    <button data-cmd="!${o.n}" ${o.disabled ? 'disabled' : ''}><span>!${o.n}</span>${esc(o.label)}</button>`).join('') : '';
}

function seatTools(s, seat) {
  const kick = (label = '✕') => `<button class="small" data-confirm="1" data-cmd="!bg kick ${seat.n}" title="Remove from this seat (!bg kick ${seat.n})">${label}</button>`;
  if (s.phase === 'lobby') {
    const out = [];
    if (seat.type !== 'bot' && seat.type !== 'reserved') out.push(`<button class="small" data-cmd="!bg bot ${seat.n}" title="A bot plays this seat">Bot</button>`);
    if (seat.type !== 'crowd' && seat.type !== 'reserved') out.push(`<button class="small" data-cmd="!bg crowd ${seat.n}" title="Chat votes the moves for this seat">Chat</button>`);
    if (seat.type && seat.type !== 'reserved') out.push(kick());
    return out.join('');
  }
  if (s.phase === 'playing' && seat.active && (seat.type === 'human' || seat.type === 'crowd')) return kick('Bot ⟲');
  return '';
}

function renderTable(s) {
  const show = s.phase === 'lobby' || s.phase === 'playing' || s.phase === 'over';
  $('table').hidden = !show;
  if (!show) return;
  const taken = s.seats.filter((x) => x.type && x.type !== 'reserved').length;
  $('seat-count').textContent = `${taken}/${s.game?.max ?? s.seats.length} taken`;

  $('lobby-tools').hidden = s.phase !== 'lobby';
  $('mode-field').hidden = !s.modes.length;
  const modeSel = $('mode');
  const modeHtml = s.modes.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  if (modeSel.dataset.html !== modeHtml) { modeSel.innerHTML = modeHtml; modeSel.dataset.html = modeHtml; }
  if (s.mode) modeSel.value = s.mode.id;
  $('bots').textContent = s.botFillTo ?? 0;

  const turnSeat = s.turn?.seat;
  $('seats').innerHTML = s.seats.map((seat) => {
    const who = seat.user
      ? `${esc(seat.user.name)}${seat.user.pending ? ' <small class="pending" title="Seated by name — becomes active when they type in chat">· not in chat yet</small>' : ''}`
      : seat.type === 'reserved' ? '<small>reserved for you — !join</small>'
      : seat.type === 'bot' ? '🤖 Bot' : seat.type === 'crowd' ? '💬 Chat vote' : '<small>empty</small>';
    return `<li class="${seat.n === turnSeat ? 'turn-now' : ''}${seat.active ? '' : ' inactive'}">
      <span class="num">${seat.n}</span>
      <span class="who"><small>${esc(seat.name)}</small> ${who}</span>
      <span class="tools">${seatTools(s, seat)}</span></li>`;
  }).join('');

  $('entrants').hidden = !s.entrants.length;
  $('entrants').textContent = s.entrants.length ? `Entered for the draw: ${s.entrants.join(', ')}` : '';

  // Seat by username: any seat in the lobby; during a game only seats a bot plays.
  const choices = s.seats.filter((x) => (s.phase === 'lobby') || (s.phase === 'playing' && x.active && x.type === 'bot'));
  // Secret-card games: viewers have no private screen yet, so nobody can be seated by name.
  $('seat-form').hidden = !choices.length || s.phase === 'over' || !!s.game?.hidden;
  const pick = $('seat-pick');
  const was = pick.value;
  const html = choices.map((x) => `<option value="${x.n}">${x.n} · ${esc(x.name)}</option>`).join('');
  if (pick.dataset.html !== html) { pick.innerHTML = html; pick.dataset.html = html; }
  const keep = choices.find((x) => String(x.n) === was);
  if (keep && keep.type !== 'human') pick.value = was;
  else {
    const free = choices.find((x) => !x.type || x.type === 'bot');
    if (free) pick.value = String(free.n);
  }
}

// Countdown on the "Your move" line.
function tick() {
  const t = $('turn');
  const ends = Number(t.dataset.ends);
  const secs = ends ? Math.max(0, Math.ceil((ends - Date.now()) / 1000)) : null;
  t.textContent = `${t.dataset.text ?? ''}${t.dataset.text && secs !== null ? ` · ${secs}s` : ''}`;
}
setInterval(tick, 250);

// ---------------- connection ----------------

function connect() {
  const es = new EventSource('/api/dock/events');
  es.addEventListener('hello', (ev) => {
    $('conn').className = 'dot ok';
    $('conn').title = 'connected to the companion app';
    try { overlays = JSON.parse(ev.data).overlays ?? null; } catch { /* ignore */ }
    render();
  });
  es.addEventListener('state', (ev) => {
    try { state = JSON.parse(ev.data); overlays = null; } catch { return; }
    render();
  });
  es.onerror = () => {
    $('conn').className = 'dot bad';
    $('conn').title = 'companion app not running?';
  };
}

render();
connect();
