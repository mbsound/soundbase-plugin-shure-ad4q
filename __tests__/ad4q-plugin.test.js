// Contract tests for the adapter, driven through the real shell over real
// HTTP, against the simulated AD4Q — which speaks the device's wire protocol on
// loopback, so the whole stack is under test: shell, adapter, driver, sockets,
// session.

process.env.SB_AD4Q_SIMULATE = '1';
// no SLP multicast on the test machine's real network
process.env.SB_AD4Q_NO_DISCOVERY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX, SSE_EVENTS } from '@soundbase/plugin-contract';
import { KEYS, PRODUCT, SIM_DEVICE_ID, getSimulator, resolveHost, shutdownDiscovery } from '../adapter.js';
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

test('a discovered unit is added without being asked for the address it was found at', () => {
  const address = manifest.deviceConfigFields.find((field) => field.id === 'host');
  assert.equal(address.manualOnly, true);
  assert.equal(resolveHost({ id: 'net:10.10.1.175', config: {} }), '10.10.1.175');
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
  for (const id of ['mute', 'gain', 'frequency', 'channelName', 'toneLevel', 'toneFrequency', 'diversity', 'overloadHold', 'interferenceAvoidance', 'unregisteredTx', 'rfPower', 'unlinkTransmitter', 'talkXlrNormal', 'talkDantePressed', 'deviceName', 'fanAlwaysOn', 'powerLock', 'panelLock']) {
    assert.equal(props.get(id)?.access, 'readWrite', `${id} is writable`);
  }
  // the disruptive settings are shown and deliberately not writable
  for (const id of ['encryption', 'band', 'hdMode', 'quadversity', 'antennaBias']) {
    assert.equal(props.get(id)?.access, 'readOnly', `${id} is read-only`);
  }
  // every control the layout offers is a property the device returned
  for (const node of device.layout.channel.filter((n) => n.type === 'control')) {
    assert.ok(props.has(node.propertyId), `the layout offers ${node.propertyId}, which the device does not describe`);
  }

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
  assert.equal(latest(stream, KEYS.unit).model, 'AD4Q-C');
  assert.equal(latest(stream, KEYS.unit).band, 'G57');

  // the live level arrives as the contract's `meters` reading
  const meters = await waitFor(() => stateFor(stream.records, 'meters').at(-1), 3000, 'meters');
  assert.equal(meters.scope, 'device');
  assert.equal(typeof meters.value.timestamp, 'number');
  assert.equal(typeof Object.values(meters.value.channels)[0].rf1, 'number');
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

  assert.equal((await command('diversity', 'combining', 3)).status, 202);
  await waitFor(() => latest(stream, KEYS.diversity)?.channels?.[3] === 'Combining', 3000, 'diversity');

  assert.equal((await command('toneLevel', 'Off', 2)).status, 202);
  await waitFor(() => latest(stream, KEYS.toneLevel)?.channels?.[2] === 'Off', 3000, 'the tone to turn off');

  assert.equal((await command('fanAlwaysOn', true)).status, 202);
  await waitFor(() => latest(stream, KEYS.unit)?.fanAlwaysOn === true, 3000, 'fan mode');
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
  await bad('diversity', 'sideways', 1, 'bad_value');
  await bad('mute', 'yes', 1, 'bad_value');
  await bad('mute', true, undefined, 'unknown_channel');
  await bad('mute', true, 9, 'unknown_channel');
  await bad('rfPower', 'Turbo', 1, 'bad_value');
  await bad('talkXlrNormal', 'yes', 1, 'bad_value');
  await bad('unlinkTransmitter', 'Slot 9', 1, 'bad_value');
  await bad('encryption', 'On', 1, 'read_only');
  await bad('hdMode', true, undefined, 'read_only');
  await bad('antennaBias', true, undefined, 'read_only');
  await bad('toneVolume', 3, 1, 'unknown_property');
});

test('the talk switch routes each output on its own, leaving the others as they were', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();
  assert.equal((await command('talkDanteNormal', false, 1)).status, 202);
  await waitFor(() => latest(stream, KEYS.talk)?.channels?.[1]?.danteNormal === false, 3000, 'Dante (normal) off');
  assert.equal((await command('talkXlrPressed', false, 1)).status, 202);
  await waitFor(() => latest(stream, KEYS.talk)?.channels?.[1]?.xlrPressed === false, 3000, 'XLR (pressed) off');
  const routing = latest(stream, KEYS.talk).channels[1];
  assert.equal(routing.danteNormal, false);
  assert.equal(routing.xlrNormal, true, 'an output left alone is still on');
  // a set bit means OFF: bit 3 (Dante, normal) and bit 4 (XLR, pressed)
  assert.equal(fake.store.get(chanAddr(1, CH.TALK_ROUTING)).value[0], 0b0001_1000);
  assert.equal((await command('talkDanteNormal', true, 1)).status, 202);
  await waitFor(() => latest(stream, KEYS.talk)?.channels?.[1]?.danteNormal === true, 3000, 'Dante (normal) back on');
  assert.equal(fake.store.get(chanAddr(1, CH.TALK_ROUTING)).value[0], 0b0001_0000);
});

test('the IR preset\'s RF power is writable', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  assert.equal((await command('rfPower', 'High', 3)).status, 202);
  await waitFor(() => latest(stream, KEYS.rfPower)?.channels?.[3] === 'High', 3000, 'RF power High');
  assert.equal(getSimulator().store.get(chanAddr(3, CH.RF_POWER)).value[0], 2);
  assert.equal((await command('rfPower', 'no change', 3)).status, 202);
  await waitFor(() => latest(stream, KEYS.rfPower)?.channels?.[3] === 'No change', 3000, 'RF power left to the transmitter');
  assert.equal(getSimulator().store.get(chanAddr(3, CH.RF_POWER)).value[0], 0xff);
});

test('a transmitter syncing in is reported, and leaving clears it', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const fake = getSimulator();
  fake.syncTransmitter(2, 1, { model: 'ADX2', serial: '0048ba2e', battery: 87 });
  await waitFor(() => latest(stream, KEYS.transmitter)?.channels?.[2]?.present === true, 3000, 'the transmitter');
  assert.deepEqual(latest(stream, KEYS.transmitter).channels[2], { present: true, model: 'ADX2', serial: '0048ba2e' });
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
