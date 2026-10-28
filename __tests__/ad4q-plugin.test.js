// Contract tests for the adapter, driven through the real shell over real
// HTTP, against the simulated AD4Q — which speaks the device's wire protocol on
// loopback, so the whole stack is under test: shell, adapter, driver, sockets,
// session.

process.env.SB_AD4Q_SIMULATE = '1';
// no SLP multicast on the test machine's real network
process.env.SB_AD4Q_NO_DISCOVERY = '1';
// the ShowLink lock is not offered by default (see README, Known limits); the tests cover it anyway
process.env.SB_AD4Q_SHOWLINK_LOCK = '1';
// the plugin's own per-device settings go to the host's data directory; a scratch one here
process.env.SB_PLUGIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'ad4q-plugin-data-'));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDSHAKE_PREFIX, SSE_EVENTS } from '@soundbase/plugin-contract';
import {
  KEYS,
  PRODUCT,
  PRODUCT_AD4D,
  PRODUCT_ANX4,
  SIM_DEVICE_ID,
  createMonitoringAdapter,
  discoverDevices,
  layoutFor,
  propertyDescriptors,
  getSimulator,
  resolveHost,
  shutdownDiscovery,
} from '../adapter.js';
import { CH, chanAddr } from '../driver/ad4q/properties.js';

const manifest = JSON.parse(readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8'));
const DEVICE_PATH = `/devices/${encodeURIComponent(SIM_DEVICE_ID)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function openEvents() {
  const controller = new AbortController();
  const res = await fetch(`${handle.url}/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const records = [];
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          records.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // aborted by the test
    }
  })();
  return { records, close: () => controller.abort() };
}

const stateFor = (records, key) =>
  records
    .filter((r) => r.event === SSE_EVENTS.DEVICE_STATE && r.data.deviceId === SIM_DEVICE_ID)
    .flatMap((r) => r.data.patches)
    .filter((p) => p.key === key);

