// A small WebSocket server (RFC 6455) without dependencies: text messages, ping/pong, close.
// Enough for the session server (app/session-server.mjs); browsers and Node 22's built-in
// WebSocket are the clients.
//
//   const ws = acceptWebSocket(req, socket, head, { maxBytes });   // inside server.on('upgrade')
//   ws.on('message', (text) => …); ws.on('close', (code, reason) => …);
//   ws.send(text); ws.close(code, reason);

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptWebSocket(req, socket, head, { maxBytes = 64 * 1024, pingMs = 25000 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConnection(socket, head, { maxBytes, pingMs });
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, head, { maxBytes, pingMs }) {
    super();
    this.socket = socket;
    this.maxBytes = maxBytes;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];      // fragments of a message in progress
    this.partBytes = 0;
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this.#parse(); });
    socket.on('close', () => this.#closed(1006, ''));
    socket.on('error', () => this.#closed(1006, ''));
    // Keeps proxies (Cloudflare drops idle connections after ~100 s) and NAT entries alive, and
    // notices phones that vanished without closing.
    this.timer = setInterval(() => {
      if (!this.alive) { this.socket.destroy(); return; }
      this.alive = false;
      this.#frame(0x9, Buffer.alloc(0));
    }, pingMs);
    this.timer.unref?.();
    if (this.buf.length) queueMicrotask(() => this.#parse());
  }

  send(text) {
    if (this.open) this.#frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.#frame(0x8, body);
    this.socket.end();
    this.#closed(code, reason);
  }

  #frame(op, payload) {
    if (this.socket.destroyed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n])
      : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }

  #parse() {
    while (this.open && this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) return this.close(1009, 'message too big');
        len = Number(big); off = 10;
      }
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (len > this.maxBytes) return this.close(1009, 'message too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.alive = true;

      if (op === 0x8) { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (this.open) { this.#frame(0x8, payload.subarray(0, 2)); this.socket.end(); }
        return this.#closed(code, reason);
      }
      if (op === 0x9) { this.#frame(0xA, payload); continue; } // ping → pong
      if (op === 0xA) continue;                                  // pong
      if (op === 0x2) return this.close(1003, 'text messages only');
      if (op !== 0x0 && op !== 0x1) return this.close(1002, 'unknown opcode');
      if (op === 0x1 && this.parts.length) return this.close(1002, 'unfinished message');
      if (op === 0x0 && !this.parts.length) return this.close(1002, 'nothing to continue');
      this.parts.push(payload);
      this.partBytes += payload.length;
      if (this.partBytes > this.maxBytes) return this.close(1009, 'message too big');
      if (!fin) continue;
      const text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this.partBytes = 0;
      this.emit('message', text);
    }
  }

  #closed(code, reason) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.timer);
    if (!this.socket.destroyed) this.socket.destroySoon?.();
    this.emit('close', code, reason);
  }
}
