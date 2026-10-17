// A stand-in AD4Q that speaks the real wire on loopback: it advertises over
// SLP, completes the JOIN in both directions, waits for the controller to
// declare DMP protocol 2, and then answers GET, SET (with its commit PDU) and
// SUBSCRIBE from a property store modelled on what a real unit holds. It is
// what the tests, the smoke check and the in-app simulator run against.
//
// It behaves like the unit where that matters to the driver: a SET without the
// commit PDU is applied and never answered, an out-of-range SET answers
// SET_FAIL with reason 5, and an unknown address answers GET_FAIL.

import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import {
  COMMIT_PDU,
  DMP,
  SDT,
  buildJoin,
  buildJoinAccept,
  buildWrapper,
  clientBlock,
  dmpPdu,
  mgmtAck,
  parseDmp,
  parseWrapper,
  pduEncode,
  rootParse,
  sdtMessages,
} from '../acn/pdu.js';
import { buildAttrRply } from '../acn/slp.js';
import {
  CH,
  DEV,
  ROSTER_SLOTS,
  TX_MODEL_BY_GUID,
  chanAddr,
  encodeString,
  rosterAddrs,
  rosterIdAddr,
} from '../ad4q/properties.js';

const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

const FAIL_OUT_OF_RANGE = 5;

export class FakeAd4q {
  constructor({ uacn = 'AD4Q (simulated)', host = '127.0.0.1', slpPort = 0 } = {}) {
    this.host = host;
    this.uacn = uacn;
    this.slpTarget = slpPort;
    this.cid = Buffer.concat([randomBytes(4), Buffer.from('000011dda000000eddcccccc', 'hex')]);
    this.devChan = 0x4200;
    this.socket = null;
    this.adverts = null;
    this.controller = null; // { cid, chan, rinfo }
    this.totalSeq = 1;
    this.relSeq = this.devChan;
    this.firstRel = null;
    this.declared = false;
    this.subscribed = new Set();
    this.timers = [];
    /** every SET received, `{ addr, value, committed }`, for tests */
    this.writes = [];
    /** how many controllers have JOINed */
    this.joins = 0;
    this.store = new Map();
    this.#seed();
  }

  get controlPort() {
    return this.socket?.address().port;
  }

  get slpPort() {
    return this.slpTarget;
  }

  // --- the property store --------------------------------------------------------