const waitFor = async (predicate, timeoutMs = 4000, what = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await predicate();
    if (hit) return hit;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const deviceRow = async () => (await request('GET', '/devices')).body.devices.find((d) => d.id === SIM_DEVICE_ID);
const command = (propertyId, value, channelIndex) =>
  request('POST', `${DEVICE_PATH}/commands`, {
    requestId: `t-${propertyId}-${Math.random().toString(36).slice(2, 6)}`,
    propertyId,
    ...(channelIndex ? { channelIndex } : {}),
    value,
  });
const latest = (stream, key) => stateFor(stream.records, key).at(-1)?.value;

test.after(async () => {
  await handle.close();
  await shutdownDiscovery();
});

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(declared.includes(PRODUCT), `adapter.js announces ${PRODUCT}; the manifest declares ${declared.join(', ')}`);
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('the AD4D is its own two-channel product, declared beside the AD4Q with the same layout', () => {
  const byId = Object.fromEntries(manifest.products.map((p) => [p.deviceTypeId, p]));
  for (const p of manifest.products) assert.equal(p.capabilities.spectrumAnalyzer, /anx4-/.test(p.deviceTypeId) ? undefined : true, `${p.deviceTypeId}: the AD4Q and AD4D scan, the ANX4 not yet`);
  assert.equal(byId[PRODUCT].traits.channelCount, 4);
  assert.equal(byId[PRODUCT_AD4D].traits.channelCount, 2);
  assert.equal(byId[PRODUCT_AD4D].model.id, 'ad4d');
  assert.deepEqual(byId[PRODUCT_AD4D].layout, byId[PRODUCT].layout);
  assert.ok(PRODUCT_AD4D.startsWith(`plugin:${manifest.id}/`));
});

test('the ANX4 is a product per licensed channel count, 1 to 24, on the AD4Q tile with a band cell', () => {
  const byId = Object.fromEntries(manifest.products.map((p) => [p.deviceTypeId, p]));
  for (let n = 1; n <= 24; n += 1) {
    const p = byId[PRODUCT_ANX4(n)];
    assert.ok(p, `${PRODUCT_ANX4(n)} is declared`);
    assert.equal(p.traits.channelCount, n);
    assert.equal(p.model.id, 'ad4q', 'borrows the AD4Q tile');
    assert.equal(p.model.name, 'ANX4');
    const base = byId[PRODUCT].layout.channel.filter((n) => !(n.type === 'control' && n.propertyId === 'transmitterPower'));
    assert.deepEqual(p.layout.channel.slice(0, base.length), base, 'the AD4Q card without its IR-preset control');
    assert.deepEqual(p.layout.channel[base.length], { type: 'value', bind: 'x.shure-ad4q.band', label: 'Band', format: 'text' });
    const sync = p.layout.channel.at(-1);
    assert.equal(sync.label, 'Sync presets');
    assert.equal(sync.children.length, 13);
  }
  assert.equal(manifest.products.length, 26);
});

test('the adapter sizes itself to the product it is given', () => {
  const host = { config: { host: '192.0.2.10' } };
  assert.equal(createMonitoringAdapter({ id: 'net:192.0.2.10', product: PRODUCT_AD4D, ...host }, {}).channels, 2);
  assert.equal(createMonitoringAdapter({ id: 'net:192.0.2.10', product: PRODUCT, ...host }, {}).channels, 4);
  assert.equal(createMonitoringAdapter({ id: 'net:192.0.2.10', ...host }, {}).channels, 4);
});

test('every extension state key the adapter emits is declared, and every one the layout reads is emitted', () => {
  const declared = new Set(manifest.stateKeys.map((k) => (typeof k === 'string' ? k : k.key)));
  for (const key of Object.values(KEYS)) assert.ok(declared.has(key), `${key} is not in the manifest's stateKeys`);
  const binds = [];
  const walk = (nodes) =>
    nodes?.forEach((n) => {
      if (n.bind) binds.push(n.bind);
      walk(n.children);
    });
  const layout = manifest.products[0].layout;
  walk(layout.channel);
  walk(layout.device);
  for (const bind of binds.filter((b) => b.startsWith('x.'))) {
    const key = Object.values(KEYS).find((k) => bind === k || bind.startsWith(`${k}.`));
    assert.ok(key, `the layout binds ${bind}, which no emitted key provides`);
  }
});

test('a discovered unit carries its own address, and no add-by-address form is offered', async () => {
  // a device form would also put an "add by address" row in SoundBase's live-scan picker; units on other
  // subnets are reached through the plugin's "addresses" setting instead
  assert.equal(manifest.deviceConfigFields, undefined);
  const found = (await discoverDevices({})).find((d) => d.id === SIM_DEVICE_ID);
  assert.equal(found.config.host, '127.0.0.1', 'discovery supplies the address');
  assert.equal(resolveHost({ id: 'net:10.10.1.175', config: {} }), '10.10.1.175', 'the id alone names the unit');
  assert.throws(() => resolveHost({ id: 'net:not-an-ip', config: {} }), /needs an IP address/);
  assert.throws(() => resolveHost({ id: 'x', config: { host: 'ad4q.local' } }), /not an IPv4 address/);
});

test('the simulated unit is discovered, then owned and opened by the host', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  const found = await waitFor(deviceRow, 3000, 'discovery');
  assert.equal(found.product, PRODUCT);
  assert.equal(found.discovered, true);

  const added = await request('POST', '/devices', { id: SIM_DEVICE_ID, product: PRODUCT, config: {} });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added.body));

  const device = await waitFor(async () => {
    const row = await deviceRow();
    return row?.status.status === 'ok' ? row : null;
  }, 10_000, 'the device to open');
  assert.equal(device.channelCount, 4);

  const props = new Map(device.properties.map((p) => [p.id, p]));
  for (const id of ['mute', 'gain', 'frequency', 'channelName', 'toneLevel', 'toneFrequency', 'frequencyDiversity', 'overloadHold', 'interferenceAvoidance', 'unregisteredTransmitter', 'transmitterPower', 'unlinkTransmitter', 'talkNormalXlr', 'talkPressedDante', 'deviceName', 'fanMode', 'powerLock', 'panelLock', 'highDensityMode', 'band', 'toneGenerator', 'encryption', 'antennaBias', 'requireShowlinkForFrequency']) {
  assert.equal(props.get('encryption').scope, 'device', 'encryption is one setting for the unit');
    assert.equal(props.get(id)?.access, 'readWrite', `${id} is writable`);
  }
  // the disruptive settings are shown and deliberately not writable
  for (const id of ['quadversity']) {
    assert.equal(props.get(id)?.access, 'readOnly', `${id} is read-only`);
  }
  // every control the layout offers, grouped or not, is a property the device returned
  const controls = (nodes) => nodes.flatMap((n) => (n.type === 'group' ? controls(n.children) : n.type === 'control' ? [n] : []));
  for (const node of controls(device.layout.channel)) {
    assert.ok(props.has(node.propertyId), `the layout offers ${node.propertyId}, which the device does not describe`);
  }
  // the talk switch is a labelled grid: a Normal row and a Pressed row, one switch per output
  const talk = device.layout.channel.find((n) => n.type === 'group' && /talk switch/i.test(n.label));
  assert.deepEqual(talk.children.map((r) => [r.label, r.direction, r.children.map((c) => c.label)]), [
    ['Normal', 'row', ['XLR', 'TRS', 'AES3', 'Dante']],
    ['Pressed', 'row', ['XLR', 'TRS', 'AES3', 'Dante']],
  ]);
  // frequency diversity carries its guidance beside the control and as a detail cell
  const fd = device.layout.channel.find((n) => n.type === 'group' && /frequency diversity/i.test(n.label));
  assert.deepEqual(fd.children.map((n) => n.type), ['control', 'text']);
  assert.equal(fd.children[0].propertyId, 'frequencyDiversity');
  assert.match(fd.children[1].text, /ADX2FD/);
  assert.match(fd.children[1].text, /unlinks/);
  const cell = device.layout.channel.findIndex((n) => n.bind === KEYS.diversity);
  assert.equal(device.layout.channel[cell + 1].type, 'text');
  assert.equal(device.layout.channel[cell + 1].region, 'detail');
  // HD mode, a device setting, carries its warning in the device slot
  const hd = device.layout.device.find((n) => n.type === 'group' && /hd mode/i.test(n.label));
  assert.deepEqual(hd.children.map((n) => n.type), ['control', 'text']);
  assert.equal(hd.children[0].propertyId, 'highDensityMode');
  assert.match(hd.children[1].text, /restarts the receiver/);
  assert.match(hd.children[1].text, /unpairs/);
  assert.equal(hd.children[1].tone, 'warning');
  assert.deepEqual(controls([talk]).map((c) => c.propertyId), [
    'talkNormalXlr', 'talkNormalTrs', 'talkNormalAes3', 'talkNormalDante',
    'talkPressedXlr', 'talkPressedTrs', 'talkPressedAes3', 'talkPressedDante',
  ]);

  // the complete state arrived on device-state
  await waitFor(() => stateFor(stream.records, KEYS.unit).length > 0, 3000, 'state');
  assert.equal(latest(stream, 'deviceName'), 'AD4Q (simulated)');
  assert.equal(stateFor(stream.records, 'connection')[0].value.connected, true);
  assert.deepEqual(stateFor(stream.records, 'channelName')[0], {
    key: 'channelName',
    scope: 'channel',
    operation: 'merge',
    value: { channels: { 1: 'Channel1', 2: 'Channel2', 3: 'Channel3', 4: 'Channel4' } },
  });
  assert.deepEqual(latest(stream, 'frequency'), { channels: { 1: 495, 2: 520, 3: 545, 4: 570 } });
  assert.deepEqual(latest(stream, 'mute'), { channels: { 1: false, 2: false, 3: false, 4: false } });
  assert.deepEqual(latest(stream, 'gain'), { channels: { 1: 0, 2: 0, 3: 0, 4: 0 } });
  assert.deepEqual(latest(stream, KEYS.toneLevel).channels[1], 'Off');
  assert.deepEqual(latest(stream, KEYS.toneFreq).channels[1], 400);
  assert.deepEqual(latest(stream, KEYS.diversity).channels[1], 'Selection');
  assert.deepEqual(latest(stream, KEYS.rfPower).channels[1], 'Normal');
  assert.equal(latest(stream, KEYS.unit).model, 'AD4Q-A');
  assert.equal(latest(stream, KEYS.unit).band, 'G57');

  // the live level arrives as the contract's `meters` reading
  const meters = await waitFor(() => stateFor(stream.records, 'meters').at(-1), 3000, 'meters');
  assert.equal(meters.scope, 'device');
  assert.equal(typeof meters.value.timestamp, 'number');
  const reading = await waitFor(() => {
    const all = Object.assign({}, ...stateFor(stream.records, 'meters').map((r) => Object.values(r.value.channels)[0]));
    return ['rf1', 'rf2', 'af'].every((k) => typeof all[k] === 'number') ? all : null;
  }, 3000, 'all three meters');
  // antenna A and B in dBm on the RF scale, audio on its own: the audio level must not be drawn as RF
  assert.ok(reading.rf1 > -115 && reading.rf1 < -60, `rf1 ${reading.rf1}`);
  assert.ok(reading.rf2 > -115 && reading.rf2 < -60, `rf2 ${reading.rf2}`);
  assert.equal(reading.af, -115);
});

