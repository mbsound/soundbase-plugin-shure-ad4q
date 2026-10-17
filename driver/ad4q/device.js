// One AD4Q: a held-open session, typed reads and writes, and the property
// changes the unit pushes. Writes are read back, because a SET the unit
// accepts and one it silently ignores look the same until you look.

import { EventEmitter } from 'node:events';
import { DMP, dmpBatch, dmpPdu } from '../acn/pdu.js';
import { AcnSession } from '../acn/session.js';
import { localInterfaceFor } from '../netutil.js';
import { DEFAULT_DEVICE_PORT } from '../acn/slp.js';
import {
  CHANNEL_COUNT,
  CHANNEL_PROPS,
  CH,
  DEV,
  DEVICE_PROPS,
  LEVEL_PROP,
  TONE_OFF_DB,
  chanAddr,
  decodeProp,
  diversityRaw,
  encodeBool,
  encodeString,
  encodeU16,
  encodeU32,
  encodeU8,
  iaIndex,
  decodeTalk,
  mhzToKhz,
  rfPowerRaw,
  rosterAddrs,
  rosterIdAddr,
  unregisteredIndex,
  withTalkOutput,
} from './properties.js';

const REQUEST_TIMEOUT_MS = 3000;
const BATCH = 8;

const signedByte = (n) => encodeU8(n & 0xff);

/**
 * How each writable property goes onto the wire: its address and the value
 * encoding. A `channel` property is addressed per channel.
 */
const WRITES = Object.freeze({
  name: { obj: CH.NAME, encode: (v) => encodeString(v) },
  gainDb: { obj: CH.GAIN_DB, encode: (v) => signedByte(Math.round(v)) },
  muted: { obj: CH.MUTE, encode: (v) => encodeBool(v) },
  overloadHold: { obj: CH.OVERLOAD_HOLD, encode: (v) => encodeBool(v) },
  toneFreqHz: { obj: CH.TONE_FREQ_HZ, encode: (v) => encodeU16(Math.round(v)) },
  toneLevelDb: { obj: CH.TONE_LEVEL_DB, encode: (v) => signedByte(v == null ? TONE_OFF_DB : Math.round(v)) },
  frequencyMhz: { obj: CH.FREQ_KHZ, encode: (v) => encodeU32(mhzToKhz(v)) },
  diversity: { obj: CH.DIVERSITY, encode: (v) => encodeU8(diversityRaw(v)) },
  interferenceAvoidance: { obj: CH.INTERFERENCE_AVOIDANCE, encode: (v) => encodeU8(iaIndex(v)) },
  unregisteredTx: { obj: CH.UNREGISTERED_TX, encode: (v) => encodeU8(unregisteredIndex(v)) },
  rfPower: { obj: CH.RF_POWER, encode: (v) => encodeU8(rfPowerRaw(v)) },
});

const DEVICE_WRITES = Object.freeze({
  name: { addr: DEV.NAME, encode: (v) => encodeString(v) },
  fanAlwaysOn: { addr: DEV.FAN_ALWAYS_ON, encode: (v) => encodeBool(v) },
  powerLock: { addr: DEV.POWER_LOCK, encode: (v) => encodeBool(v) },
  panelLock: { addr: DEV.PANEL_LOCK, encode: (v) => encodeBool(v) },
});

export class WriteRefused extends Error {
  constructor(addr, reason) {
    super(`the unit refused the write to 0x${addr.toString(16)} (reason ${reason})`);
    this.addr = addr;
    this.reason = reason;
  }
}

export class Ad4qDevice extends EventEmitter {
  /**
   * @param {{
   *   host: string, port?: number, cid?: string|null,
   *   browser?: { find(ip: string, ms: number): Promise<object|null> },
   *   localIp?: string, advert?: boolean, timings?: object,
   *   requestTimeoutMs?: number, log?: (level: string, message: string) => void,
   * }} options
   */
  constructor({
    host,
    port = DEFAULT_DEVICE_PORT,
    cid = null,
    browser = null,
    localIp = null,
    advert = true,
    timings,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    log = () => {},
  }) {
    super();
    this.host = host;
    this.port = port;
    this.cid = cid;
    this.browser = browser;
    this.localIp = localIp;
    this.advert = advert;
    this.timings = timings;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.session = null;
    this.pending = new Map(); // addr -> [{ kind, resolve, reject, timer }]
    this.values = new Map(); // addr -> Buffer, the last value heard
    this.timeouts = 0;
    this.closed = false;
  }

