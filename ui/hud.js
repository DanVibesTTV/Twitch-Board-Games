// DOM HUD over the 3D canvas: game browser, lobby, seats, turn/timer, move list, log, toasts.
// Listens to Session events only — never touches game logic.

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Hud {
  constructor(root, { session, bridge, registry, prefix = '!' }) {
    this.s = session;
    this.bridge = bridge;
    this.registry = registry;
    this.p = prefix;
    root.innerHTML = '';
    this.root = root;

    this.side = el('aside', 'hud-side');
    this.header = el('header', 'card hud-header');
    this.main = el('section', 'card hud-main');
    this.seatsBox = el('section', 'card hud-seats');
    this.logBox = el('section', 'card hud-log');
    this.side.append(this.header, this.seatsBox, this.main, this.logBox);
    this.menu = el('section', 'hud-menu');
    this.toasts = el('div', 'hud-toasts');
    this.banner = el('div', 'hud-banner');
    root.append(this.side, this.menu, this.toasts, this.banner);

    this.seats = [];
    this.logLines = [];
    this.status = { state: 'connecting', detail: '' };

    session.on('phase', (p) => this.#phase(p));
    session.on('seats', (seats) => { this.seats = seats; this.#renderSeats(); if (session.phase === 'lobby') this.#renderLobby(this.lobbyTimer); });
    session.on('lobbyTimer', (t) => { this.lobbyTimer = t; this.#renderLobby(t); });
    session.on('decision', (d) => this.#renderDecision(d));
    session.on('votes', (tally) => this.#renderVotes(tally));
    session.on('log', ({ seat, text }) => this.#log(text, seat?.color));
    session.on('toast', (t) => this.#toast(t));
    session.on('gameVote', (v) => this.#renderMenu(v));
    session.on('gameOver', (o) => this.#gameOver(o));
    bridge.on('status', (st) => { this.status = st; this.#renderHeader(); });

    this.#phase(session.phase);
  }

  #phase(phase) {
    this.root.dataset.phase = phase;
    this.banner.classList.remove('show');
    this.#renderHeader();
    if (phase === 'menu') {
      this.#renderMenu(null);
      this.logLines = [];
      this.#renderLog();
    }
    if (phase === 'lobby') { this.lobbyTimer = null; this.#renderLobby(null); }
    if (phase === 'playing') this.main.innerHTML = '<div class="muted">Setting up the board…</div>';
  }

  #renderHeader() {
    const m = this.s.manifest;
    const st = this.status;
    this.header.innerHTML = `
      <div class="title">${esc(this.s.phase === 'menu' || !m ? 'Board Games' : m.name)}</div>
      <div class="conn conn-${esc(st.state)}" title="${esc(st.detail)}"><i></i>${esc(st.detail || st.state)}</div>`;
  }

  #renderMenu(vote) {
    this.menu.innerHTML = '';
    const caps = this.bridge.capabilities;
    const head = el('div', 'menu-head', vote
      ? `<h1>Vote for the next game</h1><p>Type <b>${this.p}1</b>, <b>${this.p}2</b> … in chat</p>${this.#timerBar(vote.endsAt, vote.total)}`
      : `<h1>Pick a game</h1><p>Streamer/mods: <b>${this.p}bg play &lt;game&gt;</b> or <b>${this.p}bg vote</b></p>`);
    const grid = el('div', 'menu-grid');
    const list = vote ? vote.options : this.registry.list;
    list.forEach((m, i) => {
      const ok = this.registry.isPlayable(m, caps);
      const card = el('article', `game-card${ok ? '' : ' disabled'}`);
      card.innerHTML = `
        ${vote ? `<div class="vote-num">${this.p}${i + 1}<span class="vote-count" data-i="${i}">0</span></div>` : ''}
        <div class="thumb">${m.thumbnailUrl ? `<img src="${esc(m.thumbnailUrl)}" alt="">` : ''}</div>
        <div class="info">
          <h2>${esc(m.name)}</h2>
          <p>${esc(m.tagline ?? '')}</p>
          <div class="meta">${m.players.min}–${m.players.max} players${m.durationMinutes ? ` · ${m.durationMinutes[0]}–${m.durationMinutes[1]} min` : ''}</div>
          ${ok ? `<code>${this.p}bg play ${esc(m.id)}</code>` : `<div class="needs">Needs: ${esc(this.registry.missing(m, caps).join(', '))}</div>`}
        </div>`;
      grid.append(card);
    });
    this.menu.append(head, grid);
  }

  #renderSeats() {
    const d = this.currentDecision;
    this.seatsBox.innerHTML = this.seats.map((s) => {
      const o = s.occupant;
      const who = !o ? `<span class="muted">${this.p}join ${esc(s.id)}</span>`
        : o.type === 'human' ? esc(o.user.name)
        : o.type === 'crowd' ? '👥 Chat vote'
        : `🤖 Bot${o.replaced ? ` <span class="muted">(for ${esc(o.replaced)})</span>` : ''}`;
      const active = d && d.seat?.id === s.id ? ' active' : '';
      return `<div class="seat${active}" style="--c:${esc(s.color)}"><span class="chip"></span><span class="seat-name">${esc(s.name)}</span><span class="who">${who}</span></div>`;
    }).join('');
  }

  #renderLobby(t) {
    if (this.s.phase !== 'lobby') return;
    const m = this.s.manifest;
    this.main.innerHTML = `
      <div class="big">Join the game!</div>
      <p>Type <b>${this.p}join</b> or <b>${this.p}join ${esc(m.seats[0].id)}</b> to pick a color.</p>
      <p class="muted">${m.players.min}–${m.players.max} players${this.s.botFillTo ? ` · bots fill up to ${this.s.botFillTo} seats` : ''}</p>
      ${t ? `<div class="label">Starting in</div>${this.#timerBar(t.endsAt, t.total, true)}` : '<div class="muted">Countdown starts with the first player.</div>'}
      <div class="help">${(m.commands ?? []).map((c) => `<div><b>${esc(c.cmd)}</b> ${esc(c.help)}</div>`).join('')}</div>`;
  }

  #renderDecision(payload) {
    this.currentDecision = payload;
    this.#renderSeats();
    if (!payload) return;
    const { decision: d, seat, occupant } = payload;
    const who = occupant.type === 'human' ? occupant.user.name : occupant.type === 'crowd' ? 'Chat' : 'Bot';
    const showOptions = d.kind !== 'roll' || occupant.type !== 'bot';
    const hint = occupant.type === 'crowd' ? 'Chat votes — majority wins'
      : occupant.type === 'bot' ? 'Bot is thinking…'
      : d.kind === 'roll' ? `${who}, type <b>${this.p}roll</b>` : `${who}, type the number`;
    this.main.innerHTML = `
      <div class="turn" style="--c:${esc(seat.color)}"><span class="chip"></span>${esc(who)} <span class="muted">· ${esc(seat.name)}</span></div>
      <div class="prompt">${esc(d.prompt)}</div>
      ${this.#timerBar(payload.endsAt, payload.total)}
      <div class="hint">${hint}</div>
      ${showOptions ? `<ol class="options">${d.options.map((o, i) => `
        <li><b>${this.p}${o.alias && d.options.length === 1 ? esc(o.alias) : i + 1}</b><span>${esc(o.label)}</span><em class="vote-count" data-i="${i}"></em></li>`).join('')}</ol>` : ''}`;
  }

  #renderVotes(tally) {
    for (const node of this.root.querySelectorAll('.vote-count')) {
      const n = tally[Number(node.dataset.i)] ?? 0;
      node.textContent = n ? String(n) : (node.closest('.game-card') ? '0' : '');
    }
  }

  #timerBar(endsAt, total, numeric = false) {
    const left = Math.max(0, (endsAt - Date.now()) / 1000);
    const pct = total > 0 ? (left / total) * 100 : 0;
    const id = `t${Math.random().toString(36).slice(2)}`;
    // Shrinks via a CSS transition — no per-frame JS.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const bar = document.getElementById(id);
      if (bar) { bar.style.transition = `width ${left}s linear`; bar.style.width = '0%'; }
    }));
    if (numeric) this.#countdown(id, endsAt);
    return `<div class="timer"><div class="bar" id="${id}" style="width:${pct}%"></div>${numeric ? `<span class="secs" data-for="${id}">${Math.ceil(left)}s</span>` : ''}</div>`;
  }

  #countdown(id, endsAt) {
    const tick = () => {
      const node = this.root.querySelector(`.secs[data-for="${id}"]`);
      if (!node) return;
      node.textContent = `${Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))}s`;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 0);
  }

  #log(text, color) {
    this.logLines.push({ text, color });
    this.logLines = this.logLines.slice(-6);
    this.#renderLog();
  }

  #renderLog() {
    this.logBox.innerHTML = this.logLines.map((l) => `<div style="--c:${esc(l.color ?? '#999')}"><span class="chip"></span>${esc(l.text)}</div>`).join('');
  }

  #toast(text) {
    const t = el('div', 'toast', esc(text));
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 4500);
    setTimeout(() => t.remove(), 5200);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
  }

  #gameOver({ winner, ranking }) {
    const medals = ['🥇', '🥈', '🥉', '4.'];
    this.banner.innerHTML = `
      <div class="win" style="--c:${esc(winner.color)}">
        <div class="trophy">🏆</div>
        <div class="who">${esc(winner.label ?? labelOf(winner))}</div>
        <div class="muted">wins ${esc(this.s.manifest.name)}!</div>
        <ol>${ranking.map((s, i) => `<li><span>${medals[i] ?? `${i + 1}.`}</span>${esc(labelOf(s))}</li>`).join('')}</ol>
      </div>`;
    this.banner.classList.add('show');
    this.main.innerHTML = `<div class="muted">${this.s.config.afterGame === 'lobby' ? 'Rematch lobby opens shortly…' : 'Back to game select shortly…'}</div>`;
  }
}

function labelOf(seat) {
  const o = seat.occupant;
  if (o?.type === 'human') return `${o.user.name} (${seat.name})`;
  if (o?.type === 'crowd') return `Chat (${seat.name})`;
  return `Bot (${seat.name})`;
}

// Dev console: type "alice: !join red" to chat as anyone.
export function mountDevConsole(root, bridge) {
  const form = el('form', 'dev-console');
  form.innerHTML = `<input placeholder='dev chat — e.g. "alice: !join red", "!bg start" (as streamer), "@mod: !bg stop"' autocomplete="off">
    <button type="button" data-q="alice: !join">+alice</button><button type="button" data-q="bob: !join">+bob</button>
    <button type="button" data-q="!bg start">start</button>`;
  const input = form.querySelector('input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value.trim()) bridge.inject(input.value.trim());
    input.value = '';
  });
  form.addEventListener('click', (e) => {
    const q = e.target?.dataset?.q;
    if (q) bridge.inject(q);
  });
  root.append(form);
}