test('a command is accepted with 202 and the unit\'s read-back arrives as state', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();

  const res = await command('toneLevel', -24, 2);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await waitFor(() => latest(stream, KEYS.toneLevel)?.channels?.[2] === -24, 3000, 'the tone level to be reported');
  assert.equal(fake.store.get(chanAddr(2, CH.TONE_LEVEL_DB)).value[0], 0xe8);
  assert.ok(fake.writes.at(-1).committed);

  assert.equal((await command('toneFrequency', 1000, 2)).status, 202);
  await waitFor(() => latest(stream, KEYS.toneFreq)?.channels?.[2] === 1000, 3000, 'the tone frequency');

  assert.equal((await command('mute', true, 1)).status, 202);
  await waitFor(() => latest(stream, 'mute')?.channels?.[1] === true, 3000, 'mute');

  assert.equal((await command('frequencyDiversity', 'combining', 3)).status, 202);
  await waitFor(() => latest(stream, KEYS.diversity)?.channels?.[3] === 'Combining', 3000, 'diversity');

  assert.equal((await command('toneLevel', 'Off', 2)).status, 202);
  await waitFor(() => latest(stream, KEYS.toneLevel)?.channels?.[2] === 'Off', 3000, 'the tone to turn off');

  assert.equal((await command('unregisteredTransmitter', 'Block', 2)).status, 202);
  await waitFor(() => latest(stream, KEYS.unregisteredTx)?.channels?.[2] === 'Block', 3000, 'unregistered transmitter action');
  assert.equal((await command('fanMode', 'Always on')).status, 202);
  await waitFor(() => latest(stream, KEYS.unit)?.fanMode === 'Always on', 3000, 'fan mode');
});

test('out-of-range values are clamped, not rejected', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  assert.equal((await command('gain', 99, 1)).status, 202);
  await waitFor(() => latest(stream, 'gain')?.channels?.[1] === 42, 3000, 'gain clamped to 42 dB');
  assert.equal((await command('frequency', 1500, 4)).status, 202);
  await waitFor(() => latest(stream, 'frequency')?.channels?.[4] === 1000, 3000, 'frequency clamped to the top of the band');
});

test('a change made on the unit itself is reported', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  getSimulator().setLocal(chanAddr(3, CH.MUTE), Buffer.from([1]));
  await waitFor(() => latest(stream, 'mute')?.channels?.[3] === true, 3000, 'the panel mute');
});

test('requests the plugin can tell are impossible are answered 400', async () => {
  const bad = async (propertyId, value, channelIndex, error) => {
    const res = await command(propertyId, value, channelIndex);
    assert.equal(res.status, 400, `${propertyId}: ${JSON.stringify(res.body)}`);
    if (error) assert.equal(res.body.error, error);
  };
  await bad('gain', 'loud', 1, 'bad_value');
  await bad('toneLevel', -7, 1, 'bad_value');
  await bad('frequencyDiversity', 'sideways', 1, 'bad_value');
  await bad('mute', 'yes', 1, 'bad_value');
  await bad('mute', true, undefined, 'unknown_channel');
  await bad('mute', true, 9, 'unknown_channel');
  await bad('transmitterPower', 'Turbo', 1, 'bad_value');
  await bad('talkNormalXlr', 'yes', 1, 'bad_value');
  await bad('unlinkTransmitter', 'Slot 9', 1, 'bad_value');
  await bad('quadversity', true, undefined, 'read_only');
  await bad('toneVolume', 3, 1, 'unknown_property');
});

