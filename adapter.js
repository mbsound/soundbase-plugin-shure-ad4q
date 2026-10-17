// The Shure AD4Q as a SoundBase monitored device.
//
//   discoverDevices          a standing SLP browse of the network segment, plus
//                            any addresses the plugin config lists
//   createMonitoringAdapter  open -> connect, read everything, subscribe, report;
//                            then keep the picture current from the unit's own
//                            EVENTs and a slow refresh. setProperty -> write,
//                            read back, report what the unit now holds.
//
// Everything about the wire lives in driver/; this file maps the unit onto the
// contract. Settings that are disruptive to change (HD mode, encryption, the
// IR preset, antenna bias) are reported and deliberately not writable here.

import { HttpError } from '@soundbase/plugin-shell';
import { Ad4qDevice, WriteRefused } from './driver/ad4q/device.js';
import {
  CHANNEL_COUNT,
  CHANNEL_NAME_MAX,
  DEVICE_NAME_MAX,
  DIVERSITY_MODES,
  FREQ_MAX_KHZ,
  FREQ_MIN_KHZ,
  FREQ_RASTER_KHZ,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  IA_MODES,
  RF_POWER_MODES,
  ROSTER_SLOTS,
  TALK_OUTPUTS,
  TONE_FREQ_MAX_HZ,
  TONE_FREQ_MIN_HZ,
  TONE_LEVELS_DB,
  UNREGISTERED_ACTIONS,
  clampKhz,
  khzToMhz,
  mhzToKhz,
  quantizeKhz,
  toneLevelDb,
} from './driver/ad4q/properties.js';
import { SlpBrowser } from './driver/acn/slp.js';
import { FakeAd4q } from './driver/fake/fake-ad4q.js';
import { isIpv4, parseAddressList } from './driver/netutil.js';

export const PRODUCT = 'plugin:shure-ad4q/ad4q';
export const NET_ID_PREFIX = 'net:';
export const SIM_DEVICE_ID = 'sim:ad4q';

const ns = (name) => `x.shure-ad4q.${name}`;
export const KEYS = Object.freeze({
  toneLevel: ns('toneLevel'),
  toneFreq: ns('toneFreq'),
  toneActive: ns('toneActive'),
  diversity: ns('diversity'),
  overloadHold: ns('overloadHold'),
  interferenceAvoidance: ns('interferenceAvoidance'),
  unregisteredTx: ns('unregisteredTx'),
  rfPower: ns('rfPower'),
  encryption: ns('encryption'),
  talk: ns('talk'),
  transmitter: ns('transmitter'),
  lastSync: ns('lastSync'),
  unlink: ns('unlink'),
  unit: ns('unit'),
});

const SLOT_OPTIONS = ['None', ...Array.from({ length: ROSTER_SLOTS }, (_, i) => `Slot ${i + 1}`)];
const talkPropertyId = (outputId) => `talk${outputId[0].toUpperCase()}${outputId.slice(1)}`;
const TALK_BY_PROPERTY = new Map(TALK_OUTPUTS.map((o) => [talkPropertyId(o.id), o.id]));