  get connected() {
    return !!this.session?.ready && !this.closed;
  }

  async connect() {
    if (!this.cid) {
      const unit = await this.browser?.find(this.host, 6000);
      if (!unit) throw new Error(`no AD4Q is advertising at ${this.host}`);
      this.cid = unit.cid;
      this.port = unit.port;
    }
    const localIp = this.localIp ?? localInterfaceFor(this.host)?.address;
    if (!localIp) throw new Error('this computer has no network interface that can reach the unit');
    const session = new AcnSession({
      host: this.host,
      port: this.port,
      deviceCid: Buffer.from(this.cid, 'hex'),
      localIp,
      advert: this.advert,
      timings: this.timings,
      log: this.log,
    });
    session.on('dmp', (pdu) => this.#onDmp(pdu));
    session.on('error', (err) => this.#lost(err));
    session.on('leaving', () => this.#lost(new Error('the unit ended the session')));
    this.session = session;
    await session.connect();
  }

  #lost(err) {
    if (this.closed) return;
    this.emit('lost', err);
  }

  // --- inbound -------------------------------------------------------------------

  #onDmp({ vector, addr, value }) {
    this.timeouts = 0;
    if (vector === DMP.GET_REPLY || vector === DMP.EVENT) {
      this.values.set(addr, value);
      const decoded = decodeProp(addr, value);
      if (decoded && (decoded.value != null || decoded.nullable)) this.emit('prop', decoded);
      this.#settle(addr, 'ok', value, vector);
    } else if (vector === DMP.GET_FAIL) {
      this.#settle(addr, 'fail', value[0], vector);
    } else if (vector === DMP.SET_FAIL) {
      this.#settle(addr, 'fail', value[0], vector);
    }
  }

  #settle(addr, outcome, payload, vector) {
    const queue = this.pending.get(addr);
    if (!queue?.length) return;
    // a SET_FAIL answers a set; a failed GET answers a get; a value answers either
    const index = queue.findIndex((p) =>
      outcome === 'ok' ? true : vector === DMP.SET_FAIL ? p.kind === 'set' : p.kind === 'get'
    );
    if (index < 0) return;
    const [request] = queue.splice(index, 1);
    clearTimeout(request.timer);
    if (!queue.length) this.pending.delete(addr);
    if (outcome === 'ok') request.resolve(payload);
    else request.reject(request.kind === 'set' ? new WriteRefused(addr, payload) : new Error(`the unit has no value at 0x${addr.toString(16)} (reason ${payload})`));
  }

  #await(addr, kind) {
    let request;
    const promise = new Promise((resolve, reject) => {
      request = { kind, resolve, reject, timer: null };
      request.timer = setTimeout(() => {
        this.#drop(addr, request);
        this.#missed();
        reject(new Error(`no answer from the unit for 0x${addr.toString(16)}`));
      }, this.requestTimeoutMs);
      const queue = this.pending.get(addr) ?? [];
      queue.push(request);
      this.pending.set(addr, queue);
    });
    promise.catch(() => {});
    return { promise, cancel: () => this.#drop(addr, request) };
  }