test('the talk switch routes each output on its own, leaving the others as they were', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();
  assert.equal((await command('talkNormalDante', false, 1)).status, 202);
  await waitFor(() => latest(stream, KEYS.talk)?.channels?.[1]?.danteNormal === false, 3000, 'Dante (normal) off');
  assert.equal((await command('talkPressedXlr', false, 1)).status, 202);
  await waitFor(() => latest(stream, KEYS.talk)?.channels?.[1]?.xlrPressed === false, 3000, 'XLR (pressed) off');
  const routing = latest(stream, KEYS.talk).channels[1];
  assert.equal(routing.danteNormal, false);
  assert.equal(routing.xlrNormal, true, 'an output left alone is still on');
  // a set bit means OFF: bit 3 (Dante, normal) and bit 4 (XLR, pressed)
  assert.equal(fake.store.get(chanAddr(1, CH.TALK_ROUTING)).value[0], 0b0001_1000);
  assert.equal((await command('talkNormalDante', true, 1)).status, 202);
  await waitFor(() => latest(stream, KEYS.talk)?.channels?.[1]?.danteNormal === true, 3000, 'Dante (normal) back on');
  assert.equal(fake.store.get(chanAddr(1, CH.TALK_ROUTING)).value[0], 0b0001_0000);
});

test('the IR preset\'s RF power is writable', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  assert.equal((await command('transmitterPower', 'High', 3)).status, 202);
  await waitFor(() => latest(stream, KEYS.rfPower)?.channels?.[3] === 'High', 3000, 'RF power High');
  assert.equal(getSimulator().store.get(chanAddr(3, CH.RF_POWER)).value[0], 2);
  assert.equal((await command('transmitterPower', 'no change', 3)).status, 202);
  await waitFor(() => latest(stream, KEYS.rfPower)?.channels?.[3] === 'No change', 3000, 'RF power left to the transmitter');
  assert.equal(getSimulator().store.get(chanAddr(3, CH.RF_POWER)).value[0], 0xff);
});

test('a transmitter syncing in is reported, and leaving clears it', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();
  fake.syncTransmitter(2, 1, { model: 'ADX2', serial: '0048ba2e', battery: 87 });
  await waitFor(() => latest(stream, KEYS.transmitter)?.channels?.[2]?.present === true, 3000, 'the transmitter');
  assert.deepEqual((({ present, model, serial }) => ({ present, model, serial }))(latest(stream, KEYS.transmitter).channels[2]), { present: true, model: 'ADX2', serial: '0048ba2e' });
  await waitFor(() => latest(stream, 'battery')?.channels?.[2]?.percent === 87, 3000, 'its battery');
  // the roster slot flashes the identity and type of what was synced, then clears
  await waitFor(() => latest(stream, KEYS.lastSync)?.channels?.[2]?.model === 'ADX2', 3000, 'the last sync');
  assert.deepEqual(latest(stream, KEYS.lastSync).channels[2], { slot: 1, serial: '48ba2e', model: 'ADX2' });

  fake.removeTransmitter(2);
  await waitFor(() => latest(stream, KEYS.transmitter)?.channels?.[2]?.present === false, 3000, 'the transmitter to leave');
});

test('unlinking a roster slot clears it on the unit and forgets the last sync', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();
  fake.syncTransmitter(4, 2, { model: 'AD3', serial: '00112233', battery: 50 });
  await waitFor(() => latest(stream, KEYS.lastSync)?.channels?.[4]?.slot === 2, 3000, 'the sync');
  assert.equal(latest(stream, KEYS.lastSync).channels[4].model, 'AD3');

  const before = fake.writes.length;
  assert.equal((await command('unlinkTransmitter', 'Slot 2', 4)).status, 202);
  await waitFor(() => fake.writes.length > before, 3000, 'the write');
  const write = fake.writes.at(-1);
  assert.equal(write.addr, chanAddr(4, 0x08c1));
  assert.deepEqual([...write.value], new Array(16).fill(0));
  assert.ok(write.committed);
  await waitFor(() => latest(stream, KEYS.lastSync)?.channels?.[4]?.slot === null, 3000, 'the last sync to clear');
  // the resting position is a no-op, not a write
  const count = fake.writes.length;
  assert.equal((await command('unlinkTransmitter', 'None', 4)).status, 202);
  await delay(100);
  assert.equal(fake.writes.length, count);
});

test('HD mode is writable; the restart it causes is ridden out and the device stays owned', async () => {
  const stream = await openEvents();
  try {
    const opened = await waitFor(async () => {
      const row = await deviceRow();
      return row?.status.status === 'ok' && row.properties ? row : null;
    }, 5000, 'the opened device');
    const before = opened.properties.find((p) => p.id === 'highDensityMode');
    assert.equal(before.access, 'readWrite');
    assert.deepEqual(before.effects, ['deviceRestart']);
    const fake = getSimulator();
    const restartsBefore = fake.restarts;
    const res = await command('highDensityMode', true);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    // the unit goes away and comes back; the device is never reported failed
    await waitFor(() => stateFor(stream.records, 'connection').some((p) => p.value.connected === false), 4000, 'the drop');
    const row = await deviceRow();
    assert.notEqual(row.status.status, 'failed');
    assert.ok(row.status.warnings?.some((w) => w.id === 'restarting'), JSON.stringify(row.status));
    await waitFor(() => stateFor(stream.records, 'connection').at(-1)?.value.connected === true && latest(stream, KEYS.unit)?.hdMode === true, 8000, 'the unit back with HD mode on');
    assert.equal(fake.restarts, restartsBefore + 1);
    assert.equal((await deviceRow()).status.status, 'ok');
    await waitFor(async () => !(await deviceRow()).status.warnings?.length, 3000, 'the restart warning to clear');
    // and back to standard, which restarts it again: the drop comes after the write is confirmed
    const dropsBefore = stateFor(stream.records, 'connection').filter((p) => p.value.connected === false).length;
    assert.equal((await command('highDensityMode', false)).status, 202);
    await waitFor(() => stateFor(stream.records, 'connection').filter((p) => p.value.connected === false).length > dropsBefore, 4000, 'the second drop');
    await waitFor(() => latest(stream, KEYS.unit)?.hdMode === false && stateFor(stream.records, 'connection').at(-1)?.value.connected === true, 10_000, 'standard mode again');
    assert.equal(fake.restarts, restartsBefore + 2);
  } finally {
    stream.close();
  }
});

