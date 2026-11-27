// Same-WiFi multiplayer on top of net/transport.js.
//
// The host phone runs the real game (its Session decides everything: timers, bots, rules). Every
// other phone runs a follower Session with an identical copy of the game, kept in step by these
// messages (JSON, one per transport message):
//
//   phone → host   hello { user: {id, name}, version }      cmd { text }   ("!3", "!roll", …)
//   host → phone   welcome { hostName }  refuse { reason }  bye
//                  state { phase, gameId, modeId, seats, botFillTo }   (game select / lobby)
//                  start { spec }      apply { index, rngState, records }
//                  decision { ms, total }   seats { seats }   toast { text }
//
// Only option numbers travel during a game ("seat N chose option K") plus the RNG state, so
// every copy rolls the same dice even when the host's bots draw random numbers.
//
// Hidden-information games (Texas Hold 'em) work differently — replaying would hand every phone
// the deck. The host sends each phone only its own view:
//   hstart { spec: { …, view } }   hupdate { view, events, log, seat }   hover { ranking, draw }
// and decisions carry the decision itself (decision { ms, total, decision }).
//
// Stream sessions (stream: true, transport = RelayHost from net/relay.js): the host is the
// streamer's overlay and the phones are viewers on the internet. Differences: identities come
// from the session server (checked Twitch logins, transport.userOf), nobody is seated
// automatically (viewers tap Join, like typing !join), and a phone that drops keeps its seat for
// a grace period (a reconnect within it takes the seat back; hidden games resend its view).

const PROTOCOL = 1;
const release = (v) => String(v).split('.').slice(0, 2).join('.');

export class LanHost {
  // onChange(): the player list or status changed (for the UI).
  constructor({ session, transport, hostName, appVersion = null, onChange = () => {}, stream = false, graceMs = 30000 }) {
    Object.assign(this, { session, transport, hostName, appVersion, onChange, stream, graceMs });
    this.peers = new Map(); // peerId → { user } (user is null until hello)
    this.away = new Map();  // stream: user id → { user, timer } (dropped, seat kept for graceMs)
    this.offs = [];
    this.info = null;
    this.hiddenSpec = null;
  }

  get players() { return [...this.peers.values()].filter((p) => p.user).map((p) => p.user); }