  #seed() {
    const put = (addr, value, check) => this.store.set(addr, { value, check });
    const inSet = (...allowed) => (v) => allowed.includes(v[0]);
    const range = (lo, hi) => (v) => {
      const n = v.length === 1 ? v.readInt8(0) : v.length === 2 ? v.readUInt16BE(0) : v.readUInt32BE(0);
      return n >= lo && n <= hi;
    };
    put(DEV.MODEL, encodeString('AD4Q-C'));
    put(DEV.SERIAL, encodeString('SIM000001'));
    put(DEV.NAME, encodeString(this.uacn.slice(0, 31)), (v) => v.length >= 2);
    put(DEV.POWER_LOCK, u8(0), inSet(0, 1));
    put(DEV.FAN_ALWAYS_ON, u8(0), inSet(0, 1));
    put(DEV.PANEL_LOCK, u8(0), inSet(0, 1));
    put(DEV.BAND, encodeString('G57'));
    put(DEV.HD_MODE, u8(0));
    put(DEV.QUADVERSITY, u8(0));
    put(DEV.ANTENNA_BIAS, u8(0));
    for (let c = 1; c <= 4; c += 1) {
      const at = (obj) => chanAddr(c, obj);
      put(at(CH.NAME), encodeString(`Channel${c}`), (v) => v.length >= 2 && v.readUInt16BE(0) <= 10);
      put(at(CH.GAIN_DB), u8(0), range(-18, 42));
      put(at(CH.MUTE), u8(0), inSet(0, 1));
      put(at(CH.OVERLOAD_HOLD), u8(0), inSet(0, 1));
      put(at(CH.TONE_ACTIVE), u8(0));
      put(at(CH.TONE_FREQ_HZ), u16(400), range(20, 20_000));
      put(at(CH.TONE_LEVEL_DB), u8(0x80), (v) => v[0] === 0x80 || (v.readInt8(0) >= -60 && v.readInt8(0) <= -12));
      put(at(CH.FREQ_KHZ), u32(470_000 + c * 25_000), (v) => {
        const khz = v.readUInt32BE(0);
        return khz >= 470_000 && khz <= 1_000_000 && khz % 25 === 0;
      });
      put(at(CH.DIVERSITY), u8(2), inSet(0, 2, 4));
      put(at(CH.INTERFERENCE_AVOIDANCE), u8(1), inSet(0, 1, 2));
      put(at(CH.UNREGISTERED_TX), u8(1), inSet(0, 1, 2));
      put(at(CH.RF_POWER), u8(1), inSet(0, 1, 2, 0xff));
      put(at(CH.TALK_ROUTING), u8(0));
      // no transmitter paired: the sentinel values the unit reports until an IR sync
      put(at(CH.TX_MODEL), encodeString(''));
      put(at(CH.TX_SERIAL), u32(0xffffffff));
      put(at(CH.TX_BATTERY), u8(0xff));
      for (const addr of rosterAddrs(c)) put(addr, Buffer.alloc(16), (v) => v.length === 16);
      put(at(CH.ENCRYPTION), u8(0));
      put(at(CH.LEVEL), i32(-90));
    }
  }

  /**
   * IR-sync a transmitter into a channel, as the unit reports it: the status bank
   * fills in, and the roster slot flashes the identity and type before clearing.
   */
  syncTransmitter(channel, slot, { model = 'ADX2', serial = '0048ba2e', battery = 100 } = {}) {
    const guid = Object.entries(TX_MODEL_BY_GUID).find(([, m]) => m === model)?.[0];
    if (!guid || slot < 1 || slot > ROSTER_SLOTS) throw new RangeError('unknown model or slot');
    this.setLocal(chanAddr(channel, CH.TX_MODEL), encodeString(model));
    this.setLocal(chanAddr(channel, CH.TX_SERIAL), Buffer.from(serial, 'hex'));
    this.setLocal(chanAddr(channel, CH.TX_BATTERY), u8(battery));
    const id = Buffer.concat([u8(0xff), Buffer.from(serial.slice(2), 'hex'), Buffer.from('000011dda000000eddcccccc', 'hex')]);
    const idAddr = rosterIdAddr(channel, slot);
    const guidAddr = idAddr + 0x10;
    this.setLocal(idAddr, id);
    this.setLocal(guidAddr, Buffer.from(guid.replaceAll('-', ''), 'hex'));
    const timer = setTimeout(() => {
      this.setLocal(idAddr, Buffer.alloc(16));
      this.setLocal(guidAddr, Buffer.alloc(16));
    }, 200);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** The transmitter leaves: the status bank goes back to its sentinels. */
  removeTransmitter(channel) {
    this.setLocal(chanAddr(channel, CH.TX_MODEL), encodeString(''));
    this.setLocal(chanAddr(channel, CH.TX_SERIAL), u32(0xffffffff));
    this.setLocal(chanAddr(channel, CH.TX_BATTERY), u8(0xff));
  }

  /** Change a value as the unit itself would, pushing an EVENT to subscribers. */
  setLocal(addr, value) {
    const entry = this.store.get(addr);
    if (!entry) return;
    entry.value = value;
    this.#pushEvent(addr);
  }

  // --- lifecycle -------------------------------------------------------------------

  async listen() {
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('message', (data, rinfo) => this.#onDatagram(data, rinfo));
    await new Promise((resolve) => socket.bind({ port: 0, address: this.host }, resolve));
    if (this.slpTarget) this.#startAdverts();
    // a slow level movement, so subscribed meters have something to show
    const level = setInterval(() => {
      const base = -90 + Math.round(Math.sin(Date.now() / 800) * 20);
      for (let c = 1; c <= 4; c += 1) this.setLocal(chanAddr(c, CH.LEVEL), i32(base - c));
    }, 100);
    level.unref?.();
    this.timers.push(level);
  }

  #startAdverts() {
    this.adverts = dgram.createSocket('udp4');
    const send = () =>
      this.adverts?.send(
        buildAttrRply({
          cid: this.cid,
          fctn: 'AD4Q_RX',
          uacn: this.uacn,
          ip: this.host,
          port: this.controlPort,
        }),
        this.slpTarget,
        this.host,
        () => {}
      );
    send();
    const timer = setInterval(send, 400);
    timer.unref?.();
    this.timers.push(timer);
  }

  async stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.adverts?.close();
    this.adverts = null;
    await new Promise((resolve) => (this.socket ? this.socket.close(resolve) : resolve()));
    this.socket = null;
  }

  // --- the wire --------------------------------------------------------------------

  #send(packet) {
    if (this.controller) this.socket?.send(packet, this.controller.rinfo.port, this.controller.rinfo.address);
  }

  #onDatagram(data, rinfo) {
    const root = rootParse(data);
    if (!root) return;
    for (const { vector, data: body } of sdtMessages(root.sdt)) {
      if (vector === SDT.JOIN) this.#onJoin(root.cid, body, rinfo);
      else if (vector === SDT.REL_WRAP || vector === SDT.UNREL_WRAP)
        this.#onWrapper(vector === SDT.REL_WRAP, body);
    }
  }

  #onJoin(controllerCid, body, rinfo) {
    const chan = body.readUInt16BE(18);
    const relSeq = body.readUInt32BE(26) & 0xffff;
    this.controller = { cid: controllerCid, chan, rinfo };
    this.joins += 1;
    this.declared = false;
    this.subscribed.clear();
    this.firstRel = null;
    this.#send(buildJoinAccept(this.cid, controllerCid, chan, relSeq, this.devChan));
    // the reciprocal JOIN back to the controller
    this.#send(buildJoin(this.cid, controllerCid, this.devChan));
  }

  #onWrapper(reliable, body) {
    const wrapper = parseWrapper(body);
    if (!wrapper || !this.controller) return;
    for (const { payload } of wrapper.blocks) {
      if (payload.length >= 7 && payload[0] === 0x70 && payload[2] === 0x09 && payload.readUInt32BE(3) === 2) {
        this.declared = true;
        this.#reliable(clientBlock(1, 1, 0, pduEncode(0x0a, null, u32(2))));
      } else if (this.declared && payload.length >= 6) {
        this.#onDmp(payload);
      }
    }
    if (reliable) {
      this.#unreliable(clientBlock(1, 1, this.controller.chan, mgmtAck(wrapper.rel & 0xffff)));
    }
  }

  #reliable(...blocks) {
    this.relSeq = (this.relSeq + 1) & 0xffff;
    this.firstRel ??= this.relSeq;
    const total = this.totalSeq;
    this.totalSeq = (this.totalSeq + 1) & 0xffff;
    this.#send(buildWrapper(this.cid, this.devChan, total, this.relSeq, this.firstRel, blocks, true));
  }

  #unreliable(...blocks) {
    const total = this.totalSeq;
    this.totalSeq = (this.totalSeq + 1) & 0xffff;
    this.#send(buildWrapper(this.cid, this.devChan, total, this.relSeq, this.relSeq, blocks, false));
  }

  #dmp(...pdus) {
    this.#reliable(clientBlock(1, 2, 0, Buffer.concat(pdus)));
  }

  #onDmp(payload) {
    const committed = payload.length >= COMMIT_PDU.length && payload.subarray(-COMMIT_PDU.length).equals(COMMIT_PDU);
    const replies = [];
    for (const { vector, addr, value } of parseDmp(payload)) {
      const entry = this.store.get(addr);
      if (vector === DMP.GET) {
        replies.push(entry ? dmpPdu(DMP.GET_REPLY, addr, entry.value) : dmpPdu(DMP.GET_FAIL, addr, u8(2)));
      } else if (vector === DMP.SUBSCRIBE) {
        if (entry) this.subscribed.add(addr);
        replies.push(dmpPdu(entry ? DMP.SUB_ACCEPT : DMP.SUB_REJECT, addr, entry ? Buffer.alloc(0) : u8(2)));
      } else if (vector === DMP.SET) {
        this.writes.push({ addr, value: Buffer.from(value), committed });
        if (!entry || (entry.check && !entry.check(value))) {
          if (committed) replies.push(dmpPdu(DMP.SET_FAIL, addr, u8(FAIL_OUT_OF_RANGE)));
          continue;
        }
        entry.value = Buffer.from(value);
        // a bare SET takes effect and is never answered
        if (committed) replies.push(dmpPdu(DMP.EVENT, addr, entry.value));
        this.#afterWrite(addr);
      }
    }
    // each reply travels in its own wrapper, as the unit's do
    for (const pdu of replies) this.#dmp(pdu);
  }

  #afterWrite(addr) {
    // setting a tone level lights the tone indicator for a moment
    for (let c = 1; c <= 4; c += 1) {
      if (addr === chanAddr(c, CH.TONE_LEVEL_DB)) {
        this.setLocal(chanAddr(c, CH.TONE_ACTIVE), u8(1));
        const timer = setTimeout(() => this.setLocal(chanAddr(c, CH.TONE_ACTIVE), u8(0)), 300);
        timer.unref?.();
      }
    }
  }

  #pushEvent(addr) {
    if (!this.controller || !this.declared || !this.subscribed.has(addr)) return;
    this.#dmp(dmpPdu(DMP.EVENT, addr, this.store.get(addr).value));
  }
}
