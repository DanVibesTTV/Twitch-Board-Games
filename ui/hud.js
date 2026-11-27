// DOM HUD over the 3D canvas: game browser, lobby, seats, turn/timer, move list, log, toasts.
// Listens to Session events only — never touches game logic.
// Touch mode (the phone app): anything with data-cmd is tappable and sends that command
// ("|" separates several), exactly as if it was typed in chat.

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Hud {
  constructor(root, { session, bridge, registry, prefix = '!', touch = null }) {
    this.s = session;
    this.touch = touch; // { send(text) } or null
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
    this.statsBox = el('section', 'card hud-stats');
    this.side.append(this.header, this.seatsBox, this.main, this.logBox, this.statsBox);
    this.menu = el('section', 'hud-menu');
    this.toasts = el('div', 'hud-toasts');
    this.banner = el('div', 'hud-banner');
    this.questionBox = el('section', 'hud-question');
    this.lobbyStage = el('section', 'hud-lobby');
    root.append(this.side, this.menu, this.lobbyStage, this.questionBox, this.toasts, this.banner);
    if (touch) {
      root.addEventListener('click', (e) => {
        const target = e.target.closest?.('[data-cmd]');
        if (!target || target.classList.contains('disabled')) return;
        for (const cmd of target.dataset.cmd.split('|')) touch.send(cmd.trim());
      });
    }

    this.seats = [];
    this.entrants = [];
    this.secondsPerCard = 7; // carousel speed: each card takes this long to pass
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.s.phase === 'menu' && this.#fitCarousel(), 200);
    });
    this.logLines = [];
    this.status = { state: 'connecting', detail: '' };

    session.on('phase', (p) => this.#phase(p));
    session.on('seats', (seats) => { this.seats = seats; this.#renderSeats(); if (session.phase === 'lobby') this.#renderLobby(this.lobbyTimer); });
    session.on('lobbyTimer', (t) => { this.lobbyTimer = t; this.#renderLobby(t); });
    session.on('entrants', (list) => { this.entrants = list; if (session.phase === 'lobby') this.#renderLobby(this.lobbyTimer); });
    session.on('phase', (p) => { if (p !== 'lobby') { clearTimeout(this.lobbyStageTimer); this.prevSeatIds = null; this.lobbyStageKey = null; } });
    session.on('decision', (d) => this.#renderDecision(d));
    session.on('votes', (tally) => this.#renderVotes(tally));
    session.on('log', ({ seat, text }) => this.#log(text, seat?.color));
    session.on('toast', (t) => this.#toast(t));
    session.on('gameVote', (v) => this.#renderMenu(v));
    session.on('gameOver', (o) => this.#gameOver(o));
    session.on('stats', (v) => this.#renderStats(v));
    session.on('gameEvents', (events) => this.#onGameEvents(events));
    session.on('lobbyInfo', () => this.#renderLobbyInfo());
    bridge.on('status', (st) => { this.status = st; this.#renderHeader(); });

    this.#phase(session.phase);
  }

  #phase(phase) {
    this.root.dataset.phase = phase;
    this.banner.classList.remove('show');
    delete this.banner.dataset.cmd;
    this.#hideQuestion();
    clearInterval(this.lobbyInfoTimer);
    if (phase === 'lobby') this.lobbyInfoTimer = setInterval(() => this.#renderLobbyInfo(), 1500);
    this.#renderHeader();
    if (phase === 'menu') {
      this.#renderMenu(null);
      this.#renderStats(this.s.statsView());
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
      ${this.touch && this.s.phase !== 'menu' ? '<button class="hud-back" data-cmd="!bg stop" aria-label="Back to game select">✕</button>' : ''}
      <div class="title">${esc(this.s.phase === 'menu' || !m ? 'Board Games' : m.name)}</div>
      <div class="conn conn-${esc(st.state)}" title="${esc(st.detail)}"><i></i>${esc(st.detail || st.state)}</div>`;
  }

  #renderMenu(vote) {
    this.menu.innerHTML = '';
    const caps = this.bridge.capabilities;
    const head = el('div', 'menu-head', vote
      ? `<h1>Vote for the next game</h1><p>Type <b>${this.p}1</b>, <b>${this.p}2</b> … in chat</p>${this.#timerBar(vote.endsAt, vote.total)}`
      : this.touch ? '<h1>Pick a game</h1><p>Tap a game to play against bots</p>'
      : `<h1>Pick a game</h1><p>Streamer/mods: <b>${this.p}bg play &lt;game&gt;</b> or <b>${this.p}bg vote</b></p>`);
    // One row of cards; once they don't fit it becomes an endless right-to-left carousel.
    const carousel = el('div', 'menu-carousel');
    const grid = el('div', 'menu-track');
    carousel.append(grid);
    const list = vote ? vote.options : this.registry.list;
    list.forEach((m, i) => {
      const ok = this.registry.isPlayable(m, caps);
      const card = el('article', `game-card${ok ? '' : ' disabled'}`);
      if (this.touch && ok && !vote) card.dataset.cmd = `${this.p}bg play ${m.id}`;
      card.innerHTML = `
        ${vote ? `<div class="vote-num">${this.p}${i + 1}<span class="vote-count" data-i="${i}">0</span></div>` : ''}
        <div class="thumb">${m.thumbnailUrl ? `<img src="${esc(m.thumbnailUrl)}" alt="">` : ''}</div>
        <div class="info">
          <h2>${esc(m.name)}</h2>
          <p>${esc(m.tagline ?? '')}</p>
          <div class="meta">${m.players.min === m.players.max ? `${m.players.min} players` : `${m.players.min}–${m.players.max} players`}${m.durationMinutes ? ` · ${m.durationMinutes[0]}–${m.durationMinutes[1]} min` : ''}</div>
          ${m.modes?.length ? `<div class="modes">${m.modes.map((md) => `<span title="${esc(md.description ?? '')}">${esc(md.name)}</span>`).join('')}</div>` : ''}
          ${!ok ? `<div class="needs">Needs: ${esc(this.registry.missing(m, caps).join(', '))}</div>` : this.touch ? '' : `<code>${this.p}bg play ${esc(m.id)}</code>`}
        </div>`;
      grid.append(card);
    });
    this.menu.append(head, carousel);
    requestAnimationFrame(() => this.#fitCarousel());
  }

  // Scroll only when the cards overflow. The cards are duplicated once, so moving the track
  // by exactly half its width loops seamlessly. Re-checked on resize.
  #fitCarousel() {
    const carousel = this.menu.querySelector('.menu-carousel');
    const track = carousel?.querySelector('.menu-track');
    if (!track || this.touch) return; // touch: the row scrolls with a swipe instead
    track.querySelectorAll('.clone').forEach((c) => c.remove());
    carousel.classList.remove('scrolling');
    const cards = [...track.children];
    if (track.scrollWidth <= carousel.clientWidth + 1 || cards.length < 2) return;
    for (const card of cards) {
      const clone = card.cloneNode(true);
      clone.classList.add('clone');
      clone.setAttribute('aria-hidden', 'true');
      track.append(clone);
    }
    carousel.style.setProperty('--dur', `${cards.length * this.secondsPerCard}s`);
    carousel.classList.add('scrolling');
  }

  // Leaderboard on the game select screen; !bgstats turns the page.
  #renderStats(view) {
    if (!view) { this.statsBox.style.display = 'none'; return; }
    this.statsBox.style.display = '';
    if (this.touch) this.statsBox.dataset.cmd = `${this.p}bgstats`;
    const { pages, index } = view;
    const page = pages[index] ?? pages[0];
    const medals = ['🥇', '🥈', '🥉'];
    const rows = page.rows.length
      ? page.rows.map((r, i) => `
        <li><span class="rank">${medals[i] ?? i + 1}</span><span class="name">${esc(r.name)}</span>
          <span class="value">${r.value}<small> ${esc(page.unit)}</small></span><span class="detail">${esc(r.detail)}</span></li>`).join('')
      : '<li class="empty">No results yet. Win a game to get on the board!</li>';
    this.statsBox.innerHTML = `
      <div class="stats-head">
        <div class="stats-title">${esc(page.title)}</div>
        <div class="dots">${pages.map((_, i) => `<i class="${i === index ? 'on' : ''}"></i>`).join('')}</div>
      </div>
      <ol class="board" key="${esc(page.id)}">${rows}</ol>
      <div class="stats-hint">${this.touch ? 'Tap for the next page' : `<b>${this.p}bgstats</b> next page · <b>${this.p}bgstats me</b> your stats`}</div>`;
  }

  #renderSeats() {
    const d = this.currentDecision;
    const ids = new Set(this.seats.map((s) => s.occupant?.user?.id ?? s.occupant?.type).filter(Boolean));
    const fresh = (s) => this.s.phase === 'lobby' && this.prevSeatIds && s.occupant?.user && !this.prevSeatIds.has(s.occupant.user.id);
    this.seatsBox.innerHTML = this.seats.map((s) => {
      const o = s.occupant;
      const draw = this.s.mode?.entry === 'draw' && this.s.phase === 'lobby';
      const who = !o ? `<span class="muted">${this.touch ? 'open' : draw ? '🎲 drawn at random' : `${this.p}join ${esc(s.id)}`}</span>`
        : o.type === 'reserved' ? `⭐ Streamer <span class="muted">· type ${this.p}join</span>`
        : o.type === 'human' ? `${o.host ? '⭐ ' : ''}${esc(o.user.name)}`
        : o.type === 'crowd' ? '👥 Chat vote'
        : `🤖 Bot${o.replaced ? ` <span class="muted">(for ${esc(o.replaced)})</span>` : ''}`;
      const active = (d && d.seat?.id === s.id ? ' active' : '') + (fresh(s) ? ' joined' : '');
      return `<div class="seat${active}" style="--c:${esc(s.color)}"><span class="chip"></span><span class="seat-name">${esc(s.name)}</span><span class="who">${who}</span></div>`;
    }).join('');
    this.prevSeatIds = ids;
  }

  #renderLobby(t) {
    if (this.s.phase !== 'lobby') return;
    const m = this.s.manifest;
    const mode = this.s.mode;
    const draw = mode?.entry === 'draw';
    const openSeat = this.seats.find((x) => !x.occupant) ?? m.seats[0];
    const recent = this.entrants.slice(-6).map((u) => esc(u.name)).join(', ');
    if (this.touch) {
      this.main.innerHTML = `<p>Choose the options on the left, then tap <b>Play</b>.</p>
        <p class="muted">${m.players.min === m.players.max ? `${m.players.min} players` : `${m.players.min}–${m.players.max} players`} · empty seats become bots</p>
        <div class="lobby-info"></div>`;
      this.#renderLobbyInfo();
      this.#renderLobbyStage(t);
      return;
    }
    this.main.innerHTML = `
      ${draw
        ? `<p>Type <b>${this.p}join</b> to enter. <span class="entrants"><b>${this.entrants.length}</b> entered${recent ? `: ${this.entrants.length > 6 ? '… ' : ''}${recent}` : ''}</span></p>`
        : `<p>Type <b>${this.p}join</b> or <b>${this.p}join ${esc(openSeat.id)}</b> to pick a color.</p>`}
      <p class="muted">${m.players.min === m.players.max ? `${m.players.min} players` : `${m.players.min}–${m.players.max} players`}${this.s.botFillTo ? ` · empty seats become bots` : ''}${m.modes?.length > 1 ? ` · mods: ${this.p}bg mode ${m.modes.map((x) => x.id).join('|')}` : ''}</p>
      ${t ? `<div class="label">Starting in</div>${this.#timerBar(t.endsAt, t.total, true)}` : '<div class="muted">Countdown starts with the first player.</div>'}
      <div class="lobby-info"></div>`;
    this.#renderLobbyInfo();
    this.#renderLobbyStage(t);
  }

  // Big "how to play" panel over the empty board area while the lobby is open.
  #renderLobbyStage(t) {
    const m = this.s.manifest;
    const mode = this.s.mode;
    const draw = mode?.entry === 'draw';
    const steps = mode?.howTo ?? m.howTo ?? [];
    const modCmds = (m.commands ?? []).filter((c) => c.cmd.startsWith(`${this.p}bg`) || c.cmd.startsWith('!bg'));
    const playerCmds = (m.commands ?? []).filter((c) => !modCmds.includes(c));
    const taken = this.seats.filter((s) => s.occupant && s.occupant.type !== 'reserved').length;
    const count = draw ? `<b>${this.entrants.length}</b> entered` : `<b>${taken}</b>/${m.players.max} seats taken`;
    const key = `${m.id}:${mode?.id ?? ''}`;
    const enter = this.lobbyStageKey !== key; // animate only when the panel first appears
    this.lobbyStageKey = key;
    this.lobbyStage.innerHTML = `
      <div class="ls-card${enter ? ' enter' : ''}">
        <div class="ls-head">
          ${m.thumbnailUrl ? `<img src="${esc(m.thumbnailUrl)}" alt="">` : ''}
          <div>
            <div class="ls-name">${esc(m.name)}</div>
            ${mode ? `<span class="mode-tag">${esc(mode.name)}</span>` : ''}
            ${mode?.description ? `<div class="ls-desc">${esc(mode.description)}</div>` : m.tagline ? `<div class="ls-desc">${esc(m.tagline)}</div>` : ''}
          </div>
        </div>
        ${steps.length ? `<h3>How to play</h3><ol class="ls-steps">${steps.map((s) => `<li><span>${highlightCommands(esc(s))}</span></li>`).join('')}</ol>` : ''}
        ${playerCmds.length && !steps.length ? `<div class="ls-cmds">${playerCmds.map((c) => `<span><b>${esc(c.cmd)}</b> ${esc(c.help)}</span>`).join('')}</div>` : ''}
        ${this.touch ? this.#touchLobbyControls() : `<div class="ls-cta">
          <div class="ls-join">Type <b>${this.p}join</b> ${draw ? 'to enter the draw' : 'to play'}<div class="ls-count-label">${count}</div></div>
          <div class="ls-countdown">${t ? `<div class="ls-secs" data-ends="${t.endsAt}">${Math.max(0, Math.ceil((t.endsAt - Date.now()) / 1000))}</div><div class="ls-sub">seconds</div>` : '<div class="ls-wait">Waiting for the first player…</div>'}</div>
        </div>`}
        ${modCmds.length && !this.touch ? `<div class="ls-mods">Mods: ${modCmds.map((c) => `<b>${esc(c.cmd)}</b> ${esc(c.help.replace(/^mods:\s*/, ''))}`).join(' · ')}</div>` : ''}
      </div>`;
    this.#tickLobbyStage();
  }

  // Touch lobby: mode and player-count chips plus a big Play button (join + start right away).
  // Modes that need chat (a crowd seat) or only draw viewers at random are left out on a phone.
  #touchLobbyControls() {
    const m = this.s.manifest;
    const modes = (m.modes ?? []).filter((md) => !Object.values(md.seats ?? {}).includes('crowd') && !(md.entry === 'draw' && !Object.values(md.seats ?? {}).includes('host')));
    const chip = (label, cmd, on) => `<button class="ls-chip${on ? ' on' : ''}" data-cmd="${esc(cmd)}">${esc(label)}</button>`;
    const modeRow = modes.length > 1
      ? `<div class="ls-row"><span class="ls-row-label">Mode</span>${modes.map((md) => chip(md.name, `${this.p}bg mode ${md.id}`, md.id === this.s.mode?.id)).join('')}</div>`
      : '';
    const min = Math.max(2, m.players.min);
    const counts = [];
    for (let n = min; n <= m.players.max; n++) counts.push(n);
    const fill = Math.max(min, this.s.botFillTo ?? min);
    const playersRow = counts.length > 1
      ? `<div class="ls-row"><span class="ls-row-label">Players</span>${counts.map((n) => chip(String(n), `${this.p}bg bots ${n}`, n === fill)).join('')}</div>`
      : '';
    return `<div class="ls-touch">${modeRow}${playersRow}
      <button class="ls-play" data-cmd="${this.p}join|${this.p}bg start">▶ Play</button></div>`;
  }

  // Updates the big countdown; the last 10 seconds pulse red.
  #tickLobbyStage() {
    clearTimeout(this.lobbyStageTimer);
    const node = this.lobbyStage.querySelector('.ls-secs');
    if (!node || this.s.phase !== 'lobby') return;
    const left = Math.max(0, Math.ceil((Number(node.dataset.ends) - Date.now()) / 1000));
    node.textContent = String(left);
    this.lobbyStage.querySelector('.ls-countdown').classList.toggle('urgent', left <= 10);
    if (left > 0) this.lobbyStageTimer = setTimeout(() => this.#tickLobbyStage(), 250);
  }

  // Game-specific lobby details (e.g. trivia categories and whether their questions are loaded).
  #renderLobbyInfo() {
    const box = this.main.querySelector('.lobby-info');
    if (!box || this.s.phase !== 'lobby') return;
    let info = null;
    try { info = this.s.module?.lobbyInfo?.(); } catch { /* ignore */ }
    if (!info) { box.innerHTML = ''; return; }
    box.innerHTML = `
      ${info.chips?.length ? `<div class="chips">${info.chips.map((c) => `<span style="--c:${esc(c.color)}" class="${c.ready === false ? 'loading' : ''}"><i></i>${esc(c.label)}${c.ready === false ? ' …' : ''}</span>`).join('')}</div>` : ''}
      ${info.note ? `<div class="note">${esc(info.note)}</div>` : ''}`;
  }

  #renderDecision(payload) {
    this.currentDecision = payload;
    this.#renderSeats();
    if (!payload) return;
    const { decision: d, seat, occupant } = payload;
    if (d.question) this.#renderQuestion(payload);
    else this.#hideQuestion();
    const who = occupant.type === 'human' ? occupant.user.name : occupant.type === 'crowd' ? 'Chat' : 'Bot';
    const showOptions = d.kind !== 'roll' || occupant.type !== 'bot';
    const tap = this.touch && occupant.type === 'human';
    const hint = tap ? (d.question ? 'Tap your answer on the question card' : d.kind === 'roll' ? 'Tap <b>Roll</b>' : 'Tap your move')
      : d.question ? (occupant.type === 'crowd' ? 'Chat votes on the answer — majority wins' : occupant.type === 'bot' ? 'Bot is thinking…' : `${who}, answer with the number on the question card`)
      : occupant.type === 'crowd' ? 'Chat votes — majority wins'
      : occupant.type === 'bot' ? 'Bot is thinking…'
      : d.kind === 'roll' ? `${who}, type <b>${this.p}roll</b>` : `${who}, type the number`;
    this.main.innerHTML = `
      <div class="turn" style="--c:${esc(seat.color)}"><span class="chip"></span>${esc(who)} <span class="muted">· ${esc(seat.name)}</span></div>
      <div class="prompt">${esc(d.prompt)}</div>
      ${this.#timerBar(payload.endsAt, payload.total)}
      <div class="hint">${hint}</div>
      ${!showOptions || d.question ? '' : this.#optionList(d, tap)}`;
  }

  // Hidden options (shortcuts) aren't listed; numbers stay their position in the full list.
  // 6+ options become a compact number grid unless the game asks for a list (decision.layout = 'list').
  // tap: the option is a button for the local player (shows the number without the prefix).
  #optionList(d, tap = false) {
    const shown = d.options.map((o, i) => ({ o, i })).filter(({ o }) => !o.hidden);
    const cmd = (i) => (tap ? ` data-cmd="${this.p}${i + 1}"` : '');
    const num = (i) => (tap ? String(i + 1) : `${this.p}${i + 1}`);
    if (shown.length >= 6 && d.layout !== 'list') {
      return `<ol class="options grid">${shown.map(({ o, i }) => `
        <li class="${o.disabled ? 'disabled' : ''}" title="${esc(o.label)}"${cmd(i)}><b>${num(i)}</b><em class="vote-count" data-i="${i}"></em></li>`).join('')}</ol>`;
    }
    return `<ol class="options${tap ? ' tap' : ''}">${shown.map(({ o, i }) => `
        <li class="${o.disabled ? 'disabled' : ''}"${cmd(i)}><b>${tap && o.alias && shown.length === 1 ? '▶' : o.alias && shown.length === 1 ? `${this.p}${esc(o.alias)}` : num(i)}</b><span>${esc(o.label)}</span><em class="vote-count" data-i="${i}"></em></li>`).join('')}</ol>`;
  }

  // Big question card over the board. Answers: !1…!n; the result is revealed via game events.
  #renderQuestion({ decision: d, seat, occupant, endsAt, total }) {
    const q = d.question;
    const who = occupant.type === 'human' ? (occupant.user.id === this.bridge.user?.id ? 'Your turn' : `${esc(occupant.user.name)} answers`) : occupant.type === 'crowd' ? 'Chat votes' : 'Bot answers';
    this.questionBox.innerHTML = `
      <div class="q-card" style="--c:${esc(q.color)}">
        <div class="q-head">
          <span class="q-cat">${esc(q.category)}</span>
          <span class="q-diff q-${esc(q.difficulty)}">${esc(q.difficulty)}</span>
          ${q.final ? '<span class="q-final">FINAL QUESTION</span>' : q.hq ? '<span class="q-hq">Wedge at stake</span>' : ''}
          <span class="q-who" style="--s:${esc(seat.color)}"><i></i>${who}</span>
        </div>
        <div class="q-text">${esc(q.text)}</div>
        <ol class="q-answers n${d.options.length}">${d.options.map((o, i) => `
          <li data-i="${i}"${this.touch && occupant.type === 'human' ? ` data-cmd="${this.p}${i + 1}"` : ''}><b>${this.touch ? i + 1 : `${this.p}${i + 1}`}</b><span>${esc(o.label)}</span><em class="vote-count" data-i="${i}"></em></li>`).join('')}</ol>
        ${this.#timerBar(endsAt, total)}
        <div class="q-result"></div>
        <div class="q-foot">${q.source === 'opentdb' ? 'Question: Open Trivia Database (opentdb.com) · CC BY-SA 4.0' : 'Built-in question (Open Trivia DB not reachable)'}</div>
      </div>`;
    this.questionBox.classList.add('show');
  }

  #hideQuestion() {
    if (this.questionReveal) return; // keep the revealed answer visible until it times out
    this.questionBox.classList.remove('show');
  }

  #onGameEvents(events) {
    const a = events.find((e) => e.type === 'answer');
    if (!a || !this.questionBox.classList.contains('show')) return;
    const items = this.questionBox.querySelectorAll('.q-answers li');
    items.forEach((li, i) => {
      if (i === a.correctIndex) li.classList.add('right');
      else if (i === a.chosen) li.classList.add('wrong');
      else li.classList.add('dim');
    });
    const bar = this.questionBox.querySelector('.timer');
    if (bar) bar.style.visibility = 'hidden';
    this.questionBox.querySelector('.q-result').innerHTML = a.correct
      ? '<span class="ok">✅ Correct!</span>'
      : `<span class="bad">${a.timeout ? "⏰ Time's up!" : '❌ Wrong!'}</span>`;
    this.questionReveal = true;
    clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => {
      this.questionReveal = false;
      if (!this.currentDecision?.decision?.question) this.questionBox.classList.remove('show');
    }, 2800);
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
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      node.textContent = `${left}s`;
      node.closest('.timer')?.classList.toggle('urgent', left <= 10);
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
    // The lobby's chat announcements ("Type !join …") make no sense when you play by tapping.
    if (this.touch && this.s.phase === 'lobby') return;
    const t = el('div', 'toast', esc(text));
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 4500);
    setTimeout(() => t.remove(), 5200);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
  }

  #gameOver({ winner, ranking, draw }) {
    const medals = ['🥇', '🥈', '🥉', '4.'];
    if (draw) {
      this.banner.innerHTML = `
      <div class="win" style="--c:#9aa3b5">
        <div class="trophy">🤝</div>
        <div class="who">Draw!</div>
        <div class="muted">${ranking.map((s) => esc(labelOf(s))).join(' vs ')}</div>
      </div>`;
      this.banner.classList.add('show');
      if (this.touch) this.banner.dataset.cmd = `${this.p}bg menu`;
      this.main.innerHTML = '<div class="muted">Back to game select shortly…</div>';
      return;
    }
    this.banner.innerHTML = `
      <div class="win" style="--c:${esc(winner.color)}">
        <div class="trophy">🏆</div>
        <div class="who">${esc(winner.label ?? labelOf(winner))}</div>
        <div class="muted">wins ${esc(this.s.manifest.name)}!</div>
        <ol>${ranking.map((s, i) => `<li><span>${medals[i] ?? `${i + 1}.`}</span>${esc(labelOf(s))}</li>`).join('')}</ol>
      </div>`;
    this.banner.classList.add('show');
    if (this.touch) this.banner.dataset.cmd = `${this.p}bg menu`;
    this.main.innerHTML = `<div class="muted">${this.s.config.afterGame === 'lobby' ? 'Rematch lobby opens shortly…' : 'Back to game select shortly…'}</div>`;
  }
}

function labelOf(seat) {
  const o = seat.occupant;
  if (o?.type === 'reserved') return `Streamer (${seat.name})`;
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

// "Type !roll …" → commands in a step get the accent color.
function highlightCommands(text) {
  return text.replace(/(![a-z0-9]+(?:[–-]![a-z0-9]+)?)/gi, '<b>$1</b>');
}