test('encryption per channel and antenna bias are switchable, and read back', async () => {
  const stream = await openEvents();
  try {
    const fake = getSimulator();
    assert.equal((await command('encryption', 'On')).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.encryption === 'On', 3000, 'encryption on');
    await waitFor(() => latest(stream, 'deviceProperties')?.encryptionMode === 'ON', 3000, 'the tile\'s encryption');
    // the unit applies it to every channel, and the cards say so
    // a channel-map patch carries only the channels that changed, so each channel is read across patches
    const channelValue = (key, ch) => stateFor(stream.records, key).map((p) => p.value.channels?.[ch]).filter((v) => v !== undefined).at(-1);
    await waitFor(() => channelValue(KEYS.encryption, 1) === 'On' && channelValue(KEYS.encryption, 4) === 'On', 3000, `every channel (encryption patches: ${JSON.stringify(stateFor(stream.records, KEYS.encryption).slice(-4).map((p) => p.value))}; fake store ch1..4: ${[1, 2, 3, 4].map((c) => fake.store.get(chanAddr(c, CH.ENCRYPTION)).value[0]).join(',')}; controllers: ${[...fake.controllers.values()].map((c) => `${c.rinfo.port} declared=${c.declared} subCh2=${c.subscribed.has(chanAddr(2, CH.ENCRYPTION))} subs=${c.subscribed.size}`).join(' | ')})`);
    assert.equal(fake.store.get(chanAddr(1, CH.ENCRYPTION)).value[0], 0x03, 'the unit\'s on value');
    assert.equal((await command('encryption', 'Off')).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.encryption === 'Off', 3000, 'encryption off');
    assert.equal((await command('encryption', 'maybe')).status, 400);
    assert.equal((await command('antennaBias', true)).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.antennaBias === true, 3000, 'bias on');
    assert.equal((await command('antennaBias', false)).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.antennaBias === false, 3000, 'bias off');
  } finally {
    stream.close();
  }
});

test('"Require Showlink For Frequency" blocks every frequency change while on, and is remembered', async () => {
  const stream = await openEvents();
  try {
    assert.equal((await command('frequency', 500, 1)).status, 202, 'allowed while the lock is off');
    await waitFor(() => latest(stream, 'frequency')?.channels?.[1] === 500, 3000, 'the retune');
    assert.equal((await command('requireShowlinkForFrequency', true)).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.requireShowlinkForFrequency === true, 3000, 'the lock on');
    const blocked = await command('frequency', 505, 1);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, 'frequency_locked');
    assert.match(blocked.body.detail, /ShowLink/);
    assert.equal((await deviceRow()).status.warnings?.find((w) => w.id === 'frequency-locked')?.severity, 'info');
    // nothing else is locked
    assert.equal((await command('gain', 6, 1)).status, 202);
    // the setting is the plugin's own, kept for the device in its data directory
    const saved = JSON.parse(readFileSync(`${process.env.SB_PLUGIN_DATA_DIR}/device-settings.json`, 'utf8'));
    assert.equal(saved[SIM_DEVICE_ID].requireShowlinkForFrequency, true);
    assert.equal((await command('requireShowlinkForFrequency', false)).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.requireShowlinkForFrequency === false, 3000, 'the lock off');
    assert.equal((await command('frequency', 505, 1)).status, 202, 'allowed again');
    await waitFor(async () => !(await deviceRow()).status.warnings?.some((w) => w.id === 'frequency-locked'), 3000, 'the notice cleared');
  } finally {
    stream.close();
  }
});

test('the transmitter being received is shown, with its battery, and goes away cleanly', async () => {
  const stream = await openEvents();
  try {
    const fake = getSimulator();
    fake.commands.receiveTransmitter(3, { model: 'ADX2', deviceId: 'LeadVox', batteryPercent: 88, batteryMinutes: 125, powerMw: 10, muteMode: 'ON' });
    const tx = await waitFor(() => latest(stream, KEYS.transmitter)?.channels?.[3]?.present === true && latest(stream, KEYS.transmitter).channels[3], 3000, 'the transmitter');
    assert.equal(tx.model, 'ADX2');
    assert.equal(tx.deviceId, 'LeadVox');
    assert.equal(tx.powerMw, 10);
    assert.equal(tx.muteMode, 'ON');
    await waitFor(() => latest(stream, 'battery')?.channels?.[3]?.lifetimeInMinutes === 125 && latest(stream, 'battery').channels[3].percent === 88, 3000, 'the battery');
    // the host's receiver tile reads the standard keys: power on the card, which also shows the battery
    await waitFor(() => latest(stream, 'transmitterInfo')?.channels?.[3]?.powerLevel === 10, 3000, 'transmitter power');
    await waitFor(() => stateFor(stream.records, 'meters').some((p) => p.value.channels?.[3]?.div1 === true), 4000, 'antenna A lit');
    fake.commands.loseTransmitter(3);
    await waitFor(() => latest(stream, KEYS.transmitter)?.channels?.[3]?.present === false, 3000, 'the transmitter gone');
    await waitFor(() => latest(stream, 'transmitterInfo')?.channels?.[3]?.powerLevel === 255, 3000, 'power cleared, which hides the battery');
  } finally {
    stream.close();
  }
});