  #drop(addr, request) {
    clearTimeout(request.timer);
    const queue = this.pending.get(addr) ?? [];
    const i = queue.indexOf(request);
    if (i >= 0) queue.splice(i, 1);
    if (!queue.length) this.pending.delete(addr);
  }

  #missed() {
    this.timeouts += 1;
    if (this.timeouts >= 6) this.#lost(new Error('the unit has stopped answering'));
  }

  /** Send `pdu`, then wait for the unit's answer for `addr`; a failed send cancels the wait. */
  async #ask(addr, kind, pdu, options) {
    const answer = this.#await(addr, kind);
    try {
      await this.session.send(pdu, options);
    } catch (err) {
      answer.cancel();
      this.#missed();
      throw err;
    }
    return answer.promise;
  }

  // --- reads -----------------------------------------------------------------------

  /** One value, or a rejection if the unit has none or does not answer. */
  async get(addr) {
    return this.#ask(addr, 'get', dmpPdu(DMP.GET, addr));
  }

  /** Many values at once: a Map of address to value, leaving out any the unit did not give. */
  async getMany(addrs) {
    const results = new Map();
    const waits = addrs.map((addr) => {
      const answer = this.#await(addr, 'get');
      answer.promise.then(
        (value) => results.set(addr, value),
        () => {}
      );
      return answer;
    });
    try {
      for (let i = 0; i < addrs.length; i += BATCH) {
        await this.session.send(dmpBatch(DMP.GET, addrs.slice(i, i + BATCH)));
      }
    } catch (err) {
      for (const wait of waits) wait.cancel();
      this.#missed();
      throw err;
    }
    await Promise.all(waits.map((w) => w.promise.catch(() => {})));
    return results;
  }

  /** Ask the unit to push this property whenever it changes. */
  async subscribe(addrs) {
    for (let i = 0; i < addrs.length; i += BATCH) {
      await this.session.send(dmpBatch(DMP.SUBSCRIBE, addrs.slice(i, i + BATCH)));
    }
  }

  /** Everything the plugin models, as `{ device, channels: { 1: {...}, … } }`. */
  async readAll() {
    const wanted = [
      ...DEVICE_PROPS.map((p) => p.addr),
      ...Array.from({ length: CHANNEL_COUNT }, (_, c) => CHANNEL_PROPS.map((p) => chanAddr(c + 1, p.obj))).flat(),
    ];
    const got = await this.getMany(wanted);
    const state = { device: {}, channels: {} };
    for (const [addr, value] of got) {
      const decoded = decodeProp(addr, value);
      if (!decoded || (decoded.value == null && !decoded.nullable)) continue;
      if (decoded.channel == null) state.device[decoded.key] = decoded.value;
      else (state.channels[decoded.channel] ??= {})[decoded.key] = decoded.value;
    }
    return state;
  }

  /** Subscribe to every modelled property, and the live level. */
  async subscribeAll() {
    const addrs = [
      ...DEVICE_PROPS.map((p) => p.addr),
      ...Array.from({ length: CHANNEL_COUNT }, (_, c) => [
        ...[...CHANNEL_PROPS, LEVEL_PROP].map((p) => chanAddr(c + 1, p.obj)),
        // the roster slots only fill briefly during an IR sync, so they are watched, not polled
        ...rosterAddrs(c + 1),
      ]).flat(),
    ];
    await this.subscribe(addrs);
  }

  // --- writes ----------------------------------------------------------------------

  /** Write raw bytes, and resolve with what the unit then reports for the address. */
  async set(addr, value) {
    return this.#ask(addr, 'set', dmpPdu(DMP.SET, addr, value), { commit: true });
  }

  /**
   * Write one channel setting and return what the unit now holds, read back
   * from it. Throws `WriteRefused` if the unit rejects the value.
   */
  async setChannel(channel, key, value) {
    const write = WRITES[key];
    if (!write) throw new RangeError(`${key} is not a writable channel setting`);
    const addr = chanAddr(channel, write.obj);
    await this.set(addr, write.encode(value));
    return this.#readBack(addr);
  }

  async setDevice(key, value) {
    const write = DEVICE_WRITES[key];
    if (!write) throw new RangeError(`${key} is not a writable device setting`);
    await this.set(write.addr, write.encode(value));
    return this.#readBack(write.addr);
  }

  /**
   * Switch one talk-switch output on or off. The eight routings share a byte,
   * so the current byte is read first and only the one bit changes.
   */
  async setTalkOutput(channel, outputId, on) {
    const addr = chanAddr(channel, CH.TALK_ROUTING);
    const current = await this.get(addr);
    if (!current || current.length !== 1) throw new Error('the unit gave no talk-switch routing to change');
    await this.set(addr, Buffer.from([withTalkOutput(current[0], outputId, on)]));
    return decodeTalk(await this.get(addr))?.[outputId] ?? null;
  }

  /** Clear one registered-transmitter slot (1 to 8), as an unlink does. */
  async unlinkSlot(channel, slot) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 8) throw new RangeError('slot must be 1..8');
    await this.set(rosterIdAddr(channel, slot), Buffer.alloc(16));
  }

  async #readBack(addr) {
    const value = await this.get(addr);
    return decodeProp(addr, value)?.value ?? null;
  }

  // --- closing ---------------------------------------------------------------------

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.pending.values()) {
      for (const request of queue) {
        clearTimeout(request.timer);
        request.reject(new Error('the session closed'));
      }
    }
    this.pending.clear();
    await this.session?.close();
    this.session = null;
  }
}
