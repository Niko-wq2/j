// Bluetooth link to the tablet (Web Bluetooth; on iPhone use the Bluefy browser).
// Mirrors firmware/HomeworkTablet/proto.h:
//   message = [type u8][jsonLen u16 LE][json][blob]
//   packet  = [flags u8][payload]  flags: 1=start, 2=end, 0x80=ACK
// The receiver ACKs every 32 packets and at the end of each message;
// the sender waits for that ACK before sending more.

export const SVC = '8f1d0001-6c1a-4b8e-9d3a-5a2f7c0e1b01';
const RX = '8f1d0002-6c1a-4b8e-9d3a-5a2f7c0e1b01';   // we write
const TX = '8f1d0003-6c1a-4b8e-9d3a-5a2f7c0e1b01';   // we get notifications

export const PROTO = 3;
export const MSG = {
  HELLO: 0x01, MANIFEST: 0x02, BG: 0x03, GET_PAGE: 0x04, GET_STATUS: 0x05,
  HINT: 0x06, HINT_ERR: 0x07, DELETE: 0x08, NOTE: 0x09, OBJ: 0x0A, TEXT_CANCEL: 0x0B, BG_PART: 0x0C, GET_AUDIO: 0x0D,
  T_HELLO: 0x81, T_STATUS: 0x82, T_PAGE: 0x83, T_HINT_REQ: 0x84, T_ERROR: 0x85, T_TEXT_REQ: 0x86, T_CHANGED: 0x87, T_AUDIO: 0x88,
};

const F_START = 1, F_END = 2, F_ACK = 0x80, WINDOW = 32;
const enc = new TextEncoder(), dec = new TextDecoder();

export function buildMessage(type, json, blob) {
  const j = enc.encode(json ? JSON.stringify(json) : '');
  const b = blob ? new Uint8Array(blob) : new Uint8Array(0);
  const out = new Uint8Array(3 + j.length + b.length);
  out[0] = type; out[1] = j.length & 0xff; out[2] = j.length >> 8;
  out.set(j, 3); out.set(b, 3 + j.length);
  return out;
}

export function parseMessage(u8) {
  const type = u8[0], jl = u8[1] | (u8[2] << 8);
  const jsonText = dec.decode(u8.subarray(3, 3 + jl));
  let json = {};
  try { json = jsonText ? JSON.parse(jsonText) : {}; } catch (e) { /* ignore */ }
  return { type, json, blob: u8.slice(3 + jl) };
}

export class TabletLink extends EventTarget {
  constructor() {
    super();
    this.device = null; this.rx = null; this.tx = null;
    this.connected = false;
    this.maxPacket = 20;          // until the tablet tells us its MTU
    this.info = null;             // last T_HELLO
    this._writeChain = Promise.resolve();
    this._ackWaiters = [];
    this._rxBuf = []; this._rxLen = 0; this._rxCount = 0; this._inMsg = false;
    this._waiters = [];           // {match(msg)->bool, resolve, reject, timer}
    this._opChain = Promise.resolve();
    this._manualDisconnect = false;
  }

  get supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

