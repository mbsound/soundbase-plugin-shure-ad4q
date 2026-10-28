// The Shure AD4Q as a SoundBase monitored device.
//
//   discoverDevices          a standing SLP browse of the network segment, plus
//                            any addresses the plugin config lists
//   createMonitoringAdapter  open -> connect, read everything, subscribe, report;
//                            then keep the picture current from the unit's own
//                            EVENTs and a slow refresh. setProperty -> write,
//                            read back, report what the unit now holds.
//   createSpectrumAnalyzerAdapter  the unit's own RF scan as a spectrum analyzer:
//                            one scan per antenna from a chosen channel, shown as
//                            a composite with each antenna's curve beside it.
//
// Everything about the wire lives in driver/; this file maps the unit onto the
// contract. Settings that are disruptive to change (HD mode, encryption, the
// IR preset, antenna bias) are reported and deliberately not writable here.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from '@soundbase/plugin-shell';
import { Ad4qDevice, ScanAborted, WriteRefused } from './driver/ad4q/device.js';
import {
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
  DEV,
  channelsFor,
  decodeString,
  isReceiverAdvert,
  modelOf,
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
  MAX_CHANNELS,} from './driver/ad4q/properties.js';
import { SCAN_LIMITS, defaultSpan, peakOf, planScan, scanDurationMs } from './driver/ad4q/scan.js';
import { SlpBrowser } from './driver/acn/slp.js';
import { COMMAND_PORT, CommandClient, STATUS_PROPS, TX_PROPS, decodeShowLink, decodeTransmitter } from './driver/cmdstrings/client.js';
import { FakeAd4q } from './driver/fake/fake-ad4q.js';
import { isIpv4, parseAddressList } from './driver/netutil.js';

