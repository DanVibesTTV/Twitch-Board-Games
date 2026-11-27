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

const PROTOCOL = 1;

export class LanHost {
  // onChange(): the player list or status changed (for the UI).
  constructor({ session, transport, hostName, appVersion = null, onChange = () => {} }) {
    Object.assign(this, { session, transport, hostName, appVersion, onChange });
    this.peers = new Map(); // peerId → { user } (user is null until hello)
    this.offs = [];
    this.info = null;
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
      if (ph === 'lobby') for (const u of this.players) s.join(u); // everyone connected plays
    });
    on(s, 'seats', (seats) => {
      if (s.phase === 'lobby') this.#broadcast(this.#state());
      else if (s.phase === 'playing') this.#broadcast({ t: 'seats', seats });
    });
    on(s, 'lanStart', (spec) => this.#broadcast({ t: 'start', spec }));
    on(s, 'lanApply', (m) => this.#broadcast({ t: 'apply', ...m }));
    on(s, 'decision', (p) => p && this.#broadcast({ t: 'decision', ms: p.endsAt - Date.now(), total: p.total }));
    on(s, 'toast', (text) => this.#broadcast({ t: 'toast', text }));
    this.onChange();
    return this.info;
  }

  async stop() {
    this.#broadcast({ t: 'bye' });
    for (const off of this.offs) off();
    this.offs = [];
    this.session.lanHost = false;
    for (const p of this.peers.values()) if (p.user) this.session.leave(p.user);
    this.peers.clear();
    await this.transport.stopHost();
    this.onChange();
  }

  #state() {
    const s = this.session;
    return { t: 'state', phase: s.phase, gameId: s.manifest?.id ?? null, modeId: s.mode?.id ?? null, seats: s.seats ?? [], botFillTo: s.botFillTo ?? 0 };
  }

  #send(peerId, msg) { this.transport.sendTo(peerId, JSON.stringify(msg))?.catch?.(() => {}); }

  #broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const [peerId, p] of this.peers) if (p.user) this.transport.sendTo(peerId, text)?.catch?.(() => {});
  }

  #fromPeer(peerId, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const peer = this.peers.get(peerId) ?? { user: null };
    this.peers.set(peerId, peer);
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

  #peerLeft(peerId) {
    const p = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (p?.user) {
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
    await t.connect(address);
    await t.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, version: this.appVersion, user: { id: this.user.id, name: this.user.name } }));
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
    }
  }
}