  async start() {
    this.info = await this.transport.host({ name: this.hostName });
    const s = this.session;
    s.lanHost = true;
    const t = this.transport;
    const on = (emitter, ev, fn) => this.offs.push(emitter.on(ev, fn));
    on(t, 'peer', ({ peerId }) => { this.peers.set(peerId, { user: null }); });
    on(t, 'peerMessage', ({ peerId, data }) => this.#fromPeer(peerId, data));
    on(t, 'peerLeft', ({ peerId }) => this.#peerLeft(peerId));
    on(s, 'phase', (ph) => {
      if (ph === 'menu' || ph === 'lobby') this.#broadcast(this.#state());
      if (ph === 'lobby' && !this.stream) for (const u of this.players) s.join(u); // everyone connected plays
    });
    on(s, 'seats', (seats) => {
      if (s.phase === 'lobby') this.#broadcast(this.#state());
      else if (s.phase === 'playing') this.#broadcast({ t: 'seats', seats });
    });
    on(s, 'lanStart', (spec) => this.#broadcast({ t: 'start', spec }));
    on(s, 'lanApply', (m) => this.#broadcast({ t: 'apply', ...m }));
    // Hidden games: every phone gets its own view of the table, never the whole game.
    on(s, 'lanHiddenStart', (spec) => {
      this.hiddenSpec = spec;
      this.#eachPlayer((user) => ({ t: 'hstart', spec: { ...spec, view: s.game.viewFor(this.#seatOf(user)) } }));
    });
    on(s, 'lanHiddenUpdate', (m) => this.#eachPlayer((user) => ({ t: 'hupdate', ...m, view: s.game.viewFor(this.#seatOf(user)) })));
    on(s, 'gameOver', (o) => { if (s.hidden) this.#broadcast({ t: 'hover', ranking: o.ranking.map((seat) => seat.id), draw: o.draw }); });
    on(s, 'decision', (p) => {
      this.lastDecision = p;
      if (p) this.#broadcast({ t: 'decision', ms: p.endsAt - Date.now(), total: p.total, ...(s.hidden ? { decision: p.decision } : {}) });
    });
    on(s, 'toast', (text) => { if (!this.quiet) this.#broadcast({ t: 'toast', text }); });
    this.onChange();
    return this.info;
  }

  async stop() {
    this.#broadcast({ t: 'bye' });
    for (const off of this.offs) off();
    this.offs = [];
    this.session.lanHost = false;
    for (const p of this.peers.values()) if (p.user) this.session.leave(p.user);
    for (const a of this.away.values()) { clearTimeout(a.timer); this.session.leave(a.user); }
    this.away.clear();
    this.peers.clear();
    await this.transport.stopHost();
    this.onChange();
  }

  #state() {
    const s = this.session;
    return { t: 'state', phase: s.phase, gameId: s.manifest?.id ?? null, modeId: s.mode?.id ?? null, seats: s.seats ?? [], botFillTo: s.botFillTo ?? 0 };
  }

  #send(peerId, msg) { this.transport.sendTo(peerId, JSON.stringify(msg))?.catch?.(() => {}); }

  // The game seat a joined player plays, or null (watching).
  #seatOf(user) {
    const s = this.session;
    const g = (s.activeSeatIdx ?? []).findIndex((i) => s.seats[i]?.occupant?.user?.id === user.id);
    return g >= 0 ? g : null;
  }

  // A message made for each joined player (their own view).
  #eachPlayer(make) {
    for (const [peerId, p] of this.peers) if (p.user) this.#send(peerId, make(p.user));
  }

  #broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const [peerId, p] of this.peers) if (p.user) this.transport.sendTo(peerId, text)?.catch?.(() => {});
  }

  #fromPeer(peerId, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const peer = this.peers.get(peerId) ?? { user: null };
    this.peers.set(peerId, peer);
    if (m.t === 'hello' && this.stream) return this.#streamHello(peerId, peer, m);
    if (m.t === 'hello') {
      if (m.protocol !== PROTOCOL || (this.appVersion && m.version && m.version !== this.appVersion)) {
        this.#send(peerId, { t: 'refuse', reason: `Both phones need the same app version (host: ${this.appVersion ?? '?'}, yours: ${m.version ?? '?'}).` });
        return;
      }
      const name = String(m.user?.name ?? '').trim().slice(0, 25) || 'Player';
      // The phone's own player id, so it recognises its seat (ids are random per phone).
      const id = String(m.user?.id ?? '').slice(0, 40) || `lan-${peerId}`;
      if (this.players.some((u) => u.id === id) || id === this.session.bridge.user?.id) {
        this.#send(peerId, { t: 'refuse', reason: 'This phone is already in the game.' });
        return;
      }
      peer.user = { id, login: name.toLowerCase(), name, isBroadcaster: false, isMod: false };
      this.#send(peerId, { t: 'welcome', hostName: this.hostName });
      this.#send(peerId, this.#state());
      if (this.session.phase === 'lobby') this.session.join(peer.user);
      this.session.emit('toast', `${name} joined over WiFi`);
      this.onChange();
    } else if (m.t === 'cmd' && peer.user && typeof m.text === 'string') {
      this.session.handleChat({ user: peer.user, text: m.text.slice(0, 100), platform: 'lan' });
    }
  }

  // A viewer's phone in a stream session (identity checked by the session server).
  #streamHello(peerId, peer, m) {
    const s = this.session;
    // Phones update themselves, the streamer's companion app when they click Install: allow
    // patch releases to differ (x.y.*), the game rules only change in minor releases.
    if (m.protocol !== PROTOCOL || (this.appVersion && m.version && release(m.version) !== release(this.appVersion))) {
      this.#send(peerId, { t: 'refuse', reason: `Your app (${m.version ?? '?'}) and the stream (${this.appVersion ?? '?'}) run different versions. The app updates itself — close and reopen it. If that doesn't help, the streamer's companion app needs its update.` });
      return;
    }
    const checked = this.transport.userOf?.(peerId);
    if (!checked) return this.#send(peerId, { t: 'refuse', reason: 'Not logged in.' });
    const user = { id: checked.id, login: checked.login, name: checked.name, isBroadcaster: false, isMod: false, phone: true };
    user.isBroadcaster = !!s.bridge.isStreamer?.(user);
    // The same viewer again (reconnected, or a second phone): this connection takes over.
    for (const [id, p] of this.peers) if (id !== peerId && p.user?.id === user.id) this.peers.delete(id);
    const away = this.away.get(user.id);
    if (away) { clearTimeout(away.timer); this.away.delete(user.id); }
    peer.user = user;
    this.#send(peerId, { t: 'welcome', hostName: this.hostName });
    this.#send(peerId, this.#state());
    // Back in a running secret-card game: their own view of the table again.
    const seat = this.#seatOf(user);
    if (s.phase === 'playing' && s.hidden && seat !== null && this.hiddenSpec) {
      this.#send(peerId, { t: 'hstart', spec: { ...this.hiddenSpec, view: s.game.viewFor(seat) } });
      const d = this.lastDecision;
      if (d && s.decision) this.#send(peerId, { t: 'decision', ms: d.endsAt - Date.now(), total: d.total, decision: d.decision });
    }
    if (!away) {
      this.quiet = true; // for the stream overlay only, not the phones
      s.emit('toast', `📱 ${user.name} is here on their phone`);
      this.quiet = false;
    }
    this.onChange();
  }

  #peerLeft(peerId) {
    const p = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (p?.user && this.stream) {
      // Keep the seat a little while: phones drop when switching networks or locking the screen.
      const user = p.user;
      if (this.graceMs > 0 && this.session.seats?.some((x) => x.occupant?.user?.id === user.id)) {
        const timer = setTimeout(() => {
          this.away.delete(user.id);
          this.session.leave(user);
          this.onChange();
        }, this.graceMs);
        timer.unref?.();
        this.away.set(user.id, { user, timer });
      }
    } else if (p?.user) {
      this.session.leave(p.user);
      this.session.emit('toast', `${p.user.name} left`);
    }
    this.onChange();
  }
}

export class LanClient {
  // user: this phone's player ({ id, name }). onChange({ hostName, error, closed, waiting }).
  constructor({ session, transport, user, appVersion = null, onChange = () => {} }) {
    Object.assign(this, { session, transport, user, appVersion, onChange });
    this.chain = Promise.resolve();
    this.hostName = null;
    this.waiting = false; // joined during a game: watch the next one
    this.offs = [];
  }

  async join(address) {
    const t = this.transport;
    this.offs.push(t.on('message', ({ data }) => this.#fromHost(data)));
    this.offs.push(t.on('closed', ({ reason } = {}) => this.onChange({ closed: true, reason })));
    const info = await t.connect(address);
    await t.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, version: this.appVersion, user: { id: this.user.id, name: this.user.name } }));
    return info;
  }

  // A tap on this phone → the host decides.
  send(text) { this.transport.send(JSON.stringify({ t: 'cmd', text }))?.catch?.(() => {}); }

  async leave() {
    for (const off of this.offs) off();
    this.offs = [];
    await this.transport.disconnect();
  }

  #fromHost(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    // Strictly in order: a move's animation finishes before the next message is handled.
    this.chain = this.chain.then(() => this.#handle(m)).catch((err) => {
      console.error('[lan] lost sync', err);
      this.desynced = true;
      this.session.emit('toast', 'Lost sync with the host — you rejoin with the next game.');
    });
  }

  async #handle(m) {
    const s = this.session;
    switch (m.t) {
      case 'welcome':
        this.hostName = m.hostName;
        this.onChange({ hostName: m.hostName });
        break;
      case 'refuse':
        this.onChange({ error: m.reason });
        break;
      case 'bye':
        this.onChange({ closed: true, reason: 'The host stopped hosting.' });
        break;
      case 'toast':
        s.emit('toast', m.text);
        break;
      case 'state':
        this.desynced = false;
        if (m.phase === 'lobby' && m.gameId) { this.waiting = false; await s.followLobby(m); }
        else if (m.phase === 'menu') { this.waiting = false; s.followMenu(); }
        else if (m.phase === 'playing' && s.phase !== 'playing') { this.waiting = true; s.followMenu(); }
        this.onChange({ waiting: this.waiting });
        break;
      case 'start':
        this.desynced = false;
        this.waiting = false;
        await s.followStart(m.spec);
        this.onChange({ waiting: false });
        break;
      case 'apply':
        if (!this.desynced && !this.waiting) await s.followApply(m);
        break;
      case 'decision':
        if (!this.desynced && !this.waiting) s.followDecision(m);
        break;
      case 'seats':
        if (!this.waiting) s.followSeats(m.seats);
        break;
      case 'hstart':
        this.waiting = false;
        await s.followHiddenStart(m.spec);
        this.onChange({ waiting: false });
        break;
      case 'hupdate':
        if (!this.waiting) await s.followHiddenUpdate(m);
        break;
      case 'hover':
        if (!this.waiting) s.followHiddenOver(m);
        break;
    }
  }
}