const manifest = JSON.parse(readFileSync(new URL('./soundbase-plugin.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// settings that are the plugin's, not the unit's: kept per device in the host's
// data directory (SB_PLUGIN_DATA_DIR survives plugin updates); in memory without one
// ---------------------------------------------------------------------------

const SETTINGS_FILE = 'device-settings.json';
let settingsCache = null;

function settingsPath() {
  const dir = process.env.SB_PLUGIN_DATA_DIR;
  return dir ? `${dir}/${SETTINGS_FILE}` : null;
}

function loadAllSettings() {
  if (settingsCache) return settingsCache;
  const path = settingsPath();
  try {
    settingsCache = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

/** The plugin's own settings for one device, `{}` when none are saved. */
export function deviceSettings(deviceId) {
  return { ...(loadAllSettings()[deviceId] ?? {}) };
}

/** Save a change to one device's plugin-side settings; the write is best-effort, the memory copy always holds. */
export function saveDeviceSettings(deviceId, patch) {
  const all = loadAllSettings();
  all[deviceId] = { ...(all[deviceId] ?? {}), ...patch };
  const path = settingsPath();
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(all, null, 2));
    } catch (err) {
      log('warn', `could not save device settings to ${path}: ${err.message}`);
    }
  }
  return { ...all[deviceId] };
}

/** For tests: forget what was loaded, so the next read comes from the file. */
export function resetSettingsCache() {
  settingsCache = null;
}

export const PRODUCT = 'plugin:shure-ad4q/ad4q';
export const PRODUCT_AD4D = 'plugin:shure-ad4q/ad4d';
/** The ANX4 is a product per licensed channel count (SoundBase fixes a device's channel count from its product). */
export const PRODUCT_ANX4 = (channels) => `plugin:shure-ad4q/anx4-${channels}`;
const ANX4_PRODUCT_RE = /\/anx4-(\d+)$/;

/** The product a unit is announced as, from the function tag it advertises; an ANX4 needs its channel count too. */
const productFor = (fctn, channels = null) => {
  const model = modelOf(fctn);
  if (model === 'ANX4') return PRODUCT_ANX4(channels ?? MAX_CHANNELS);
  return model === 'AD4D' ? PRODUCT_AD4D : PRODUCT;
};
/** The channel count of a product; anything not recognised is the four-channel AD4Q. */
const channelsOfProduct = (product) => {
  const anx4 = ANX4_PRODUCT_RE.exec(String(product ?? ''));
  if (anx4) return Math.min(MAX_CHANNELS, Math.max(1, Number(anx4[1])));
  return channelsFor(product === PRODUCT_AD4D ? 'AD4D' : 'AD4Q');
};
export const NET_ID_PREFIX = 'net:';
export const SIM_DEVICE_ID = 'sim:ad4q';

// One unit is one device to the host: its product declares both channel monitoring and the
// spectrum analyzer, and the shell opens an adapter of each kind on it.

const ns = (name) => `x.shure-ad4q.${name}`;
export const KEYS = Object.freeze({
  toneLevel: ns('toneLevel'),
  toneFreq: ns('toneFreq'),
  toneActive: ns('toneActive'),
  diversity: ns('frequencyDiversity'),
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
  toneGen: ns('toneGen'),
  showLink: ns('showLink'),
  status: ns('status'),
  // ANX4: the channel's own band
  band: ns('band'),
});

const SLOT_OPTIONS = ['None', ...Array.from({ length: ROSTER_SLOTS }, (_, i) => `Slot ${i + 1}`)];
// `xlrNormal` -> `talkNormalXlr`: position first, then output, as the Workbench grid reads
const talkPropertyId = (outputId) => {
  const [, output, position] = /^([a-z0-9]+)(Normal|Pressed)$/.exec(outputId);
  return `talk${position}${output[0].toUpperCase()}${output.slice(1)}`;
};
const TALK_BY_PROPERTY = new Map(TALK_OUTPUTS.map((o) => [talkPropertyId(o.id), o.id]));

// what the unit pushes, by the driver's key, onto the contract's meter fields
const METER_KEYS = Object.freeze({ rfADbm: 'rf1', rfBDbm: 'rf2', audioDb: 'af' });

// how long a dropped session after an HD mode change is taken for the unit restarting (it takes about 30 s)
const RESTART_WINDOW_MS = 120_000;
const COMMAND_RETRY_MS = 10_000;
const SAMPLE_MS = 1000;
const RECONNECT_GAP_MS = 2000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
/** The one-step switches (tone generator at -30 dB), on unless the plugin setting turns them off. */
const quickTogglesWanted = (pluginConfig) => pluginConfig?.quickToggles !== false;
/**
 * The ShowLink frequency lock is built and tested but not offered yet: SoundBase cannot push
 * coordinated frequencies to a plugin device (see README, Known limits), so the lock could only
 * hold changes typed into this plugin's own settings. SB_AD4Q_SHOWLINK_LOCK=1 offers it.
 */
const showLinkLockOffered = () => env('SB_AD4Q_SHOWLINK_LOCK') === '1';
const QUICK_TOGGLE_PROPERTIES = Object.freeze(['toneGenerator']);
const QUICK_TONE_DB = -30;

/** The manifest's layout for a product, without the controls of properties the unit does not offer. */
export function layoutFor(product, { quickToggles = true } = {}) {
  const layout = manifest.products.find((p) => p.deviceTypeId === product)?.layout;
  if (!layout || quickToggles) return layout;
  const prune = (nodes) =>
    nodes
      ?.filter((n) => !(n.type === 'control' && QUICK_TOGGLE_PROPERTIES.includes(n.propertyId)))
      .map((n) => (n.type === 'group' ? { ...n, children: prune(n.children) } : n));
  return { ...layout, channel: prune(layout.channel), device: prune(layout.device) };
}

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

const isAd4q = isReceiverAdvert;

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

const discoveredDevice = (unit, channels = null) => ({
  id: `${NET_ID_PREFIX}${unit.ip}`,
  name: `${modelOf(unit.fctn) === 'ANX4' ? `ANX4 ${unit.uacn || ''}`.trim() : unit.uacn || unit.fctn} (${unit.ip})`,
  product: productFor(unit.fctn, channels),
  transport: { kind: 'network', host: unit.ip, port: unit.port },
  config: { host: unit.ip },
});

// An ANX4's product is its licensed channel count, which only the unit knows: a short session
// counts the channels once per unit and the answer is kept; until it is in, the unit is not listed.
const anx4Channels = new Map(); // ip -> count, or a promise while counting
async function countAnx4(unit) {
  const probe = new Ad4qDevice({ host: unit.ip, cid: unit.cid, port: unit.port, channels: MAX_CHANNELS, log });
  try {
    await probe.connect();
    return await probe.countChannels();
  } finally {
    await probe.close().catch(() => {});
  }
}
function anx4ChannelsFor(unit) {
  const known = anx4Channels.get(unit.ip);
  if (typeof known === 'number') return known;
  if (!known) {
    const p = countAnx4(unit).then(
      (n) => { anx4Channels.set(unit.ip, n); log('info', `${unit.ip}: ANX4 licensed for ${n} channel${n === 1 ? '' : 's'}`); return n; },
      (err) => { anx4Channels.delete(unit.ip); log('warn', `${unit.ip}: could not count the ANX4's channels (${err.message}); will retry`); return null; }
    );
    anx4Channels.set(unit.ip, p);
  }
  return null;
}


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
  for (const unit of b.devices()) {
    if (modelOf(unit.fctn) === 'ANX4') {
      const n = anx4ChannelsFor(unit);
      if (n !== null) found.push(discoveredDevice(unit, n));
    } else found.push(discoveredDevice(unit));
  }
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
const FAN_MODES = Object.freeze(['Automatic', 'Always on']);
/** The bands a unit of each frequency range can be set to; a range not listed keeps its band read-only. */
export const BANDS_BY_RANGE = Object.freeze({
  A: Object.freeze(['G53', 'G54', 'G55', 'G56', 'G57', 'G57+', 'G62', 'G63', 'H54']),
});
/** `A`, `B` or `C` from a model such as `AD4D-A`, or null. */
const rangeOf = (model) => /-([ABC])$/i.exec(String(model ?? '').trim())?.[1]?.toUpperCase() ?? null;
const isAd4d = (model) => /^AD4D/i.test(String(model ?? ''));
const isAnx4 = (model) => /^ANX4/i.test(String(model ?? ''));
const fanModeOf = (alwaysOn) => (alwaysOn == null ? undefined : alwaysOn ? FAN_MODES[1] : FAN_MODES[0]);

/** The properties a unit offers: a few depend on which unit it is. */
export const propertyDescriptors = ({ model, quickToggles = true } = {}) => {
  const bands = BANDS_BY_RANGE[rangeOf(model)];
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
    // the one-step tone switch: on is the tone at -30 dB, off is the tone off
    ...(quickToggles ? [channel('toneGenerator', { type: 'boolean' }, KEYS.toneGen)] : []),
    channel(
      'toneFrequency',
      { type: 'number', min: TONE_FREQ_MIN_HZ, max: TONE_FREQ_MAX_HZ, step: 1, unit: 'Hz' },
      KEYS.toneFreq
    ),
    channel('frequencyDiversity', { type: 'enum', options: [...DIVERSITY_MODES] }, KEYS.diversity),
    channel('overloadHold', { type: 'boolean' }, KEYS.overloadHold),
    channel('interferenceAvoidance', { type: 'enum', options: [...IA_MODES] }, KEYS.interferenceAvoidance),
    channel('unregisteredTransmitter', { type: 'enum', options: [...UNREGISTERED_ACTIONS] }, KEYS.unregisteredTx),
    // the IR preset's RF power: what a transmitter takes on at its next IR sync
    channel('transmitterPower', { type: 'enum', options: [...RF_POWER_MODES] }, KEYS.rfPower),
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
    { id: 'deviceName', scope: 'device', access: 'readWrite', stateBinding: { key: 'deviceName' }, value: { type: 'string', maxLength: DEVICE_NAME_MAX } },
    // the unit's "fan always on" flag, in Wireless Workbench's words
    unitProp('fanMode', { type: 'enum', options: [...FAN_MODES] }),
    unitProp('powerLock', { type: 'boolean' }),
    unitProp('panelLock', { type: 'boolean' }),
    // the band is a choice when this unit's range is known; it applies live and the channels retune.
    // An ANX4's band is per channel (shown on the channel) and not changed here
    bands ? unitProp('band', { type: 'enum', options: [...bands] }) : unitProp('band', { type: 'string' }, 'readOnly'),
    // writable by decision: the unit restarts itself after the change, which the adapter rides out
    { ...unitProp('highDensityMode', { type: 'boolean' }), effects: ['deviceRestart'] },
    // the AD4D has no Quadversity; on an AD4Q it is shown, and only the front panel can change it.
    // The ANX4 has neither Quadversity nor the antenna-bias flag at the AD4Q's address
    ...(isAd4d(model) || isAnx4(model) ? [] : [unitProp('quadversity', { type: 'string' }, 'readOnly')]),
    ...(isAnx4(model) ? [] : [unitProp('antennaBias', { type: 'boolean' })]),
    // the plugin's own: while on, no frequency change (SoundBase's or a typed one) reaches a channel
    // whose transmitter has no ShowLink, so a change cannot leave a transmitter on the old frequency
    ...(showLinkLockOffered() ? [unitProp('requireShowlinkForFrequency', { type: 'boolean' })] : []),
    // identify: the unit flashes its display (a channel index flashes that channel's)
    { id: 'identify', scope: 'device', access: 'readWrite', value: { type: 'boolean' } },
    // one setting for the whole unit (the wire carries it per channel, but a write to one changes every channel);
    // switching it changes the key, so the transmitters need an IR sync afterwards
    unitProp('encryption', { type: 'enum', options: ['Off', 'On'] }),
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
    this.channels = channelsOfProduct(device?.product);
    this.quickToggles = quickTogglesWanted(pluginConfig);
    this.settings = deviceSettings(device?.id);
    // the command-strings side: the transmitter being received, the slots and ShowLink, the status flags
    this.commands = null;
    this.commandValues = {}; // channel -> { PROP: value }
    this.commandSlots = {}; // channel -> { SLOT_STATUS: {slot: v}, SLOT_SHOWLINK_STATUS: {...}, SLOT_TX_MODEL: {...} }
    this.commandRetry = null;
    // every condition shown on the device, by id; the host gets the whole set on each change
    this.conditions = new Map();
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
    // the latest of each live meter, per channel
    this.meters = {};
    // until when a dropped session is the unit restarting after an HD mode change, not a fault
    this.restartExpectedUntil = 0;
    this.reconnecting = null;
    this.reconnectWanted = false;
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

  /** A session to the unit, wired to this adapter; the caller connects it. */
  async #newUnit() {
    let options = { host: this.host, channels: this.channels, log: (l, m) => this.log(l, m) };
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
    unit.on('lost', (err) => this.#lost(unit, err));
    return unit;
  }

  async open() {
    if (this.hostError) throw this.hostError;
    const unit = await this.#newUnit();
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
    await this.#openCommands();
    this.refreshTimer = setInterval(() => this.#refresh().catch(() => {}), this.refreshMs);
    this.refreshTimer.unref?.();
    return {
      channelCount: this.channels,
      properties: propertyDescriptors({ model: this.state.device.model, quickToggles: this.quickToggles }),
      layout: layoutFor(this.device?.product, { quickToggles: this.quickToggles }),
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
    clearTimeout(this.commandRetry);
    this.refreshTimer = null;
    const unit = this.unit;
    this.unit = null;
    await unit?.close();
    await this.#closeCommands();
  }

  #fatal(err) {
    if (this.closed) return;
    this.log('error', err.message);
    this.onFatal?.(err);
  }

  /** One condition shown on the device, replaced by id; `null` clears it. The host hears only changes. */
  #setCondition(id, warning) {
    const before = this.conditions.get(id);
    if (warning) this.conditions.set(id, { id, ...warning });
    else this.conditions.delete(id);
    const after = this.conditions.get(id);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.onWarnings?.([...this.conditions.values()]);
  }

  // -- the command-strings side ---------------------------------------------------------

  /** Shure's documented control port, read once and then kept current from the unit's own reports. */
  async #openCommands() {
    if (this.closed || this.commands) return;
    const port = this.simulated ? (await ensureSimulator()).commandPort : COMMAND_PORT;
    const client = new CommandClient({ host: this.host, port, log: (l, m) => this.log(l, m) });
    try {
      await client.connect();
    } catch (err) {
      this.log('warn', `no command connection (${err.message}); transmitter and ShowLink details are unavailable`);
      this.#setCondition('commands-unavailable', { severity: 'info', message: `The receiver's control port (${port}) did not answer, so transmitter and ShowLink details are not shown. Retrying.` });
      this.#retryCommands();
      return;
    }
    this.commands = client;
    client.on('rep', (rep) => this.#onCommandReport(rep));
    client.on('lost', (err) => {
      if (this.closed || this.commands !== client) return;
      this.commands = null;
      this.log('info', `the command connection dropped (${err.message})`);
      this.#retryCommands();
    });
    try {
      for (let c = 1; c <= this.channels; c += 1) {
        const values = {};
        for (const prop of [...TX_PROPS, ...STATUS_PROPS]) values[prop] = (await client.getChannel(c, prop))[0];
        this.commandValues[c] = values;
        this.commandSlots[c] = {
          SLOT_STATUS: await client.getSlots(c, 'SLOT_STATUS'),
          SLOT_SHOWLINK_STATUS: await client.getSlots(c, 'SLOT_SHOWLINK_STATUS'),
          SLOT_TX_MODEL: await client.getSlots(c, 'SLOT_TX_MODEL'),
        };
      }
    } catch (err) {
      this.log('warn', `the command read did not complete (${err.message})`);
    }
    this.#setCondition('commands-unavailable', null);
    this.#applyCommandState();
    // the channel quality is a metered value: one SAMPLE a second per channel lights the card's Q row
    try {
      for (let c = 1; c <= this.channels; c += 1) await client.setMeterRate(c, SAMPLE_MS);
    } catch (err) {
      this.log('warn', `metering did not start (${err.message})`);
    }
  }

  #retryCommands() {
    if (this.closed) return;
    clearTimeout(this.commandRetry);
    this.commandRetry = setTimeout(() => this.#openCommands().catch(() => {}), COMMAND_RETRY_MS);
    this.commandRetry.unref?.();
  }

  async #closeCommands() {
    clearTimeout(this.commandRetry);
    const client = this.commands;
    this.commands = null;
    if (client?.connected) {
      // the unit keeps streaming SAMPLE lines to every client until the rate is set back to 0
      for (let c = 1; c <= this.channels; c += 1) await client.setMeterRate(c, 0).catch(() => {});
    }
    await client?.close();
  }

  /** A report the unit sent on its own: a transmitter arriving or leaving, a slot linking, a flag changing. */
  #onCommandReport({ channel, prop, args, sample }) {
    if (channel == null || this.closed) return;
    if (prop === 'SAMPLE') {
      // the unit's channel quality (0..5: `qual` as the receiver tile draws it, and on the 0..100 link
      // meter), and which antennas are receiving (the tile's A/B dots)
      const reading = (this.meters[channel] ??= {});
      // unknown (no transmitter) is published as 0: a reading left out would keep its old value on the host
      reading.qual = sample.quality ?? 0;
      reading.lqi = (sample.quality ?? 0) * 20;
      if (sample.antennas) {
        reading.div1 = sample.antennas[0] === true;
        reading.div2 = sample.antennas[1] === true;
      }
      if (this.live) this.onState?.('meters', { timestamp: Date.now(), channels: { [channel]: { ...reading } } });
      return;
    }
    if (prop.startsWith('SLOT_')) {
      const [slot, ...rest] = args;
      ((this.commandSlots[channel] ??= {})[prop] ??= {})[Number(slot)] = rest.join(' ');
    } else if (TX_PROPS.includes(prop) || STATUS_PROPS.includes(prop)) {
      (this.commandValues[channel] ??= {})[prop] = args[0];
    } else return;
    this.#applyCommandState();
  }

  /** What the command side knows, folded into the channel state, and published. */
  #applyCommandState() {
    for (let c = 1; c <= this.channels; c += 1) {
      const ch = (this.state.channels[c] ??= {});
      const values = this.commandValues[c] ?? {};
      const slots = this.commandSlots[c] ?? {};
      ch.tx = decodeTransmitter(values);
      const link = decodeShowLink(slots.SLOT_STATUS ?? {}, slots.SLOT_SHOWLINK_STATUS ?? {});
      ch.showLink = link.linked;
      ch.showLinkDetail = link;
      ch.status = {
        encryption: values.ENCRYPTION_STATUS ?? null,
        interference: values.INTERFERENCE_STATUS ?? null,
        unregisteredTx: values.UNREGISTERED_TX_STATUS ?? null,
      };
    }
    this.#reportStatusConditions();
    if (this.settings.requireShowlinkForFrequency === true) this.#reportLock();
    if (this.live) this.#emitAll();
  }

  /** The unit's own alarms, as device notices: interference, an unregistered transmitter, an encryption mismatch. */
  #reportStatusConditions() {
    const list = (pick) => Array.from({ length: this.channels }, (_, i) => i + 1).filter((c) => pick(this.state.channels[c]?.status ?? {}));
    const say = (chs) => `channel${chs.length > 1 ? 's' : ''} ${chs.join(', ')}`;
    const interference = list((s) => s.interference === 'DETECTED');
    this.#setCondition('interference', interference.length ? { severity: 'warning', message: `Interference detected on ${say(interference)}.` } : null);
    const unregistered = list((s) => s.unregisteredTx === 'ERROR');
    this.#setCondition('unregistered-transmitter', unregistered.length ? { severity: 'warning', message: `An unregistered transmitter is on ${say(unregistered)}.` } : null);
    const mismatch = list((s) => s.encryption === 'ERROR');
    this.#setCondition('encryption-mismatch', mismatch.length ? { severity: 'warning', message: `Encryption mismatch on ${say(mismatch)}: the transmitter needs an IR sync.` } : null);
  }

  #expectRestart() {
    this.restartExpectedUntil = Date.now() + RESTART_WINDOW_MS;
    this.#setCondition('restarting', { severity: 'info', message: 'HD mode changed: the receiver is restarting itself and its transmitters are unpaired. It is back in about half a minute; IR-sync the transmitters again afterwards.' });
  }

  /** The session dropped: the restart that follows an HD mode change, which is ridden out, or a fault. */
  #lost(unit, err) {
    if (this.closed || unit !== this.unit) return;
    if (Date.now() > this.restartExpectedUntil) {
      this.#fatal(err);
      return;
    }
    this.log('info', `the unit dropped the session (${err.message}); waiting for it to restart`);
    // a drop that lands while a reconnect is in progress means that session is dead too: go round again
    this.reconnectWanted = true;
    this.reconnecting ??= (async () => {
      while (this.reconnectWanted && !this.closed) {
        this.reconnectWanted = false;
        await this.#reconnect();
      }
    })()
      .catch((err) => this.#fatal(err))
      .finally(() => {
        this.reconnecting = null;
      });
  }

  async #reconnect() {
    this.live = false;
    this.onState?.('connection', { connected: false, since: new Date().toISOString() });
    const old = this.unit;
    this.unit = null;
    await old?.close();
    const deadline = this.restartExpectedUntil;
    while (!this.closed) {
      const unit = await this.#newUnit();
      try {
        await unit.connect();
      } catch (err) {
        await unit.close();
        if (Date.now() > deadline) {
          this.#fatal(new Error(`the unit did not come back after restarting: ${err.message}`));
          return;
        }
        await delay(RECONNECT_GAP_MS);
        continue;
      }
      if (this.closed) {
        await unit.close();
        return;
      }
      this.unit = unit;
      this.restartExpectedUntil = 0;
      try {
        await this.#refresh({ initial: true });
        this.live = true;
        await unit.subscribeAll();
      } catch (err) {
        // the session died while it was being rebuilt (a second restart): the loop goes round again
        this.log('info', `the rebuilt session was lost (${err.message})`);
        this.reconnectWanted = true;
        return;
      }
      if (unit !== this.unit) return; // replaced meanwhile
      // only now is the unit fully back: state read, every property subscribed, the command side reopened
      await this.#closeCommands();
      await this.#openCommands();
      this.onState?.('connection', { connected: true, since: new Date().toISOString() });
      this.#setCondition('restarting', null);
      this.log('info', 'the unit is back after restarting');
      return;
    }
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
    if (channel != null && METER_KEYS[key]) {
      // the live meters go out as one reading per channel (antenna A and B in dBm, audio in dBFS),
      // each carrying every field heard so far, so a patch is always a consistent sample
      const reading = (this.meters[channel] ??= {});
      reading[METER_KEYS[key]] = value;
      this.onState?.('meters', { timestamp: Date.now(), channels: { [channel]: { ...reading } } });
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
    emit(KEYS.toneGen, this.#channelMap((c) => (c.toneLevelDb == null ? undefined : toneLevelDb(c.toneLevelDb) != null)));
    emit(KEYS.diversity, this.#channelMap((c) => c.diversity));
    emit(KEYS.overloadHold, this.#channelMap((c) => c.overloadHold));
    emit(KEYS.interferenceAvoidance, this.#channelMap((c) => c.interferenceAvoidance));
    emit(KEYS.unregisteredTx, this.#channelMap((c) => c.unregisteredTx));
    emit(KEYS.rfPower, this.#channelMap((c) => c.rfPower));
    emit(KEYS.encryption, this.#channelMap((c) => c.encryption));
    emit(KEYS.talk, this.#channelMap((c) => c.talk));
    emit(
      KEYS.transmitter,
      this.#channelMap((c) => {
        if (c.tx?.present) {
          return { present: true, model: c.tx.model, serial: c.txSerial ?? null, deviceId: c.tx.deviceId, powerMw: c.tx.powerMw, muteMode: c.tx.muteMode, talkSwitch: c.tx.talkSwitch, lock: c.tx.lock, batteryType: c.tx.batteryType };
        }
        if (c.txModel === undefined && c.txSerial === undefined && c.tx === undefined) return undefined;
        return { present: !!(c.txModel || c.txSerial), model: c.txModel ?? null, serial: c.txSerial ?? null, deviceId: null, powerMw: null, muteMode: null, talkSwitch: null, lock: null, batteryType: null };
      })
    );
    emit(KEYS.showLink, this.#channelMap((c) => (c.showLinkDetail ? { linked: c.showLinkDetail.linked, quality: c.showLinkDetail.quality, percent: c.showLinkDetail.quality == null ? 0 : c.showLinkDetail.quality * 20, activeSlots: c.showLinkDetail.activeSlots, registered: c.showLinkDetail.registered } : undefined)));
    emit(KEYS.status, this.#channelMap((c) => c.status));
    emit(KEYS.band, this.#channelMap((c) => c.band));
    // the host's receiver tile reads these standard keys: the transmitter's power (255 = none, which
    // also hides the battery), the unit's mode/band/encryption, and interference on the RF meters
    emit('transmitterInfo', this.#channelMap((c) => (c.tx === undefined ? undefined : { powerLevel: isNum(c.tx.powerMw) ? c.tx.powerMw : 255 })));
    emit('channelStatus', this.#channelMap((c) => (c.status ? { rfIntDet: c.status.interference === 'DETECTED' ? 'CRITICAL' : 'NONE' } : undefined)));
    // an ANX4 has no unit-wide band: show the channels' when they agree, else list them
    const channelBands = [...new Set(Object.values(this.state.channels).map((c) => c.band).filter(Boolean))];
    const unitBand = dev.band ?? (channelBands.length ? channelBands.join(', ') : undefined);
    if (unitBand !== undefined || dev.hdMode !== undefined) {
      emit('deviceProperties', {
        rfBand: unitBand ?? null,
        transmissionMode: dev.hdMode == null ? null : dev.hdMode ? 'HIGH_DENSITY' : 'STANDARD',
        encryptionMode: this.state.channels[1]?.encryption == null ? null : this.state.channels[1].encryption === 'On' ? 'ON' : 'OFF',
      });
    }
    emit(KEYS.lastSync, this.#channelMap((c) => c.lastSync));
    emit(KEYS.unlink, { channels: Object.fromEntries(Array.from({ length: this.channels }, (_, i) => [i + 1, 'None'])) });
    // the transmitter's battery: percent and runtime from the control port, else the percent the ACN bank gives
    const battery = this.#channelMap((c) => {
      if (isNum(c.tx?.batteryPercent)) return { percent: c.tx.batteryPercent, ...(isNum(c.tx.batteryMinutes) ? { lifetimeInMinutes: c.tx.batteryMinutes } : {}) };
      return isNum(c.txBattery) ? { percent: c.txBattery } : undefined;
    });
    if (battery) emit('battery', { timestamp: Date.now(), channels: battery.channels });
    emit(KEYS.unit, {
      fanMode: fanModeOf(dev.fanAlwaysOn),
      model: dev.model,
      serial: dev.serial,
      band: unitBand,
      hdMode: dev.hdMode,
      antennas: [dev.antennaA, dev.antennaB, dev.antennaC, dev.antennaD].filter(Boolean).join(', ') || undefined,
      quadversity: dev.quadversity == null ? undefined : dev.quadversity ? 'On' : 'Off',
      antennaBias: dev.antennaBias,
      encryption: this.state.channels[1]?.encryption,
      ...(showLinkLockOffered() ? { requireShowlinkForFrequency: this.settings.requireShowlinkForFrequency === true } : {}),
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

  /**
   * ShowLink on a channel: `true` when a registered ADX transmitter is online over ShowLink
   * (a slot LINKED.ACTIVE on the unit's control port), `false` when not, `null` while unknown.
   */
  #showLink(channelIndex) {
    const v = this.state.channels[channelIndex]?.showLink;
    return typeof v === 'boolean' ? v : null;
  }

  #assertFrequencyAllowed(channelIndex) {
    if (!showLinkLockOffered() || this.settings.requireShowlinkForFrequency !== true) return;
    if (this.#showLink(channelIndex) === true) return;
    throw new HttpError(
      409,
      'frequency_locked',
      `frequency changes on channel ${channelIndex} are blocked until its transmitter has ShowLink ("Require Showlink For Frequency" is on)`
    );
  }

  /** While the lock is on, say which channels it is holding, so a refused change is no surprise. */
  #reportLock() {
    const held = showLinkLockOffered() && this.settings.requireShowlinkForFrequency === true
      ? Array.from({ length: this.channels }, (_, i) => i + 1).filter((c) => this.#showLink(c) !== true)
      : [];
    this.#setCondition('frequency-locked', held.length
      ? { severity: 'info', message: `Frequency changes are blocked on channel${held.length > 1 ? 's' : ''} ${held.join(', ')}: no ShowLink. Turn off "Require Showlink For Frequency" to allow them.` }
      : null);
  }

  async #setProperty({ propertyId, channelIndex, value }) {
    const unit = this.unit;
    if (!unit?.connected) throw new HttpError(503, 'device_unavailable', `no live session with the AD4Q at ${this.host}`);

    const channelScoped = new Set([
      'mute', 'gain', 'frequency', 'channelName', 'toneLevel', 'toneFrequency',
      'frequencyDiversity', 'overloadHold', 'interferenceAvoidance', 'unregisteredTransmitter', 'toneGenerator',
      'transmitterPower', 'unlinkTransmitter', ...TALK_BY_PROPERTY.keys(),
    ]);
    if (channelScoped.has(propertyId) && (!Number.isInteger(channelIndex) || channelIndex < 1 || channelIndex > this.channels)) {
      throw new HttpError(400, 'unknown_channel', `${propertyId} is per channel; channelIndex must be 1..${this.channels}`);
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
      case 'identify': {
        // the unit's own flash, on the control port; a channel index flashes that channel's display
        if (!this.commands?.connected) throw new HttpError(503, 'device_unavailable', 'the receiver\'s control port is not connected, so it cannot be identified');
        await this.commands.identify(Number.isInteger(channelIndex) && channelIndex >= 1 && channelIndex <= this.channels ? channelIndex : null);
        return null;
      }
      case 'requireShowlinkForFrequency':
        if (!showLinkLockOffered()) throw new HttpError(400, 'unknown_property', `No property ${propertyId} on ${this.device?.product ?? PRODUCT}`);
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        this.settings = saveDeviceSettings(this.device.id, { requireShowlinkForFrequency: value });
        this.#emitAll();
        this.#reportLock();
        return null;
      case 'frequency':
        this.#assertFrequencyAllowed(channelIndex);
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
      case 'toneGenerator':
        if (!this.quickToggles) throw new HttpError(400, 'unknown_property', 'the quick toggles are turned off in the plugin settings');
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        target = ['channel', 'toneLevelDb', value ? QUICK_TONE_DB : null];
        break;
      case 'toneFrequency':
        if (!isNum(value)) throw badValue(propertyId, 'a number in Hz');
        target = ['channel', 'toneFreqHz', clamp(Math.round(value), TONE_FREQ_MIN_HZ, TONE_FREQ_MAX_HZ)];
        break;
      case 'frequencyDiversity': {
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
      case 'unregisteredTransmitter': {
        const action = oneOf(value, UNREGISTERED_ACTIONS);
        if (!action) throw badValue(propertyId, `one of ${UNREGISTERED_ACTIONS.join(', ')}`);
        target = ['channel', 'unregisteredTx', action];
        break;
      }
      case 'deviceName':
        if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) throw badValue(propertyId, 'printable ASCII text');
        target = ['device', 'name', value.slice(0, DEVICE_NAME_MAX)];
        break;
      case 'fanMode': {
        const mode = oneOf(value, FAN_MODES);
        if (!mode) throw badValue(propertyId, `one of ${FAN_MODES.join(', ')}`);
        target = ['device', 'fanAlwaysOn', mode === FAN_MODES[1]];
        break;
      }
      case 'powerLock':
      case 'panelLock':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        target = ['device', propertyId, value];
        break;
      case 'transmitterPower': {
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
      case 'highDensityMode':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        target = ['device', 'hdMode', value];
        break;
      case 'quadversity':
        // the unit refuses this write over the network (SET_FAIL reason 4) and the panel toggle restarts it
        throw new HttpError(400, 'read_only', 'Quadversity can only be switched on the unit\'s front panel; the receiver refuses it over the network');
      case 'band': {
        const bands = BANDS_BY_RANGE[rangeOf(this.state.device.model)];
        if (!bands) throw new HttpError(400, 'read_only', 'the band of this unit\'s frequency range is not changeable from this plugin yet');
        const band = bands.find((b) => b.toLowerCase() === String(value).trim().toLowerCase());
        if (!band) throw badValue(propertyId, `one of ${bands.join(', ')}`);
        target = ['device', 'band', band];
        break;
      }
      case 'encryption': {
        const mode = oneOf(value, ['Off', 'On']);
        if (!mode) throw badValue(propertyId, 'Off or On');
        target = ['encryption', mode === 'On'];
        break;
      }
      case 'antennaBias':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        target = ['device', 'antennaBias', value];
        break;
      default:
        if (TALK_BY_PROPERTY.has(propertyId)) {
          if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
          target = ['talk', TALK_BY_PROPERTY.get(propertyId), value];
          break;
        }
        throw new HttpError(400, 'unknown_property', `No property ${propertyId} on ${this.device?.product ?? PRODUCT}`);
    }

    const [scope, key, encoded] = target;
    let held;
    try {
      if (scope === 'channel') held = await unit.setChannel(channelIndex, key, encoded);
      else if (scope === 'device') {
        held = await unit.setDevice(key, encoded);
        if (key === 'hdMode') this.#expectRestart();
      }
      else if (scope === 'talk') held = await unit.setTalkOutput(channelIndex, key, encoded);
      else if (scope === 'encryption') held = await unit.setChannel(1, 'encryption', key);
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

// ---------------------------------------------------------------------------
// the spectrum analyzer adapter
// ---------------------------------------------------------------------------

const ANTENNA_CHOICES = [
  { id: 'A', label: 'Antenna A' },
  { id: 'B', label: 'Antenna B' },
  { id: 'AB', label: 'A + B (composite)' },
];
const ANTENNAS_OF = { A: ['A'], B: ['B'], AB: ['A', 'B'] };
const fmtMhz = (khz) => (khz / 1000).toFixed(3).replace(/\.?0+$/, '');
/** The highest stop frequency any band of a range reaches, where known (A: H54 ends at 636 MHz). */
const RANGE_CEILING_KHZ = Object.freeze({ A: 636_000 });

class Ad4qSpectrumAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.pluginConfig = pluginConfig;
    this.channels = channelsOfProduct(device?.product);
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
    this.unit = null;
    this.limits = null;
    this.plan = null;
    this.controls = { channel: 1, antenna: 'AB' };
    // one scan at a time: the run in flight, and what stops it
    this.run = null;
    this.stopRun = null;
    this.closed = false;
    this.unitOptions = null;
    this.reconnecting = null;
    this.reconnectWanted = false;
    this.relimiting = null;
    this.band = null;
    // assigned by the shell before open()
    this.onWarnings = null;
    this.onFatal = null;
    this.onEffectiveConfig = null;
  }

  log(level, message) {
    log(level, `[${this.device.id}] ${message}`);
  }

  async open() {
    if (this.hostError) throw this.hostError;
    let options = { host: this.host, channels: this.channels, log: (l, m) => this.log(l, m) };
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
      options = { ...options, cid: deviceCid(this.device), browser: ensureBrowser(this.pluginConfig) };
    }
    const unit = new Ad4qDevice(options);
    unit.on('lost', (err) => this.#lost(unit, err));
    unit.on('prop', (change) => this.#onProp(change));
    this.unit = unit;
    await unit.connect();
    if (this.closed) {
      await unit.close();
      throw new Error('closed while connecting');
    }
    // the range, origin and step are the unit's own: a 470, 606 or 750 MHz receiver says which it is
    this.limits = await unit.scanLimits();
    this.unitOptions = options;
    // the start and stop follow the band, and the unit pushes them when it changes
    await unit.subscribe([SCAN_LIMITS.START, SCAN_LIMITS.STOP, DEV.BAND]);
    const model = decodeString(await unit.get(DEV.MODEL).catch(() => Buffer.alloc(0)));
    const serial = decodeString(await unit.get(DEV.SERIAL).catch(() => Buffer.alloc(0)));
    this.plan = planScan({ limits: this.limits, ...defaultSpan(this.limits) });
    const { stepKhz } = this.limits;
    this.band = decodeString(await unit.get(DEV.BAND).catch(() => Buffer.alloc(0)));
    // the dialog's hard limits are reported once, so they span every band of this range; the plan clamps to the band in use
    const ceilingKhz = Math.max(this.limits.stopKhz, RANGE_CEILING_KHZ[rangeOf(model)] ?? 0);
    // the unit's whole range is the configuration in effect until the host applies one, so the
    // dialog opens on this unit's own start and stop rather than the host's generic defaults.
    // Reported just after open() returns (nothing may be awaited after this): the shell only
    // takes it once it holds this adapter.
    const announce = setTimeout(() => {
      if (!this.closed && this.plan) this.onEffectiveConfig?.(this.#applied());
    }, 0);
    announce.unref?.();
    return {
      capabilities: {
        minFrequencyHz: this.limits.originKhz * 1000,
        maxFrequencyHz: ceilingKhz * 1000,
        minStepHz: stepKhz * 1000,
        maxStepHz: stepKhz * 1000,
        autoPointCount: true,
        controls: [
          {
            id: 'channel',
            type: 'dropdown',
            label: 'Scan from channel',
            default: 1,
            choices: Array.from({ length: this.channels }, (_, i) => ({ id: i + 1, label: `Channel ${i + 1}` })),
            help: 'The receiver channel whose antennas the scan is taken from.',
          },
          {
            id: 'antenna',
            type: 'dropdown',
            label: 'Antenna',
            default: 'AB',
            choices: ANTENNA_CHOICES,
            help: 'A + B scans each antenna in turn and shows the stronger of the two, with each antenna\'s own curve beside it.',
          },
          {
            id: 'about',
            type: 'static-text',
            label: 'About this scan',
            default:
              `In band ${this.band ?? '?'} this receiver scans ${fmtMhz(this.limits.startKhz)} to ${fmtMhz(this.limits.stopKhz)} MHz in ${stepKhz} kHz steps; ` +
              'the range follows the band. One scan at the unit\'s own fixed resolution, about two minutes per antenna over the whole range. ' +
              'Start and Stop narrow the scan to part of that range, which is faster; RBW, mode and offset do not apply.',
          },
        ],
      },
      identity: { model: model ?? 'AD4Q', serial: serial ?? undefined, firmware: null },
    };
  }

  async close() {
    this.closed = true;
    await this.#stop();
    const unit = this.unit;
    this.unit = null;
    await unit?.close();
  }

  #fatal(err) {
    if (this.closed) return;
    this.log('error', err.message);
    this.onFatal?.(err);
  }

  /**
   * The session dropped. A unit says goodbye only when it is restarting (an HD mode change, from
   * anywhere), so that is waited out and the session reopened; anything else is a fault.
   */
  #lost(unit, err) {
    if (this.closed || unit !== this.unit) return;
    if (!/ended the session/.test(err.message)) {
      this.#fatal(err);
      return;
    }
    this.log('info', 'the unit is restarting; waiting for it to come back');
    this.reconnectWanted = true;
    this.reconnecting ??= (async () => {
      while (this.reconnectWanted && !this.closed) {
        this.reconnectWanted = false;
        await this.#reconnect();
      }
    })()
      .catch((e) => this.#fatal(e))
      .finally(() => {
        this.reconnecting = null;
      });
  }

  async #reconnect() {
    this.stopRun?.();
    this.#warn([{ id: 'restarting', severity: 'info', message: 'The receiver is restarting; it is back in about half a minute.' }]);
    const old = this.unit;
    this.unit = null;
    await old?.close();
    const deadline = Date.now() + RESTART_WINDOW_MS;
    while (!this.closed) {
      const unit = new Ad4qDevice(this.unitOptions);
      unit.on('lost', (e) => this.#lost(unit, e));
      unit.on('prop', (change) => this.#onProp(change));
      try {
        await unit.connect();
        this.limits = await unit.scanLimits();
        await unit.subscribe([SCAN_LIMITS.START, SCAN_LIMITS.STOP, DEV.BAND]);
      } catch (e) {
        await unit.close();
        if (Date.now() > deadline) throw new Error(`the unit did not come back after restarting: ${e.message}`);
        await delay(RECONNECT_GAP_MS);
        continue;
      }
      if (this.closed) {
        await unit.close();
        return;
      }
      this.unit = unit;
      if (this.reconnectWanted) return; // it dropped again meanwhile: the loop goes round
      this.#warn([]);
      this.log('info', 'the unit is back after restarting');
      return;
    }
  }

  /** What the sweep will cover and how it is taken, as the unit will actually do it. */
  async applyConfig(cfg = {}) {
    const requested = cfg.controls ?? {};
    const channel = Math.trunc(Number(requested.channel));
    if (Number.isInteger(channel) && channel >= 1 && channel <= this.channels) this.controls.channel = channel;
    if (typeof requested.antenna === 'string' && ANTENNAS_OF[requested.antenna]) this.controls.antenna = requested.antenna;

    const wanted = {
      startKhz: isNum(cfg.startHz) ? cfg.startHz / 1000 : (this.plan?.startKhz ?? this.limits.startKhz),
      stopKhz: isNum(cfg.stopHz) ? cfg.stopHz / 1000 : (this.plan?.stopKhz ?? this.limits.stopKhz),
    };
    this.plan = planScan({ limits: this.limits, ...wanted }) ?? planScan({ limits: this.limits, ...defaultSpan(this.limits) });
    return this.#applied();
  }

  /** A pushed property: the band's new scan limits, which the plan and the dialog follow. */
  #onProp({ channel, key }) {
    if (channel != null || !['scanStartKhz', 'scanStopKhz', 'band'].includes(key) || this.closed) return;
    this.relimiting ??= this.#relimit().finally(() => {
      this.relimiting = null;
    });
  }

  async #relimit() {
    // one re-read after the burst of pushes a band change makes
    await delay(300);
    if (this.closed || !this.unit?.connected) return;
    let limits;
    try {
      limits = await this.unit.scanLimits();
    } catch {
      return;
    }
    if (limits.startKhz === this.limits.startKhz && limits.stopKhz === this.limits.stopKhz) return;
    this.limits = limits;
    const current = this.plan;
    // the plan is kept where it still fits the new range, else it becomes the whole of the new range
    this.plan = planScan({ limits, startKhz: current.startKhz, stopKhz: current.stopKhz }) ?? planScan({ limits, ...defaultSpan(limits) });
    this.log('info', `the band changed: the unit now scans ${fmtMhz(limits.startKhz)} to ${fmtMhz(limits.stopKhz)} MHz`);
    this.onEffectiveConfig?.(this.#applied());
  }

  /** The configuration in effect, as the contract's echo: the plan the unit will actually scan. */
  #applied() {
    const { plan } = this;
    return {
      startHz: plan.startKhz * 1000,
      stopHz: plan.stopKhz * 1000,
      pointCount: plan.points,
      controls: { ...this.controls },
      // the host waits a few of these before it calls a quiet device stalled
      resolved: { sweepTimeMs: scanDurationMs(plan.points) * ANTENNAS_OF[this.controls.antenna].length },
    };
  }

  /**
   * One scan per chosen antenna, taken in turn, delivered as a single trace: with both antennas the
   * strongest of the two at each point, with each antenna's own curve alongside. Then it holds; the
   * next scan is the next start.
   */
  async startSweep(onTrace) {
    await this.#stop();
    // a start while the unit is restarting waits for it rather than failing
    if (this.reconnecting) await this.reconnecting;
    if (!this.unit?.connected) throw new HttpError(503, 'device_unavailable', `no live session with the unit at ${this.host}`);
    const stop = new AbortController();
    this.stopRun = () => stop.abort();
    const { plan } = this;
    const { channel, antenna } = this.controls;
    this.run = this.#scan({ onTrace, plan, channel, antennas: ANTENNAS_OF[antenna], signal: stop.signal }).finally(() => {
      this.stopRun = null;
    });
  }

  async stopSweep() {
    await this.#stop();
  }

  async #stop() {
    this.stopRun?.();
    await this.run?.catch(() => {});
    this.run = null;
  }

  #warn(warnings) {
    this.onWarnings?.(warnings);
  }

  async #scan({ onTrace, plan, channel, antennas, signal }) {
    // the ANX4 has no per-channel scan trigger (its four antennas are shared); its scan is not captured yet
    if (isAnx4(this.state?.device?.model)) throw new Error('the ANX4\'s RF scan is not supported by this plugin yet');
    const curves = [];
    let lastReported = -1;
    try {
      for (const [i, antenna] of antennas.entries()) {
        const levels = await this.unit.scan({
          channel,
          antenna,
          plan,
          signal,
          onProgress: (fraction) => {
            const percent = Math.floor(((i + fraction) / antennas.length) * 20) * 5;
            if (percent === lastReported) return;
            lastReported = percent;
            this.#warn([
              {
                id: 'scan-running',
                severity: 'info',
                message: `Scanning from channel ${channel}, antenna ${antenna}${antennas.length > 1 ? ` (${i + 1} of ${antennas.length})` : ''}: ${percent}% done.`,
              },
            ]);
          },
        });
        curves.push(levels);
      }
      if (signal.aborted) return;
      const primary = curves.length > 1 ? peakOf(curves) : curves[0];
      const series = curves.length > 1 ? antennas.map((name, i) => ({ name, amplitudesDbm: curves[i] })) : undefined;
      this.#warn([]);
      onTrace(primary, series);
    } catch (err) {
      if (err instanceof ScanAborted || signal.aborted) {
        this.log('info', 'scan stopped');
        this.#warn([]);
        return;
      }
      this.log('warn', `scan failed: ${err.message}`);
      this.#warn([{ id: 'scan-failed', severity: 'warning', message: `The scan did not complete: ${err.message}. Start the sweep again to retry.` }]);
      if (!this.unit?.connected) this.#fatal(err);
    }
  }
}

export function createMonitoringAdapter(device, pluginConfig) {
  return new Ad4qMonitoringAdapter(device, pluginConfig);
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new Ad4qSpectrumAdapter(device, pluginConfig);
}