const DEFAULT_REFRESH_MS = 5000;
const MIN_REFRESH_MS = 1000;
const MAX_REFRESH_MS = 60_000;
// how long the SLP browse keeps running after the shell last asked
const BROWSE_IDLE_MS = 90_000;
const SIMULATED_TIMINGS = { sendGapMs: 2, connectTimeoutMs: 5000 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const log = (level, message) => process.stderr.write(`[shure-ad4q] [${level}] ${message}\n`);
const env = (name) => process.env[name];

// ---------------------------------------------------------------------------
// the simulator
// ---------------------------------------------------------------------------

let simulator = null;
let simulatorStarting = null;

const simulateWanted = (pluginConfig) => pluginConfig?.simulate === true || env('SB_AD4Q_SIMULATE') === '1';

/** The running fake, for tests; null until simulation is on. */
export const getSimulator = () => simulator;

async function ensureSimulator() {
  if (simulator) return simulator;
  simulatorStarting ??= (async () => {
    const fake = new FakeAd4q({ uacn: 'AD4Q (simulated)' });
    await fake.listen();
    log('info', `simulated AD4Q listening on 127.0.0.1:${fake.controlPort}`);
    simulator = fake;
    return fake;
  })().finally(() => {
    simulatorStarting = null;
  });
  return simulatorStarting;
}

async function stopSimulator() {
  const fake = simulator;
  simulator = null;
  await fake?.stop();
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

let browser = null;
let lastDiscoverAt = 0;

const isAd4q = (unit) => /^ad4q/i.test(unit.fctn ?? '');

function ensureBrowser(pluginConfig) {
  const targets = parseAddressList(pluginConfig?.addresses);
  if (!browser) {
    browser = new SlpBrowser({ targets, filter: isAd4q, log });
    browser.on('found', (u) => log('info', `found ${u.fctn} "${u.uacn}" at ${u.ip}:${u.port} (${u.cidText})`));
    browser.on('lost', (u) => log('info', `lost ${u.fctn} "${u.uacn}" at ${u.ip}`));
  } else {
    browser.setTargets(targets);
  }
  void browser.start();
  return browser;
}

const idleCheck = () => {
  if (browser && Date.now() - lastDiscoverAt > BROWSE_IDLE_MS) browser.stop();
};

const discoveredDevice = (unit) => ({
  id: `${NET_ID_PREFIX}${unit.ip}`,
  name: `${unit.uacn || unit.fctn} (${unit.ip})`,
  product: PRODUCT,
  transport: { kind: 'network', host: unit.ip, port: unit.port },
  config: { host: unit.ip },
});

/** What the SLP browse has heard from lately. Returns at once; polled about once a second. */
export async function discoverDevices(pluginConfig = {}) {
  lastDiscoverAt = Date.now();
  const found = [];
  if (simulateWanted(pluginConfig)) {
    const fake = await ensureSimulator();
    found.push({
      id: SIM_DEVICE_ID,
      name: 'AD4Q (simulated)',
      product: PRODUCT,
      transport: { kind: 'simulated', host: '127.0.0.1', port: fake.controlPort },
      config: { host: '127.0.0.1', simulated: true },
    });
  } else if (simulator) {
    await stopSimulator();
  }
  if (env('SB_AD4Q_NO_DISCOVERY') === '1') return found;
  const b = ensureBrowser(pluginConfig);
  setTimeout(idleCheck, BROWSE_IDLE_MS + 1000).unref?.();
  for (const unit of b.devices()) found.push(discoveredDevice(unit));
  return found;
}

/** Stop the background browse and the simulator (tests and shutdown). */
export async function shutdownDiscovery() {
  browser?.stop();
  browser = null;
  await stopSimulator();
}

/** The unit's address: `device.config.host`, else the `net:<ip>` id. */
export function resolveHost(device) {
  const configured = device?.config?.host;
  if (typeof configured === 'string' && configured.trim()) {
    const host = configured.trim();
    if (!isIpv4(host)) throw new Error(`"${host}" is not an IPv4 address; the AD4Q is addressed by IP`);
    return host;
  }
  const id = typeof device?.id === 'string' ? device.id : '';
  if (id.startsWith(NET_ID_PREFIX) && isIpv4(id.slice(NET_ID_PREFIX.length))) return id.slice(NET_ID_PREFIX.length);
  throw new Error('an AD4Q needs an IP address (the "IP address" field)');
}

// ---------------------------------------------------------------------------
// PropertyControl descriptors
// ---------------------------------------------------------------------------

const TONE_OPTIONS = ['Off', ...TONE_LEVELS_DB];

const propertyDescriptors = () => {
  const channel = (id, value, key, extra = {}) => ({
    id,
    scope: 'channel',
    access: 'readWrite',
    stateBinding: { key: key ?? id },
    value,
    ...extra,
  });
  const unitProp = (id, value, access = 'readWrite') => ({
    id,
    scope: 'device',
    access,
    stateBinding: { key: KEYS.unit, path: [id] },
    value,
  });
  return [
    channel('mute', { type: 'boolean' }),
    channel('gain', { type: 'number', min: GAIN_MIN_DB, max: GAIN_MAX_DB, step: 1, unit: 'dB' }),
    channel('frequency', {
      type: 'number',
      min: FREQ_MIN_KHZ / 1000,
      max: FREQ_MAX_KHZ / 1000,
      step: FREQ_RASTER_KHZ / 1000,
      unit: 'MHz',
    }),
    channel('channelName', { type: 'string', maxLength: CHANNEL_NAME_MAX }),
    channel('toneLevel', { type: 'enum', options: TONE_OPTIONS, unit: 'dB' }, KEYS.toneLevel),
    channel(
      'toneFrequency',
      { type: 'number', min: TONE_FREQ_MIN_HZ, max: TONE_FREQ_MAX_HZ, step: 1, unit: 'Hz' },
      KEYS.toneFreq
    ),
    channel('diversity', { type: 'enum', options: [...DIVERSITY_MODES] }, KEYS.diversity),
    channel('overloadHold', { type: 'boolean' }, KEYS.overloadHold),
    channel('interferenceAvoidance', { type: 'enum', options: [...IA_MODES] }, KEYS.interferenceAvoidance),
    channel('unregisteredTx', { type: 'enum', options: [...UNREGISTERED_ACTIONS] }, KEYS.unregisteredTx),
    // the IR preset's RF power: what a transmitter takes on at its next IR sync
    channel('rfPower', { type: 'enum', options: [...RF_POWER_MODES] }, KEYS.rfPower),
    // each routing of the talk switch is its own switch; true means that output is on
    ...TALK_OUTPUTS.map((o) => ({
      id: talkPropertyId(o.id),
      scope: 'channel',
      access: 'readWrite',
      stateBinding: { key: KEYS.talk, path: [o.id] },
      value: { type: 'boolean' },
    })),
    // clearing a registered-transmitter slot is an action; the control rests on "None"
    channel('unlinkTransmitter', { type: 'enum', options: SLOT_OPTIONS }, KEYS.unlink),
    { ...channel('encryption', { type: 'string' }, KEYS.encryption), access: 'readOnly' },
    { id: 'deviceName', scope: 'device', access: 'readWrite', stateBinding: { key: 'deviceName' }, value: { type: 'string', maxLength: DEVICE_NAME_MAX } },
    unitProp('fanAlwaysOn', { type: 'boolean' }),
    unitProp('powerLock', { type: 'boolean' }),
    unitProp('panelLock', { type: 'boolean' }),
    unitProp('band', { type: 'string' }, 'readOnly'),
    unitProp('hdMode', { type: 'boolean' }, 'readOnly'),
    unitProp('quadversity', { type: 'boolean' }, 'readOnly'),
    unitProp('antennaBias', { type: 'boolean' }, 'readOnly'),
  ];
};

const badValue = (propertyId, expected) => new HttpError(400, 'bad_value', `${propertyId} expects ${expected}`);

const oneOf = (value, options) =>
  typeof value === 'string' ? options.find((o) => o.toLowerCase() === value.trim().toLowerCase()) : undefined;

// ---------------------------------------------------------------------------
// the monitoring adapter
// ---------------------------------------------------------------------------

class Ad4qMonitoringAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.pluginConfig = pluginConfig;
    this.simulated = device?.id === SIM_DEVICE_ID || device?.config?.simulated === true;
    this.host = null;
    this.hostError = null;
    if (this.simulated) this.host = '127.0.0.1';
    else {
      try {
        this.host = resolveHost(device);
      } catch (err) {
        this.hostError = err;
      }
    }
    const refresh = Number(pluginConfig.refreshIntervalMs);
    this.refreshMs = isNum(refresh) ? clamp(refresh, MIN_REFRESH_MS, MAX_REFRESH_MS) : DEFAULT_REFRESH_MS;
    this.unit = null;
    this.state = { channels: {}, device: {} };
    // what each roster slot has most recently been seen holding: roster[channel][slot]
    this.roster = {};
    this.refreshTimer = null;
    this.refreshing = null;
    this.writes = Promise.resolve();
    // false until the first full read lands: a reply mid-read is not a change
    this.live = false;
    this.closed = false;
    // assigned by the shell before open()
    this.onState = null;
    this.onWarnings = null;
    this.onFatal = null;
  }

  log(level, message) {
    log(level, `[${this.device.id}] ${message}`);
  }

  async open() {
    if (this.hostError) throw this.hostError;
    let options = { host: this.host, log: (l, m) => this.log(l, m) };
    if (this.simulated) {
      const fake = await ensureSimulator();
      options = {
        ...options,
        port: fake.controlPort,
        cid: fake.cid.toString('hex'),
        localIp: '127.0.0.1',
        advert: false,
        timings: SIMULATED_TIMINGS,
        requestTimeoutMs: 1000,
      };
    } else {
      const known = deviceCid(this.device);
      options = { ...options, cid: known, browser: ensureBrowser(this.pluginConfig) };
    }
    const unit = new Ad4qDevice(options);
    unit.on('prop', (change) => this.#onChange(change));
    unit.on('lost', (err) => this.#fatal(err));
    this.unit = unit;
    await unit.connect();
    if (this.closed) {
      await unit.close();
      throw new Error('closed while connecting');
    }
    this.onState?.('connection', { connected: true, since: new Date().toISOString() });
    await this.#refresh({ initial: true });
    this.live = true;
    // ask the unit to push changes, so the picture stays current between refreshes
    await unit.subscribeAll();
    this.refreshTimer = setInterval(() => this.#refresh().catch(() => {}), this.refreshMs);
    this.refreshTimer.unref?.();
    return {
      channelCount: CHANNEL_COUNT,
      properties: propertyDescriptors(),
      identity: {
        model: this.state.device.model ?? 'AD4Q',
        serial: this.state.device.serial ?? undefined,
        firmware: null,
      },
    };
  }

  async close() {
    this.closed = true;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    const unit = this.unit;
    this.unit = null;
    await unit?.close();
  }

  #fatal(err) {
    if (this.closed) return;
    this.log('error', err.message);
    this.onFatal?.(err);
  }

  // -- state ----------------------------------------------------------------------

  async #refresh({ initial = false } = {}) {
    if (this.refreshing) return this.refreshing;
    if (!this.unit?.connected) return null;
    this.refreshing = (async () => {
      const all = await this.unit.readAll();
      if (this.closed) return;
      const answered = Object.keys(all.device).length + Object.values(all.channels).reduce((n, c) => n + Object.keys(c).length, 0);
      if (answered === 0) {
        this.#fatal(new Error(`the AD4Q at ${this.host} stopped answering`));
        return;
      }
      Object.assign(this.state.device, all.device);
      for (const [n, props] of Object.entries(all.channels)) Object.assign((this.state.channels[n] ??= {}), props);
      this.#emitAll();
      if (initial) this.log('info', `${this.state.device.name ?? this.host}: ${answered} properties read`);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** A property the unit pushed: someone changed it on the panel or in Workbench. */
  #onChange({ channel, key, value }) {
    if (this.closed || !this.live) return;
    if (channel != null && key === 'levelDb') {
      // the live level goes out as a meter reading; the shell coalesces it
      this.onState?.('meters', { timestamp: Date.now(), channels: { [channel]: { rf1: value } } });
      return;
    }
    if (key === 'rosterId' || key === 'rosterGuid') {
      this.#onRoster(channel, key, value);
      return;
    }
    if (channel == null) this.state.device[key] = value;
    else (this.state.channels[channel] ??= {})[key] = value;
    this.#emitAll();
  }

  /** A roster slot filled: that is a transmitter being synced to the channel. */
  #onRoster(channel, key, value) {
    if (!value) return;
    const slot = ((this.roster[channel] ??= {})[value.slot] ??= {});
    if (key === 'rosterId') slot.serial = value.serial;
    else {
      slot.guid = value.guid;
      slot.model = value.model;
    }
    (this.state.channels[channel] ??= {}).lastSync = {
      slot: value.slot,
      serial: slot.serial ?? null,
      model: slot.model ?? null,
    };
    this.#emitAll();
  }

  #channelMap(pick) {
    const channels = {};
    for (const [n, ch] of Object.entries(this.state.channels)) {
      const v = pick(ch);
      if (v !== undefined && v !== null) channels[n] = v;
    }
    return Object.keys(channels).length ? { channels } : null;
  }

  /** Every key, from the cache; the shell drops the ones that did not change. */
  #emitAll() {
    const emit = (key, value) => {
      if (value != null) this.onState?.(key, value);
    };
    const dev = this.state.device;
    if (dev.name) emit('deviceName', dev.name);
    emit('channelName', this.#channelMap((c) => c.name));
    emit('frequency', this.#channelMap((c) => c.frequencyMhz));
    emit('mute', this.#channelMap((c) => c.muted));
    emit('gain', this.#channelMap((c) => c.gainDb));
    emit(KEYS.toneLevel, this.#channelMap((c) => (c.toneLevelDb == null ? undefined : toneLevelDb(c.toneLevelDb) ?? 'Off')));
    emit(KEYS.toneFreq, this.#channelMap((c) => c.toneFreqHz));
    emit(KEYS.toneActive, this.#channelMap((c) => c.toneActive));
    emit(KEYS.diversity, this.#channelMap((c) => c.diversity));
    emit(KEYS.overloadHold, this.#channelMap((c) => c.overloadHold));
    emit(KEYS.interferenceAvoidance, this.#channelMap((c) => c.interferenceAvoidance));
    emit(KEYS.unregisteredTx, this.#channelMap((c) => c.unregisteredTx));
    emit(KEYS.rfPower, this.#channelMap((c) => c.rfPower));
    emit(KEYS.encryption, this.#channelMap((c) => c.encryption));
    emit(KEYS.talk, this.#channelMap((c) => c.talk));
    emit(
      KEYS.transmitter,
      this.#channelMap((c) =>
        c.txModel === undefined && c.txSerial === undefined
          ? undefined
          : { present: !!(c.txModel || c.txSerial), model: c.txModel ?? null, serial: c.txSerial ?? null }
      )
    );
    emit(KEYS.lastSync, this.#channelMap((c) => c.lastSync));
    emit(KEYS.unlink, { channels: Object.fromEntries(Array.from({ length: CHANNEL_COUNT }, (_, i) => [i + 1, 'None'])) });
    const battery = this.#channelMap((c) => (isNum(c.txBattery) ? { percent: c.txBattery } : undefined));
    if (battery) emit('battery', { timestamp: Date.now(), channels: battery.channels });
    emit(KEYS.unit, {
      model: dev.model,
      serial: dev.serial,
      band: dev.band,
      hdMode: dev.hdMode,
      quadversity: dev.quadversity,
      antennaBias: dev.antennaBias,
      fanAlwaysOn: dev.fanAlwaysOn,
      powerLock: dev.powerLock,
      panelLock: dev.panelLock,
    });
  }

  // -- PropertyControl --------------------------------------------------------------

  setProperty(command) {
    // one write at a time: the unit's receive buffer is small
    const run = this.writes.then(() => this.#setProperty(command));
    this.writes = run.catch(() => {});
    return run;
  }

  async #setProperty({ propertyId, channelIndex, value }) {
    const unit = this.unit;
    if (!unit?.connected) throw new HttpError(503, 'device_unavailable', `no live session with the AD4Q at ${this.host}`);

    const channelScoped = new Set([
      'mute', 'gain', 'frequency', 'channelName', 'toneLevel', 'toneFrequency',
      'diversity', 'overloadHold', 'interferenceAvoidance', 'unregisteredTx',
      'rfPower', 'unlinkTransmitter', ...TALK_BY_PROPERTY.keys(),
    ]);
    if (channelScoped.has(propertyId) && (!Number.isInteger(channelIndex) || channelIndex < 1 || channelIndex > CHANNEL_COUNT)) {
      throw new HttpError(400, 'unknown_channel', `${propertyId} is per channel; channelIndex must be 1..${CHANNEL_COUNT}`);
    }

    // Each case settles on a `[scope, key, encoded value]` for the driver.
    let target;
    switch (propertyId) {
      case 'mute':
      case 'overloadHold':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        target = ['channel', propertyId === 'mute' ? 'muted' : 'overloadHold', value];
        break;
      case 'gain':
        if (!isNum(value)) throw badValue(propertyId, 'a number in dB');
        target = ['channel', 'gainDb', clamp(Math.round(value), GAIN_MIN_DB, GAIN_MAX_DB)];
        break;
      case 'frequency':
        if (!isNum(value)) throw badValue(propertyId, 'a number in MHz');
        target = ['channel', 'frequencyMhz', khzToMhz(quantizeKhz(clampKhz(mhzToKhz(value))))];
        break;
      case 'channelName':
        if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) throw badValue(propertyId, 'printable ASCII text');
        target = ['channel', 'name', value.slice(0, CHANNEL_NAME_MAX)];
        break;
      case 'toneLevel': {
        if (value === 'Off' || value === null) target = ['channel', 'toneLevelDb', null];
        else {
          const level = Number(value);
          if (!TONE_LEVELS_DB.includes(level)) throw badValue(propertyId, `Off or one of ${TONE_LEVELS_DB.join(', ')} dB`);
          target = ['channel', 'toneLevelDb', level];
        }
        break;
      }
      case 'toneFrequency':
        if (!isNum(value)) throw badValue(propertyId, 'a number in Hz');
        target = ['channel', 'toneFreqHz', clamp(Math.round(value), TONE_FREQ_MIN_HZ, TONE_FREQ_MAX_HZ)];
        break;
      case 'diversity': {
        const mode = oneOf(value, DIVERSITY_MODES);
        if (!mode) throw badValue(propertyId, `one of ${DIVERSITY_MODES.join(', ')}`);
        target = ['channel', 'diversity', mode];
        break;
      }
      case 'interferenceAvoidance': {
        const mode = oneOf(value, IA_MODES);
        if (!mode) throw badValue(propertyId, `one of ${IA_MODES.join(', ')}`);
        target = ['channel', 'interferenceAvoidance', mode];
        break;
      }
      case 'unregisteredTx': {
        const action = oneOf(value, UNREGISTERED_ACTIONS);
        if (!action) throw badValue(propertyId, `one of ${UNREGISTERED_ACTIONS.join(', ')}`);
        target = ['channel', 'unregisteredTx', action];
        break;
      }
      case 'deviceName':
        if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) throw badValue(propertyId, 'printable ASCII text');
        target = ['device', 'name', value.slice(0, DEVICE_NAME_MAX)];
        break;
      case 'fanAlwaysOn':
      case 'powerLock':
      case 'panelLock':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        target = ['device', propertyId, value];
        break;
      case 'rfPower': {
        const mode = oneOf(value, RF_POWER_MODES);
        if (!mode) throw badValue(propertyId, `one of ${RF_POWER_MODES.join(', ')}`);
        target = ['channel', 'rfPower', mode];
        break;
      }
      case 'unlinkTransmitter': {
        const slot = oneOf(value, SLOT_OPTIONS);
        if (!slot) throw badValue(propertyId, `one of ${SLOT_OPTIONS.join(', ')}`);
        target = slot === 'None' ? null : ['unlink', null, Number(slot.slice(5))];
        if (!target) return; // resting position: nothing to do
        break;
      }
      case 'encryption':
      case 'band':
      case 'hdMode':
      case 'quadversity':
      case 'antennaBias':
        throw new HttpError(400, 'read_only', `${propertyId} is read-only in this plugin; change it in Wireless Workbench or on the unit`);
      default:
        if (TALK_BY_PROPERTY.has(propertyId)) {
          if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
          target = ['talk', TALK_BY_PROPERTY.get(propertyId), value];
          break;
        }
        throw new HttpError(400, 'unknown_property', `No property ${propertyId} on ${PRODUCT}`);
    }

    const [scope, key, encoded] = target;
    let held;
    try {
      if (scope === 'channel') held = await unit.setChannel(channelIndex, key, encoded);
      else if (scope === 'device') held = await unit.setDevice(key, encoded);
      else if (scope === 'talk') held = await unit.setTalkOutput(channelIndex, key, encoded);
      else {
        // unlink: the slot is cleared on the unit, and what it reported last is no longer true
        await unit.unlinkSlot(channelIndex, encoded);
        const ch = this.state.channels[channelIndex];
        // channel maps merge, so "nothing" must be published, not left out
        if (ch?.lastSync?.slot === encoded) ch.lastSync = { slot: null, serial: null, model: null };
        if (this.roster[channelIndex]) delete this.roster[channelIndex][encoded];
        this.#emitAll();
        return;
      }
    } catch (err) {
      if (err instanceof WriteRefused) {
        this.log('warn', `${propertyId}${channelIndex ? ` on channel ${channelIndex}` : ''}: the unit refused ${JSON.stringify(value)} (reason ${err.reason})`);
        // the unit is the truth: show what it still holds
        await this.#refresh().catch(() => {});
        return;
      }
      throw new HttpError(503, 'device_unavailable', err.message);
    }
    if (held == null) {
      this.log('warn', `${propertyId}: no read-back from the unit; state unconfirmed`);
      return;
    }
    if (scope === 'talk') ((this.state.channels[channelIndex] ??= {}).talk ??= {})[key] = held;
    else if (scope === 'channel') (this.state.channels[channelIndex] ??= {})[key] = held;
    else this.state.device[key] = held;
    this.#emitAll();
  }
}

// a unit found by SLP carries its component id, which a manual add does not
const deviceCid = (device) => {
  const cid = String(device?.config?.cid ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return cid.length === 32 ? cid : null;
};

export function createMonitoringAdapter(device, pluginConfig) {
  return new Ad4qMonitoringAdapter(device, pluginConfig);
}
