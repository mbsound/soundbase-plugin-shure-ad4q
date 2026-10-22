// One AD4Q: a held-open session, typed reads and writes, and the property
// changes the unit pushes. Writes are read back, because a SET the unit
// accepts and one it silently ignores look the same until you look.

import { EventEmitter } from 'node:events';
import { DMP, dmpBatch, dmpPdu, strBatch } from '../acn/pdu.js';
import { AcnSession } from '../acn/session.js';
import { localInterfaceFor } from '../netutil.js';
import { DEFAULT_DEVICE_PORT } from '../acn/slp.js';
import {
  CHANNEL_COUNT,
  CHANNEL_PROPS,
  CH,
  DEV,
  DEVICE_PROPS,
  METER_PROPS,
  TONE_OFF_DB,
  chanAddr,
  channelsFor,
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
  modelOf,
  rfPowerRaw,
  rosterAddrs,
  rosterIdAddr,
  unregisteredIndex,
  withTalkOutput,
} from './properties.js';
import {
  ANTENNAS,
  SCAN_OBJ,
  SCAN_LIMITS,
  SCAN_STATUS,
  configEntries,
  dataKey,
  parseDataEvent,
  scanDurationMs,
  statusKeys,
} from './scan.js';

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
  // 0x03 is on, 0x00 off; the transmitters need an IR sync afterwards for the new key
  encryption: { obj: CH.ENCRYPTION, encode: (v) => encodeU8(v ? 0x03 : 0x00) },
});

const DEVICE_WRITES = Object.freeze({
  name: { addr: DEV.NAME, encode: (v) => encodeString(v) },
  fanAlwaysOn: { addr: DEV.FAN_ALWAYS_ON, encode: (v) => encodeBool(v) },
  powerLock: { addr: DEV.POWER_LOCK, encode: (v) => encodeBool(v) },
  panelLock: { addr: DEV.PANEL_LOCK, encode: (v) => encodeBool(v) },
  // accepted and read back at once; the unit then restarts itself about 18 s later
  hdMode: { addr: DEV.HD_MODE, encode: (v) => encodeBool(v) },
  // a plain string; applies live, and the channels retune to the new band
  band: { addr: DEV.BAND, encode: (v) => encodeString(v) },
  antennaBias: { addr: DEV.ANTENNA_BIAS, encode: (v) => encodeBool(v) },
});

export class WriteRefused extends Error {
  constructor(addr, reason) {
    super(`the unit refused the write to 0x${addr.toString(16)} (reason ${reason})`);
    this.addr = addr;
    this.reason = reason;
  }
}

/** A scan stopped because the caller asked it to. */
export class ScanAborted extends Error {
  constructor() {
    super('the scan was stopped');
  }
}

/** A scan that did not come back as planned: the unit sent something other than what was asked for. */
export class ScanFailed extends Error {}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `done` until it holds; throws on timeout or if `signal` aborts. */
async function waitFor(done, timeoutMs, { signal, what }) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (signal?.aborted) throw new ScanAborted();
    if (Date.now() > deadline) throw new ScanFailed(`the unit did not ${what} in time`);
    await delay(25);
  }
}