test('ShowLink comes from the slots, and lets the frequency lock through on a linked channel', async () => {
  const stream = await openEvents();
  try {
    const fake = getSimulator();
    assert.equal((await command('requireShowlinkForFrequency', true)).status, 202);
    assert.equal((await command('frequency', 505, 2)).status, 409, 'nothing linked on channel 2');
    fake.commands.setSlot(2, 1, { model: 'ADX2', status: 'LINKED.ACTIVE', showLink: 4 });
    await waitFor(() => latest(stream, KEYS.showLink)?.channels?.[2]?.linked === true, 3000, 'ShowLink up');
    assert.equal(latest(stream, KEYS.showLink).channels[2].quality, 4);
    assert.equal(latest(stream, KEYS.showLink).channels[2].percent, 80, 'on the quality meter scale');
    assert.equal((await command('frequency', 505, 2)).status, 202, 'allowed with ShowLink');
    await waitFor(() => latest(stream, 'frequency')?.channels?.[2] === 505, 3000, 'retuned');
    // the notice names only the channels still held
    const held = (await deviceRow()).status.warnings?.find((w) => w.id === 'frequency-locked');
    assert.ok(held && !/channels 1, 2/.test(held.message) && /1/.test(held.message), held?.message);
    fake.commands.setSlot(2, 1, { status: 'LINKED.INACTIVE', showLink: 255 });
    await waitFor(() => latest(stream, KEYS.showLink)?.channels?.[2]?.linked === false, 3000, 'ShowLink down');
    assert.equal((await command('frequency', 506, 2)).status, 409, 'blocked again');
    assert.equal((await command('requireShowlinkForFrequency', false)).status, 202);
  } finally {
    stream.close();
  }
});

test('the channel quality the unit meters lights the link-quality meter', async () => {
  const stream = await openEvents();
  try {
    const fake = getSimulator();
    fake.commands.quality[1] = 5;
    await waitFor(() => stateFor(stream.records, 'meters').some((p) => p.value.channels?.[1]?.lqi === 100 && p.value.channels[1].qual === 5), 4000, 'a quality sample');
    // the transmitter goes: the unit reports quality unknown, and the Q row must go dark, not stay lit
    fake.commands.quality[1] = 255;
    await waitFor(() => stateFor(stream.records, 'meters').some((p) => p.value.channels?.[1]?.qual === 0), 4000, 'quality cleared');
    fake.commands.quality[1] = 0;
  } finally {
    stream.close();
  }
});

test('identify flashes the unit, or one channel, through the control port', async () => {
  const fake = getSimulator();
  fake.commands.flashes.length = 0;
  assert.equal((await command('identify', true)).status, 202);
  await waitFor(() => fake.commands.flashes.includes(null), 3000, 'the unit flash');
  assert.equal((await command('identify', true, 2)).status, 202);
  await waitFor(() => fake.commands.flashes.includes(2), 3000, 'the channel flash');
});

test('the unit\'s own alarms become device notices and card state', async () => {
  const stream = await openEvents();
  try {
    const fake = getSimulator();
    fake.commands.setStatus(1, 'INTERFERENCE_STATUS', 'DETECTED');
    await waitFor(() => latest(stream, KEYS.status)?.channels?.[1]?.interference === 'DETECTED', 3000, 'interference state');
    await waitFor(() => latest(stream, 'channelStatus')?.channels?.[1]?.rfIntDet === 'CRITICAL', 3000, 'the tile\'s interference flag');
    await waitFor(async () => (await deviceRow()).status.warnings?.some((w) => w.id === 'interference' && w.severity === 'warning'), 3000, 'the notice');
    fake.commands.setStatus(1, 'INTERFERENCE_STATUS', 'NONE');
    await waitFor(async () => !(await deviceRow()).status.warnings?.some((w) => w.id === 'interference'), 3000, 'the notice cleared');
  } finally {
    stream.close();
  }
});

test('the band is a choice from the unit\'s range, applied live', async () => {
  const stream = await openEvents();
  try {
    const band = (await deviceRow()).properties.find((p) => p.id === 'band');
    assert.deepEqual(band.value.options, ['G53', 'G54', 'G55', 'G56', 'G57', 'G57+', 'G62', 'G63', 'H54']);
    assert.equal((await command('band', 'G56')).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.band === 'G56', 3000, 'the new band');
    assert.equal((await command('band', 'Z99')).status, 400);
    assert.equal((await command('band', 'G57')).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.band === 'G57', 3000, 'the band back');
  } finally {
    stream.close();
  }
});

test('what a unit offers depends on which unit it is', () => {
  const ids = (model) => propertyDescriptors({ model }).map((p) => p.id);
  assert.ok(!ids('AD4D-A').includes('quadversity'), 'an AD4D has no Quadversity');
  assert.ok(ids('AD4Q-A').includes('quadversity'));
  const band = (model) => propertyDescriptors({ model }).find((p) => p.id === 'band');
  assert.equal(band('AD4D-A').access, 'readWrite');
  assert.equal(band('AD4Q-B').access, 'readOnly', 'a range whose bands are not listed stays read-only');
});

test('the tone generator quick toggle is -30 dB on and Off off', async () => {
  const stream = await openEvents();
  try {
    assert.equal((await command('toneGenerator', true, 2)).status, 202);
    await waitFor(() => latest(stream, KEYS.toneLevel)?.channels?.[2] === -30 && latest(stream, KEYS.toneGen)?.channels?.[2] === true, 3000, 'the tone on');
    assert.equal((await command('toneGenerator', false, 2)).status, 202);
    await waitFor(() => latest(stream, KEYS.toneLevel)?.channels?.[2] === 'Off' && latest(stream, KEYS.toneGen)?.channels?.[2] === false, 3000, 'the tone off');
    assert.equal((await command('toneGenerator', 'yes', 2)).status, 400);
  } finally {
    stream.close();
  }
});

test('the quick toggles can be turned off, and then neither the property nor its control is offered', () => {
  assert.ok(propertyDescriptors({ model: 'AD4D-A' }).some((p) => p.id === 'toneGenerator'));
  assert.ok(!propertyDescriptors({ model: 'AD4D-A', quickToggles: false }).some((p) => p.id === 'toneGenerator'));
  const controls = (nodes) => nodes.flatMap((n) => (n.type === 'group' ? controls(n.children) : n.type === 'control' ? [n.propertyId] : []));
  assert.ok(controls(layoutFor(PRODUCT).channel).includes('toneGenerator'));
  assert.ok(!controls(layoutFor(PRODUCT, { quickToggles: false }).channel).includes('toneGenerator'));
  assert.ok(controls(layoutFor(PRODUCT, { quickToggles: false }).channel).includes('mute'), 'other controls stay');
});