  async choose() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }], optionalServices: [SVC] });
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());
    await this.connect();
  }

  async connect() {
    if (!this.device) throw new Error('No tablet chosen');
    this._manualDisconnect = false;
    this._emit('state', { state: 'connecting' });
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    this.rx = await svc.getCharacteristic(RX);
    // after a reconnect the browser may hand back the same object: never listen twice
    if (this.tx && this._onNotify) this.tx.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.tx = await svc.getCharacteristic(TX);
    this._onNotify = this._onNotify || (ev => {
      const dv = ev.target.value;
      this._onPacket(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    });
    this.tx.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.tx.startNotifications();
    this._rxBuf = []; this._rxLen = 0; this._rxCount = 0; this._inMsg = false;
    this.maxPacket = 20;
    this.connected = true;
    this._emit('state', { state: 'connected' });
  }

  disconnect() {
    this._manualDisconnect = true;
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  _onDisconnect() {
    this.connected = false;
    this.info = null;
    for (const w of this._ackWaiters.splice(0)) w.reject(new Error('Tablet disconnected'));
    for (const w of this._waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('Tablet disconnected')); }
    this._emit('state', { state: 'disconnected' });
    if (!this._manualDisconnect) this._autoReconnect();
  }

  // Keeps trying (quickly at first, then every 10 s) until the tablet is back or the user disconnects.
  async _autoReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    try {
      for (let i = 0; !this.connected && !this._manualDisconnect && this.device; i++) {
        await new Promise(r => { this._wake = r; setTimeout(r, Math.min(1000 * (i + 1), 10000)); });
        if (this.connected || this._manualDisconnect) break;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') continue;   // iOS won't connect in the background
        try { await this.connect(); this._emit('reconnected', {}); break; } catch (e) { /* keep trying */ }
      }
    } finally { this._reconnecting = false; }
  }

  // Coming back to the app: try again straight away.
  retryNow() {
    if (this.connected || this._manualDisconnect || !this.device) return;
    if (this._wake) this._wake();
    else this._autoReconnect();
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  // ---- low level writes (one GATT write at a time) ----
  _write(bytes) {
    const p = this._writeChain.then(() => {
      if (!this.connected) throw new Error('Tablet disconnected');
      return this.rx.writeValueWithoutResponse ? this.rx.writeValueWithoutResponse(bytes) : this.rx.writeValue(bytes);
    });
    this._writeChain = p.catch(() => {});
    return p;
  }

  _waitAck(ms = 8000) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      w.timer = setTimeout(() => {
        const i = this._ackWaiters.indexOf(w); if (i >= 0) this._ackWaiters.splice(i, 1);
        reject(new Error('Tablet stopped answering'));
      }, ms);
      const done = f => (...a) => { clearTimeout(w.timer); f(...a); };
      w.resolve = done(resolve); w.reject = done(reject);
      this._ackWaiters.push(w);
    });
  }

  async sendRaw(msg, onProgress) {
    const payload = Math.max(1, this.maxPacket - 1);
    let pos = 0, sent = 0;
    do {
      const n = Math.min(payload, msg.length - pos);
      const pkt = new Uint8Array(n + 1);
      pkt[0] = (pos === 0 ? F_START : 0) | (pos + n >= msg.length ? F_END : 0);
      pkt.set(msg.subarray(pos, pos + n), 1);
      const ackP = ((++sent) % WINDOW === 0 || pos + n >= msg.length) ? this._waitAck() : null;
      await this._write(pkt);
      pos += n;
      if (ackP) { await ackP; if (onProgress) onProgress(pos, msg.length); }
    } while (pos < msg.length);
  }

  // ---- receiving ----
  _onPacket(u8) {
    if (!u8.length) return;
    const f = u8[0];
    if (f & F_ACK) { const w = this._ackWaiters.shift(); if (w) w.resolve(); return; }
    if (f & F_START) { this._rxBuf = []; this._rxLen = 0; this._inMsg = true; }
    if (this._inMsg) { this._rxBuf.push(u8.slice(1)); this._rxLen += u8.length - 1; }
    this._rxCount++;
    for (const w of this._waiters) if (w.onProgress) w.onProgress(this._rxLen);
    if (this._rxCount >= WINDOW || (f & F_END)) {
      this._rxCount = 0;
      this._write(new Uint8Array([F_ACK])).catch(() => {});
    }
    if ((f & F_END) && this._inMsg) {
      this._inMsg = false;
      const all = new Uint8Array(this._rxLen);
      let o = 0; for (const c of this._rxBuf) { all.set(c, o); o += c.length; }
      this._rxBuf = [];
      this._onMessage(parseMessage(all));
    }
  }

  _onMessage(m) {
    if (m.type === MSG.T_HELLO && m.json.mtu) this.maxPacket = Math.min(Math.max(20, m.json.mtu - 3), 512);
    const i = this._waiters.findIndex(w => w.match(m));
    if (i >= 0) {
      const w = this._waiters.splice(i, 1)[0];
      clearTimeout(w.timer); w.resolve(m);
      return;
    }
    this._emit('message', m);
  }

  // ---- high level ----
  // Run link operations one after another so a hint request can slot in between sync steps.
  op(fn) {
    const p = this._opChain.then(fn);
    this._opChain = p.catch(() => {});
    return p;
  }

  send(type, json, blob, onProgress) {
    return this.op(() => this.sendRaw(buildMessage(type, json, blob), onProgress));
  }

  // Send a message and wait for a reply matching `match`.
  request(type, json, match, { timeout = 20000, onProgress } = {}) {
    return this.op(async () => {
      let waiter;
      const p = new Promise((resolve, reject) => {
        waiter = { match, resolve, reject, onProgress };
        const arm = () => { clearTimeout(waiter.timer); waiter.timer = setTimeout(() => {
          const i = this._waiters.indexOf(waiter); if (i >= 0) this._waiters.splice(i, 1);
          reject(new Error('Tablet did not reply'));
        }, timeout); };
        waiter.onProgress = n => { arm(); if (onProgress) onProgress(n); };
        arm();
        this._waiters.push(waiter);
      });
      await this.sendRaw(buildMessage(type, json));
      return p;
    });
  }

  async hello(pin, app) {
    const tz = -new Date().getTimezoneOffset();
    const m = await this.request(MSG.HELLO, { t: Math.floor(Date.now() / 1000), tz, pin: String(pin || ''), proto: PROTO, app: app || '' },
      x => x.type === MSG.T_HELLO, { timeout: 10000 });
    this.info = m.json;
    this._emit('hello', m.json);
    return m.json;
  }
}
