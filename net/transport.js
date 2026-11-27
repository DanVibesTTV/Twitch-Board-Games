// Moves text messages between phones on the same WiFi. Two implementations, same interface:
//
//   native — the Android app's Lan plugin (mobile/native/LanPlugin.java): a TCP server on the
//            host phone, Android network service discovery (NSD) to find it, one JSON message
//            per line.
//   bc     — BroadcastChannel between browser tabs of the same site, for testing without phones
//            (?lan=bc).
//
// Interface (an Emitter):
//   host({ name, port }) → { port, addresses }    stopHost()    sendTo(peerId, text)
//   discover()    stopDiscovery()
//   connect(address)    send(text)    disconnect()
// Events: 'peer' {peerId} · 'peerMessage' {peerId, data} · 'peerLeft' {peerId}
//         'found' {name, address} · 'lost' {name} · 'message' {data} · 'closed' {reason}

import { Emitter } from '../core/emitter.js';

export const LAN_PORT = 47823;

export function parseAddress(address) {
  const a = String(address ?? '').trim();
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1], port: Number(v6[2]) || LAN_PORT };
  const parts = a.split(':');
  if (parts.length === 2) return { host: parts[0], port: Number(parts[1]) || LAN_PORT };
  return { host: a, port: LAN_PORT };
}

export function createTransport(kind = 'native') {
  if (kind === 'bc') return typeof BroadcastChannel === 'function' ? new BroadcastTransport() : null;
  if (kind !== 'native') return null;
  const cap = globalThis.Capacitor;
  const plugin = cap?.isNativePlatform?.() ? (cap.Plugins?.Lan ?? cap.registerPlugin?.('Lan')) : null;
  return plugin ? new NativeTransport(plugin) : null;
}

class NativeTransport extends Emitter {
  constructor(plugin) {
    super();
    this.p = plugin;
    this.handles = [];
    for (const ev of ['peer', 'peerMessage', 'peerLeft', 'found', 'lost', 'message', 'closed']) {
      Promise.resolve(plugin.addListener(ev, (data) => this.emit(ev, data))).then((h) => this.handles.push(h));
    }
  }

  host({ name, port = LAN_PORT }) { return this.p.startHost({ name, port }); }
  stopHost() { return this.p.stopHost(); }
  sendTo(peerId, data) { return this.p.sendTo({ peerId, data }); }
  discover() { return this.p.discover(); }
  stopDiscovery() { return this.p.stopDiscovery(); }
  // "192.168.1.23", "192.168.1.23:47823" or "[fe80::1%wlan0]:47823"
  connect(address) {
    const { host, port } = parseAddress(address);
    return this.p.connect({ host, port });
  }
  send(data) { return this.p.send({ data }); }
  disconnect() { return this.p.disconnect(); }
}

// Browser tabs of the same site talk over one BroadcastChannel; every packet names sender and
// receiver. A host announces itself once a second so other tabs can list it.
class BroadcastTransport extends Emitter {
  constructor() {
    super();
    this.id = Math.random().toString(36).slice(2, 10);
    this.ch = new BroadcastChannel('stream-board-games-lan');
    this.ch.onmessage = (e) => this.#receive(e.data);
    this.peers = new Set();
    this.hostId = null;     // as a client: who we're connected to
    this.hosting = null;    // as a host: { name }
    this.seen = new Map();  // discover: hostId → last announce time
    addEventListener('pagehide', () => this.#post({ k: this.hosting ? 'hostbye' : 'bye', to: this.hostId }));
  }

  #post(packet) { this.ch.postMessage({ ...packet, from: this.id }); }

  #receive(m) {
    if (m.k === 'announce' && this.discovering) {
      if (!this.seen.has(m.from)) this.emit('found', { name: m.name, address: `bc:${m.from}` });
      this.seen.set(m.from, Date.now());
    }
    if (m.k === 'probe' && this.hosting) this.#post({ k: 'announce', name: this.hosting.name });
    if (m.to !== this.id) return;
    if (this.hosting) {
      if (m.k === 'hello') { this.peers.add(m.from); this.#post({ k: 'welcome', to: m.from }); this.emit('peer', { peerId: m.from }); }
      if (m.k === 'msg' && this.peers.has(m.from)) this.emit('peerMessage', { peerId: m.from, data: m.data });
      if (m.k === 'bye' && this.peers.delete(m.from)) this.emit('peerLeft', { peerId: m.from });
    } else if (m.from === this.hostId) {
      if (m.k === 'welcome') this.connected?.();
      if (m.k === 'msg') this.emit('message', { data: m.data });
      if (m.k === 'hostbye') { this.hostId = null; this.emit('closed', { reason: 'host stopped' }); }
    }
  }

  async host({ name }) {
    this.hosting = { name };
    this.#post({ k: 'announce', name });
    this.announcer = setInterval(() => this.#post({ k: 'announce', name }), 1000);
    return { port: 0, addresses: [`bc:${this.id}`] };
  }

  async stopHost() {
    clearInterval(this.announcer);
    for (const peer of this.peers) this.#post({ k: 'hostbye', to: peer });
    this.peers.clear();
    this.hosting = null;
  }

  async sendTo(peerId, data) { this.#post({ k: 'msg', to: peerId, data }); }

  async discover() {
    this.discovering = true;
    this.seen.clear();
    this.#post({ k: 'probe' });
    this.sweeper = setInterval(() => {
      for (const [id, t] of this.seen) if (Date.now() - t > 3500) { this.seen.delete(id); this.emit('lost', { address: `bc:${id}` }); }
    }, 1000);
  }

  async stopDiscovery() { this.discovering = false; clearInterval(this.sweeper); }

  connect(address) {
    const hostId = String(address).replace(/^bc:/, '');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.connected = null; reject(new Error('No game found at that address')); }, 3000);
      this.connected = () => { clearTimeout(timer); this.connected = null; resolve(); };
      this.hostId = hostId;
      this.#post({ k: 'hello', to: hostId });
    });
  }

  async send(data) { if (this.hostId) this.#post({ k: 'msg', to: this.hostId, data }); }

  async disconnect() {
    if (this.hostId) this.#post({ k: 'bye', to: this.hostId });
    this.hostId = null;
  }
}