test('Quadversity is reported but refused as a front-panel-only setting', async () => {
  const res = await command('quadversity', true);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'read_only');
  assert.match(res.body.detail, /front panel/);
});

// --- the spectrum analyzer ------------------------------------------------------------

const scanRow = async () => (await request('GET', '/devices')).body.devices.find((d) => d.id === SIM_DEVICE_ID);
const getTrace = (sinceSweepId) => request('GET', `${DEVICE_PATH}/trace${sinceSweepId === undefined ? '' : `?sinceSweepId=${sinceSweepId}`}`);

test('the one device is a scan source too, with the unit\'s own range and two controls', async () => {
  const found = (await request('GET', '/devices')).body.devices.find((d) => d.id === SIM_DEVICE_ID);
  assert.equal(found.product, PRODUCT);
  const added = await request('POST', '/devices', { id: SIM_DEVICE_ID, product: PRODUCT, config: {} });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added.body));
  const row = await waitFor(async () => {
    const r = await scanRow();
    return r?.status.status === 'ok' ? r : null;
  }, 10_000, 'the spectrum device to open');
  const caps = row.capabilities;
  // the dialog's hard limits span every band of the range; the band in use decides the actual scan
  assert.equal(caps.minFrequencyHz, 470_000_000);
  assert.equal(caps.maxFrequencyHz, 636_000_000);
  assert.equal(caps.minStepHz, 25_000);
  assert.equal(caps.autoPointCount, true);
  const controls = Object.fromEntries(caps.controls.map((c) => [c.id, c]));
  assert.deepEqual(controls.channel.choices.map((c) => c.id), [1, 2, 3, 4]);
  assert.deepEqual(controls.antenna.choices.map((c) => c.id), ['A', 'B', 'AB']);
  assert.equal(controls.antenna.default, 'AB');
  // the dialog says what the unit can do, in the unit's own numbers
  assert.equal(controls.about.type, 'static-text');
  assert.match(controls.about.default, /In band G57 this receiver scans 470\.125 to 607\.875 MHz in 25 kHz steps/);
  assert.match(controls.about.default, /RBW, mode and offset do not apply/);
  assert.deepEqual(caps.controls.map((c) => c.id), ['channel', 'antenna', 'about']);
  // before anything is applied, the configuration in effect is the unit's whole range, so the dialog opens on it
  const cfg = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  assert.equal(cfg.body.startHz, 470_125_000);
  assert.equal(cfg.body.stopHz, 607_875_000);
  assert.equal(cfg.body.pointCount, 5511);
  assert.deepEqual(cfg.body.controls, { channel: 1, antenna: 'AB' });
});

test('a sweep is snapped to the unit\'s raster and range, and the controls come back as applied', async () => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 505_010_000,
    stopHz: 509_990_000,
    controls: { channel: 99, antenna: 'B' },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.startHz, 505_025_000);
  assert.equal(applied.body.stopHz, 509_975_000);
  assert.equal(applied.body.pointCount, 199);
  // a channel the unit does not have is clamped to the one in force, not rejected
  assert.deepEqual(applied.body.controls, { channel: 1, antenna: 'B' });
  // one antenna over 199 points; the host is told how long that takes so it does not call the unit stalled
  assert.equal(applied.body.resolved.sweepTimeMs, Math.round(199 * 21.5));
  const wide = await request('POST', `${DEVICE_PATH}/configuration`, { startHz: 100_000_000, stopHz: 900_000_000, controls: { antenna: 'AB' } });
  assert.deepEqual([wide.body.startHz, wide.body.stopHz], [470_125_000, 607_875_000]);
  assert.equal(wide.body.pointCount, 5511);
  assert.equal(wide.body.resolved.sweepTimeMs, 2 * Math.round(5511 * 21.5));
});

test('a band change moves the scan to the band\'s range, and the dialog follows', async () => {
  const stream = await openEvents();
  try {
    await request('POST', `${DEVICE_PATH}/configuration`, { startHz: 505_000_000, stopHz: 510_000_000, controls: { channel: 1, antenna: 'A' } });
    assert.equal((await command('band', 'G62')).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.band === 'G62', 3000, 'the band');
    // the host's receiver tile reads the band from deviceProperties
    await waitFor(() => latest(stream, 'deviceProperties')?.rfBand === 'G62' && latest(stream, 'deviceProperties').transmissionMode === 'STANDARD', 3000, 'the tile\'s band');
    // 505-510 lies outside G62's 510.1-529.9, so the plan becomes the whole of the new range
    const cfg = await waitFor(async () => {
      const r = await request('GET', `${DEVICE_PATH}/configuration`);
      return r.body?.startHz === 510_100_000 ? r.body : null;
    }, 4000, `the configuration to follow the band (now ${JSON.stringify((await request('GET', `${DEVICE_PATH}/configuration`)).body)}; unit ${JSON.stringify(latest(stream, KEYS.unit))})`);
    assert.equal(cfg.stopHz, 529_900_000);
    assert.equal(cfg.pointCount, 793);
    // a request inside the new band is honoured as asked
    const applied = await request('POST', `${DEVICE_PATH}/configuration`, { startHz: 515_000_000, stopHz: 516_000_000 });
    assert.deepEqual([applied.body.startHz, applied.body.stopHz], [515_000_000, 516_000_000]);
    assert.equal((await command('band', 'G57')).status, 202);
    await waitFor(() => latest(stream, KEYS.unit)?.band === 'G57', 3000, 'the band back');
    // 515-516 still fits G57, so it is kept
    await delay(500);
    const back = await request('GET', `${DEVICE_PATH}/configuration`);
    assert.deepEqual([back.body.startHz, back.body.stopHz], [515_000_000, 516_000_000]);
  } finally {
    stream.close();
  }
});