export class Ad4qDevice extends EventEmitter {
  /**
   * @param {{
   *   host: string, port?: number, cid?: string|null,
   *   browser?: { find(ip: string, ms: number): Promise<object|null> },
   *   localIp?: string, advert?: boolean, timings?: object,
   *   requestTimeoutMs?: number, scanStallMs?: number, log?: (level: string, message: string) => void,
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
    channels = null,
    controllerCid = null,
    log = () => {},
    scanStallMs = 20_000,
  }) {
    super();
    // an AD4D has two channels; asking it for four leaves reads that are never answered
    this.channels = channels ?? CHANNEL_COUNT;
    this.channelsGiven = channels != null;
    this.controllerCid = controllerCid;
    this.host = host;
    this.port = port;
    this.cid = cid;
    this.browser = browser;
    this.localIp = localIp;
    this.advert = advert;
    this.timings = timings;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    // how long a triggered scan may go without a sample before it is called stalled
    this.scanStallMs = scanStallMs;
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
      // the advert says which receiver this is, unless the caller already did
      if (!this.channelsGiven) this.channels = channelsFor(modelOf(unit.fctn));
    }
    const localIp = this.localIp ?? localInterfaceFor(this.host)?.address;
    if (!localIp) throw new Error('this computer has no network interface that can reach the unit');
    const session = new AcnSession({
      host: this.host,
      port: this.port,
      deviceCid: Buffer.from(this.cid, 'hex'),
      localIp,
      advert: this.advert,
      cid: this.controllerCid,
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

  #onDmp({ vector, addr, key, value }) {
    if (process.env.AD4Q_DEBUG === '1') {
      const at = key !== undefined ? JSON.stringify(key) : addr === null ? 'none' : `0x${addr.toString(16)}`;
      this.log('debug', `DMP vector=0x${vector.toString(16)} addr=${at} value=${value.toString('hex').slice(0, 80)}`);
    }
    this.timeouts = 0;
    if (key !== undefined) {
      // a string-keyed property: the RF scan's status and samples
      this.emit('string', { vector, key, value });
      return;
    }
    if (addr === null) {
      // no address to match: the unit's answer to the commit that followed a SET
      this.#setProcessed();
      return;
    }
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

  /**
   * An AD4D applies a committed SET and answers it without naming an address or
   * echoing the value, so the oldest waiting SET is done. What the unit now holds
   * is still found out by the read-back that follows every write.
   */
  #setProcessed() {
    for (const [addr, queue] of this.pending) {
      const index = queue.findIndex((p) => p.kind === 'set');
      if (index < 0) continue;
      const [request] = queue.splice(index, 1);
      clearTimeout(request.timer);
      if (!queue.length) this.pending.delete(addr);
      request.resolve(Buffer.alloc(0));
      return;
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
      ...Array.from({ length: this.channels }, (_, c) => CHANNEL_PROPS.map((p) => chanAddr(c + 1, p.obj))).flat(),
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
      ...Array.from({ length: this.channels }, (_, c) => [
        ...[...CHANNEL_PROPS, ...METER_PROPS].map((p) => chanAddr(c + 1, p.obj)),
        // the roster slots only fill briefly during an IR sync, so they are watched, not polled
        ...rosterAddrs(c + 1),
      ]).flat(),
    ];
    await this.subscribe(addrs);
  }


  // --- RF scan ---------------------------------------------------------------------

  /** What this unit says about its own scan, in kHz: `{ startKhz, stopKhz, originKhz, stepKhz }`. */
  async scanLimits() {
    const got = await this.getMany(Object.values(SCAN_LIMITS));
    const khz = (addr) => {
      const v = got.get(addr);
      return v && v.length === 4 ? v.readUInt32BE(0) : null;
    };
    const limits = {
      startKhz: khz(SCAN_LIMITS.START),
      stopKhz: khz(SCAN_LIMITS.STOP),
      originKhz: khz(SCAN_LIMITS.ORIGIN),
      stepKhz: khz(SCAN_LIMITS.STEP),
    };
    if (Object.values(limits).some((v) => v === null)) throw new ScanFailed('the unit did not report its scan limits');
    return limits;
  }

  /**
   * Scan one antenna of one channel over `plan` (see `planScan`) and return its levels in
   * dBm, one per 25 kHz from `plan.startKhz`. It does what Wireless Workbench does: watch
   * the status, declare the whole range, write the configuration, trigger, collect the
   * chunks, then release and unsubscribe. Takes about 21 ms a point.
   *
   * `signal` stops the wait; the unit finishes the scan it was told to run, so this does not
   * return until it has, and another scan cannot be started before then.
   */
  async scan({ channel, antenna, plan, signal, onProgress }) {
    if (!ANTENNAS[antenna]) throw new RangeError(`antenna must be A or B (got ${antenna})`);
    if (this.scanning) throw new ScanFailed('a scan is already running on this unit');
    this.scanning = true;
    const ch = channel - 1;
    const keys = statusKeys(ch);
    const curve = ANTENNAS[antenna].curve;
    const data = dataKey(ch, curve, plan.loIndex, plan.hiIndex);

    const levels = new Array(plan.points).fill(NaN);
    const refused = new Set();
    let received = 0;
    let strays = 0;
    let status = null;
    let sawActive = false;
    let triggered = false;
    let triggeredAt = 0;
    let lastChunkAt = 0;
    // the curve the samples are taken from: what was asked for, unless the unit names it differently
    let usingCurve = curve;
    const heldBack = new Map(); // curve -> chunks seen on a curve that was not asked for
    const statusName = (v) => Object.keys(SCAN_STATUS).find((k) => SCAN_STATUS[k] === v) ?? (v == null ? 'unknown' : `#${v}`);
    const take = (chunk) => {
      if (received === 0) this.log('info', `scan: first samples on channel ${channel} (curve ${chunk.curve}, index ${chunk.lo}-${chunk.hi})`);
      chunk.dbm.forEach((dbm, i) => {
        const at = chunk.lo + i - plan.loIndex;
        if (at < 0 || at >= plan.points) strays += 1;
        else {
          if (Number.isNaN(levels[at])) received += 1;
          levels[at] = dbm;
        }
      });
      onProgress?.(received / plan.points);
    };
    /** What the scan has seen so far, for a failure message that can be acted on without a capture. */
    const summary = () => {
      const others = [...heldBack].map(([c, chunks]) => `${chunks.length} chunks on curve ${c}`).join(', ');
      return `status ${statusName(status)}${sawActive ? '' : ' (never active)'}, ${received} of ${plan.points} points received` +
        `${others ? `, ${others} ignored` : ''}${strays ? `, ${strays} stray samples` : ''}${refused.size ? `, refused: ${[...refused].join(', ')}` : ''}`;
    };
    const onString = ({ vector, key, value }) => {
      if (vector === DMP.SET_FAIL) refused.add(`${key.replace(/^.*RF_SCAN:/, '').replace(/\/CH=.*/, '')} reason ${value[0]}`);
      else if (vector === DMP.SUB_REJECT) refused.add(`subscription ${key.replace(/^.*RF_SCAN[_A-Z]*:/, '').slice(0, 24)} rejected`);
      else if (key === keys.status && value.length) {
        if (value[0] !== status) this.log('info', `scan: channel ${channel} status ${statusName(value[0])}`);
        status = value[0];
        if (status === SCAN_STATUS.ACTIVE) sawActive = true;
      } else if (vector === DMP.EVENT && key.includes('RF_SCAN_DATA')) {
        const chunk = parseDataEvent(key, value);
        if (!chunk) return;
        lastChunkAt = Date.now();
        if (chunk.curve !== usingCurve) {
          const held = heldBack.get(chunk.curve) ?? [];
          held.push(chunk);
          heldBack.set(chunk.curve, held);
          // nothing on the curve asked for while this one keeps coming: it is the unit's name for that antenna
          if (received === 0 && held.length >= 3) {
            this.log('warn', `scan: the unit streams antenna ${antenna}'s samples as curve ${chunk.curve}, not ${usingCurve}; using them`);
            usingCurve = chunk.curve;
            heldBack.delete(chunk.curve);
            for (const c of held) take(c);
          }
          return;
        }
        take(chunk);
      }
    };
    this.on('string', onString);
    const idle = () => status === SCAN_STATUS.FINISHING || (sawActive && status === SCAN_STATUS.IDLE);
    try {
      // the read that claims a scan; it is spent by the scan, so it is made before every one
      await this.get(chanAddr(channel, SCAN_OBJ.CLAIM));
      this.log('info', `scan: channel ${channel} claimed; antenna ${antenna} (curve ${curve}), ${plan.points} points ${plan.startKhz}-${plan.stopKhz} kHz`);
      // Wireless Workbench's order: status subscriptions, configuration, data subscription, trigger.
      // The unit sends no "accepted" reply to these that this driver sees, yet streams once they are in.
      await this.session.send(strBatch(DMP.SUBSCRIBE, [keys.progress, keys.sweepId, keys.status].map((key) => ({ key }))));
      await this.session.send(strBatch(DMP.SET, configEntries(ch, { startKhz: plan.startKhz, stopKhz: plan.stopKhz, stepKhz: plan.stepKhz, antenna })));
      await this.session.send(strBatch(DMP.SUBSCRIBE, [{ key: data }]));
      await this.session.send(dmpPdu(DMP.SET, chanAddr(channel, SCAN_OBJ.START), Buffer.from([0])));
      triggered = true;
      triggeredAt = Date.now();
      await waitFor(
        () => {
          if (refused.size) {
            // every config key refused with reason 1: the channel's scan is held by another session
            const busy = [...refused].every((r) => / reason 1$/.test(r)) && refused.size >= 6;
            throw new ScanFailed(
              busy
                ? `channel ${channel} is already being scanned by another controller (Wireless Workbench, or another SoundBase); wait for that scan to finish, or scan from another channel`
                : `the unit refused the scan (${[...refused].join(', ')})`
            );
          }
          // no samples for a while after the trigger (or after the last chunk): say what was seen, now
          if (Date.now() - Math.max(triggeredAt, lastChunkAt) > this.scanStallMs && received < plan.points) {
            throw new ScanFailed(`the scan stalled: ${summary()}. If this is an AD4Q, send the plugin log with the unit's firmware, band and Quadversity setting (AD4Q_DEBUG=1 in the environment logs every packet).`);
          }
          return received >= plan.points;
        },
        this.scanTimeoutMs ?? scanDurationMs(plan.points) * 1.6 + 20_000,
        { signal, what: 'finish the scan' }
      );
      if (strays > 0) throw new ScanFailed(`the unit sent ${strays} samples outside the range that was asked for`);
      this.log('info', `scan: channel ${channel} complete, ${received} points`);
      // a short wait for the unit to say it is done, as it does after the last chunk
      await waitFor(idle, 5000, { signal, what: 'report the scan finished' }).catch((err) => {
        if (err instanceof ScanAborted) throw err;
      });
      return levels;
    } finally {
      try {
        // The release ends a scan that is still running (the unit is idle again within about half
        // a second), so an abort or a failure does not leave the unit scanning. The subscriptions
        // are left in place on purpose: an UNSUBSCRIBE of the scan keys, committed or not, makes
        // the unit silently ignore every later scan in the session.
        await this.session.send(dmpPdu(DMP.SET, chanAddr(channel, SCAN_OBJ.RELEASE), Buffer.from([0])), { commit: true });
        if (triggered && !idle()) await waitFor(idle, 4000, { what: 'return to idle' }).catch(() => {});
      } catch {
        // a session that is already gone has nothing to release
      }
      this.off('string', onString);
      this.scanning = false;
    }
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
