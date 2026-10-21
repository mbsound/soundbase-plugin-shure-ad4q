// The command-strings client against the simulated unit's TCP side, and the decoders, pinned to the
// shapes Shure's AD4 reference documents (and a real AD4D answered with).

import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandClient, TX_PROPS, decodeShowLink, decodeTransmitter, parseReport, splitFrames } from '../driver/cmdstrings/client.js';
import { FakeCommandServer } from '../driver/fake/fake-commands.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connected(t, options = {}) {
  const fake = new FakeCommandServer(options);
  await fake.listen();
  const client = new CommandClient({ host: '127.0.0.1', port: fake.port });
  t.after(async () => {
    await client.close();
    await fake.stop();
  });
  await client.connect();
  return { fake, client };
}

test('reports parse as the reference writes them, padded strings trimmed', () => {
  assert.deepEqual(parseReport('< REP MODEL {AD4D-A                          } >'), { channel: null, prop: 'MODEL', args: ['AD4D-A'] });
  assert.deepEqual(parseReport('< REP 1 FREQUENCY 0470175 >'), { channel: 1, prop: 'FREQUENCY', args: ['0470175'] });
  assert.deepEqual(parseReport('< REP 1 SLOT_SHOWLINK_STATUS 2 005 >'), { channel: 1, prop: 'SLOT_SHOWLINK_STATUS', args: ['2', '005'] });
  assert.deepEqual(parseReport('< REP 1 TX_DEVICE_ID {LeadVox                        } >'), { channel: 1, prop: 'TX_DEVICE_ID', args: ['LeadVox'] });
  assert.deepEqual(parseReport('< REP ERR >'), { channel: null, prop: 'ERR', args: [] });
  assert.equal(parseReport('< GET 1 TX_MODEL >'), null);
});

test('a stream is split into frames, a partial one kept for the next chunk', () => {
  const { frames, rest } = splitFrames('< REP 1 TX_MODEL AD2 >< REP 1 TX_BATT_BARS 004 >< REP 1 TX_');
  assert.deepEqual(frames, ['< REP 1 TX_MODEL AD2 >', '< REP 1 TX_BATT_BARS 004 >']);
  assert.equal(rest, '< REP 1 TX_');
});

test('device, channel and slot reads come back decoded', async (t) => {
  const { client } = await connected(t, { model: 'AD4D-A', channels: 2 });
  assert.equal(await client.get('MODEL'), 'AD4D-A');
  assert.deepEqual(await client.getChannel(1, 'TX_MODEL'), ['UNKNOWN']);
  const slots = await client.getSlots(1, 'SLOT_STATUS');
  assert.deepEqual(Object.keys(slots).length, 8);
  assert.equal(slots[3], 'EMPTY');
});

test('what the unit reports on its own arrives as events', async (t) => {
  const { fake, client } = await connected(t);
  const reps = [];
  client.on('rep', (r) => reps.push(r));
  fake.receiveTransmitter(2, { model: 'ADX2', deviceId: 'LeadVox', batteryPercent: 88 });
  await delay(100);
  const values = Object.fromEntries(reps.filter((r) => r.channel === 2).map((r) => [r.prop, r.args[0]]));
  const tx = decodeTransmitter(values);
  assert.equal(tx.present, true);
  assert.equal(tx.model, 'ADX2');
  assert.equal(tx.deviceId, 'LeadVox');
  assert.equal(tx.batteryPercent, 88);
  assert.equal(tx.batteryMinutes, 125);
  assert.equal(tx.powerMw, 10);
  assert.equal(tx.muteMode, 'ON');
});

test('the transmitter decoder treats the reference\'s unknown values as absent', () => {
  const none = decodeTransmitter({ TX_MODEL: 'UNKNOWN', TX_DEVICE_ID: '', TX_BATT_CHARGE_PERCENT: '255', TX_BATT_MINS: '65535', TX_POWER_LEVEL: '255', TX_MUTE_MODE_STATUS: 'UNKNOWN', TX_TALK_SWITCH: 'UNKNOWN' });
  assert.equal(none.present, false);
  assert.equal(none.batteryPercent, null);
  assert.equal(none.batteryMinutes, null);
  assert.equal(none.talkSwitch, null);
  // "calculating" and "communication warning" are not runtimes
  assert.equal(decodeTransmitter({ TX_BATT_MINS: '65534' }).batteryMinutes, null);
  assert.equal(decodeTransmitter({ TX_TALK_SWITCH: 'ON' }).talkSwitch, true);
  assert.equal(TX_PROPS.length, 10);
});

test('ShowLink is linked when a registered ADX is online, with the best link quality', () => {
  const empty = decodeShowLink({ 1: 'EMPTY', 2: 'EMPTY' }, { 1: '255', 2: '255' });
  assert.deepEqual(empty, { linked: false, activeSlots: [], quality: null, registered: 0 });
  const standard = decodeShowLink({ 1: 'STANDARD', 2: 'LINKED.INACTIVE' }, { 1: '255', 2: '255' });
  assert.equal(standard.linked, false);
  assert.equal(standard.registered, 2);
  const live = decodeShowLink({ 1: 'STANDARD', 2: 'LINKED.ACTIVE', 3: 'LINKED.ACTIVE' }, { 2: '003', 3: '005' });
  assert.deepEqual(live, { linked: true, activeSlots: [2, 3], quality: 5, registered: 3 });
});

test('a SAMPLE line carries the channel quality, and metering is switched on and off', async (t) => {
  const { fake, client } = await connected(t);
  assert.deepEqual(parseReport('< SAMPLE 1 ALL 005 031 102 102 BB 31 086 31 065 >'), { channel: 1, prop: 'SAMPLE', args: [], sample: { quality: 5, antennas: [true, true] } });
  assert.deepEqual(parseReport('< SAMPLE 1 ALL 005 031 102 102 XR 31 086 31 065 >').sample.antennas, [null, false]);
  assert.equal(parseReport('< SAMPLE 2 ALL 255 000 000 000 XX 00 000 00 000 >').sample.quality, null);
  fake.quality[1] = 4;
  const samples = [];
  client.on('rep', (r) => r.prop === 'SAMPLE' && samples.push(r));
  assert.equal(await client.setMeterRate(1, 100), 100);
  await delay(350);
  assert.ok(samples.length >= 2 && samples.every((s) => s.channel === 1 && s.sample.quality === 4), JSON.stringify(samples));
  assert.equal(await client.setMeterRate(1, 0), 0);
  const n = samples.length;
  await delay(250);
  assert.equal(samples.length, n, 'no more samples once off');
});

test('a dropped connection rejects what was waiting and is reported', async (t) => {
  const { fake, client } = await connected(t);
  const lost = new Promise((resolve) => client.once('lost', resolve));
  await fake.stop();
  await lost;
  assert.equal(client.connected, false);
  await assert.rejects(() => client.get('MODEL'), /not open/);
});