test('a sweep from both antennas is one composite trace with each antenna\'s curve beside it, and then it holds', async () => {
  const fake = getSimulator();
  fake.scans.length = 0;
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 505_000_000,
    stopHz: 510_000_000,
    controls: { channel: 1, antenna: 'AB' },
  });
  assert.equal(applied.body.pointCount, 201);
  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.ok([200, 202].includes(started.status), JSON.stringify(started.body));

  const trace = await waitFor(async () => {
    const r = await getTrace();
    return r.status === 200 && r.body?.sweepId >= 1 ? r.body : null;
  }, 15_000, 'the composite trace');
  assert.equal(trace.pointCount, 201);
  assert.equal(trace.startHz, 505_000_000);
  assert.deepEqual(trace.series.map((s) => s.name), ['A', 'B']);
  const [a, b] = trace.series.map((s) => s.amplitudesDbm);
  assert.equal(a.length, 201);
  assert.equal(b.length, 201);
  // the composite is the stronger antenna at every point
  assert.deepEqual(trace.amplitudesDbm, a.map((v, i) => Math.max(v, b[i])));
  // antenna A hears the 507.000 MHz signal (point 80) better than B does
  assert.ok(a[80] - b[80] >= 11);
  // it took one scan from each antenna, on the channel asked for
  assert.deepEqual(fake.scans.map((s) => [s.channel, s.antenna]), [[1, 'A'], [1, 'B']]);

  // and then it holds: no further scan until the next start
  await delay(400);
  assert.equal(fake.scans.length, 2);
  const stopped = await request('POST', `${DEVICE_PATH}/sweep/stop`);
  assert.ok([200, 202].includes(stopped.status));
  assert.equal((await getTrace()).body.sweepId, trace.sweepId, 'the trace stays as it was');
  assert.equal(fake.scans.length, 2);
});

test('a sweep from one antenna carries no separate curves', async () => {
  const fake = getSimulator();
  fake.scans.length = 0;
  await request('POST', `${DEVICE_PATH}/configuration`, { startHz: 505_000_000, stopHz: 506_000_000, controls: { channel: 2, antenna: 'A' } });
  const before = (await getTrace()).body?.sweepId ?? 0;
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  const trace = await waitFor(async () => {
    const r = await getTrace(before);
    return r.status === 200 && r.body?.sweepId > before ? r.body : null;
  }, 15_000, 'the single-antenna trace');
  assert.equal(trace.series, undefined);
  assert.equal(trace.pointCount, 41);
  assert.deepEqual(fake.scans.map((s) => [s.channel, s.antenna]), [[2, 'A']]);
  await request('POST', `${DEVICE_PATH}/sweep/stop`);
});

test('a restart of the unit (HD mode changed from the monitor) is ridden out by the spectrum device too', async () => {
  const fake = getSimulator();
  const restartsBefore = fake.restarts;
  assert.equal((await command('highDensityMode', true)).status, 202);
  await waitFor(() => fake.restarts === restartsBefore + 1, 4000, 'the restart');
  // the scan device says it is waiting, never reports failed, and once the unit is back it scans
  await waitFor(async () => (await scanRow())?.status.warnings?.some((w) => w.id === 'restarting'), 4000, 'the scan device to notice the restart');
  await waitFor(async () => (await scanRow())?.status.status === 'ok' && !(await scanRow()).status.warnings?.length, 12_000, 'the scan device back');
  assert.notEqual((await scanRow()).status.status, 'failed');
  await request('POST', `${DEVICE_PATH}/configuration`, { startHz: 505_000_000, stopHz: 505_500_000, controls: { channel: 1, antenna: 'A' } });
  const before = (await getTrace()).body?.sweepId ?? 0;
  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.ok([200, 202].includes(started.status), `start after restart: ${JSON.stringify(started.body)}`);
  const trace = await waitFor(async () => {
    const r = await getTrace(before);
    return r.status === 200 && r.body?.sweepId > before ? r.body : null;
  }, 15_000, `a trace after the restart (start said ${JSON.stringify(started.body)}, scans run ${JSON.stringify(fake.scans.slice(-3))}, scan state claimed=${fake.scanState.claimed} timer=${!!fake.scanState.timer} owner=${fake.scanState.owner ? fake.scanState.owner.rinfo.port : null} controllers=${[...fake.controllers.keys()].join(',')})`);
  assert.equal(trace.pointCount, 21);
  await request('POST', `${DEVICE_PATH}/sweep/stop`);
  assert.equal((await command('highDensityMode', false)).status, 202);
  await waitFor(() => fake.restarts === restartsBefore + 2, 4000, 'the restart back');
  await waitFor(async () => (await deviceRow())?.status.status === 'ok' && (await scanRow())?.status.status === 'ok' && !(await scanRow()).status.warnings?.length, 12_000, 'both devices back');
});

test('stopping a sweep in progress releases the unit', async () => {
  const fake = getSimulator();
  fake.scanChunkMs = 40;
  await request('POST', `${DEVICE_PATH}/configuration`, { startHz: 470_000_000, stopHz: 608_000_000, controls: { channel: 1, antenna: 'A' } });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  await waitFor(() => fake.scanState.timer, 5000, 'the scan to start');
  const started = Date.now();
  const stopped = await request('POST', `${DEVICE_PATH}/sweep/stop`);
  assert.ok([200, 202].includes(stopped.status));
  assert.ok(Date.now() - started < 4500, 'the stop did not wait the scan out');
  assert.equal(fake.scanState.timer, null, 'the scan was ended');
  fake.scanChunkMs = 1;
});
