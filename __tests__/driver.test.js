// The driver against the simulated AD4Q, over real UDP on loopback: the
// session, the DMP association, reads, committed writes and read-back.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { Ad4qDevice, WriteRefused } from '../driver/ad4q/device.js';
import { SlpBrowser } from '../driver/acn/slp.js';
import { AcnSession } from '../driver/acn/session.js';
import { FakeAd4q } from '../driver/fake/fake-ad4q.js';
import { CH, chanAddr, decodeUint } from '../driver/ad4q/properties.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connected(t, overrides = {}) {
  const fake = new FakeAd4q();
  await fake.listen();
  const device = new Ad4qDevice({
    host: '127.0.0.1',
    port: fake.controlPort,
    cid: fake.cid.toString('hex'),
    localIp: '127.0.0.1',
    advert: false,
    timings: { sendGapMs: 2, connectTimeoutMs: 4000 },
    requestTimeoutMs: 800,
    ...overrides,
  });
  t.after(async () => {
    await device.close();
    await fake.stop();
  });
  await device.connect();
  return { fake, device };
}

test('a session joins in both directions and associates DMP protocol 2', async (t) => {
  const { fake, device } = await connected(t);
  assert.equal(device.connected, true);
  assert.equal(fake.joins, 1);
  assert.equal(fake.declared, true);
});

test('every modelled property is read, for the device and all four channels', async (t) => {
  const { device } = await connected(t);
  const all = await device.readAll();
  assert.equal(all.device.model, 'AD4Q-C');
  assert.equal(all.device.serial, 'SIM000001');
  assert.deepEqual(Object.keys(all.channels), ['1', '2', '3', '4']);
  const one = all.channels[1];
  assert.equal(one.name, 'Channel1');
  assert.equal(one.gainDb, 0);
  assert.equal(one.muted, false);
  assert.equal(one.toneFreqHz, 400);
  assert.equal(one.toneLevelDb, -128);
  assert.equal(one.diversity, 'Selection');
  assert.equal(one.interferenceAvoidance, 'Manual');
  assert.equal(one.unregisteredTx, 'Warn');
  assert.equal(one.rfPower, 'Normal');
  assert.equal(one.frequencyMhz, 495);
});

test('a write goes out with its commit PDU and is read back from the unit', async (t) => {
  const { fake, device } = await connected(t);
  assert.equal(await device.setChannel(2, 'toneLevelDb', -24), -24);
  assert.equal(await device.setChannel(2, 'toneFreqHz', 1000), 1000);
  assert.equal(await device.setChannel(1, 'muted', true), true);
  assert.equal(await device.setChannel(3, 'name', 'Lead'), 'Lead');
  assert.equal(await device.setChannel(4, 'frequencyMhz', 512.5), 512.5);
  assert.equal(await device.setChannel(1, 'diversity', 'Combining'), 'Combining');
  assert.equal(await device.setDevice('fanAlwaysOn', true), true);
  assert.equal(fake.writes.length, 7);
  assert.ok(fake.writes.every((w) => w.committed), 'every SET carried the commit PDU');
  // what the unit holds is what was asked for, byte for byte
  assert.equal(fake.store.get(chanAddr(2, CH.TONE_LEVEL_DB)).value[0], 0xe8); // -24 dB as a signed byte
  assert.equal(decodeUint(fake.store.get(chanAddr(4, CH.FREQ_KHZ)).value), 512_500);
});

test('the tone generator turns off with the unit\'s "off" level', async (t) => {
  const { fake, device } = await connected(t);
  await device.setChannel(1, 'toneLevelDb', -12);
  assert.equal(await device.setChannel(1, 'toneLevelDb', null), -128);
  assert.equal(fake.store.get(chanAddr(1, CH.TONE_LEVEL_DB)).value[0], 0x80);
});

test('a value the unit rejects raises WriteRefused and leaves the setting alone', async (t) => {
  const { fake, device } = await connected(t);
  await assert.rejects(() => device.setChannel(1, 'gainDb', 99), (err) => {
    assert.ok(err instanceof WriteRefused);
    assert.equal(err.reason, 5);
    return true;
  });
  assert.equal(fake.store.get(chanAddr(1, CH.GAIN_DB)).value[0], 0);
  assert.equal(await device.setChannel(1, 'gainDb', 12), 12, 'the session is still good after a refusal');
});

test('a property the unit does not have is a failed read, not a hang', async (t) => {
  const { device } = await connected(t);
  await assert.rejects(() => device.get(0x0200ffff), /no value/);
});

test('changes the unit pushes arrive as events once subscribed', async (t) => {
  const { fake, device } = await connected(t);
  const seen = [];
  device.on('prop', (p) => seen.push(p));
  await device.subscribeAll();
  await delay(50);
  fake.setLocal(chanAddr(3, CH.MUTE), Buffer.from([1]));
  fake.setLocal(chanAddr(3, CH.GAIN_DB), Buffer.from([0xf6])); // -10
  await delay(150);
  assert.ok(seen.some((p) => p.channel === 3 && p.key === 'muted' && p.value === true));
  assert.ok(seen.some((p) => p.channel === 3 && p.key === 'gainDb' && p.value === -10));
  assert.ok(seen.some((p) => p.key === 'levelDb'), 'the live level streams');
});

test('a unit that goes quiet is reported as lost rather than waited on forever', async (t) => {
  const { fake, device } = await connected(t, {
    requestTimeoutMs: 100,
    timings: { sendGapMs: 2, connectTimeoutMs: 4000, sendTimeoutMs: 150 },
  });
  const lost = new Promise((resolve) => device.once('lost', resolve));
  await fake.stop();
  const pending = [];
  for (let i = 0; i < 7; i += 1) pending.push(device.get(chanAddr(1, CH.NAME)).catch(() => {}));
  await Promise.all(pending);
  assert.match((await lost).message, /stopped answering/);
});

test('a session that is refused or never answered fails to open with a reason', async () => {
  const session = new AcnSession({
    host: '127.0.0.1',
    port: 9, // nothing there
    deviceCid: Buffer.alloc(16, 1),
    localIp: '127.0.0.1',
    advert: false,
    timings: { connectTimeoutMs: 150 },
  });
  session.on('error', () => {});
  await assert.rejects(() => session.connect(), /did not complete the session/);
  await session.close();
});

test('closing is idempotent and ends the session', async (t) => {
  const { device } = await connected(t);
  await device.close();
  await device.close();
  assert.equal(device.connected, false);
});

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('a unit is found from its SLP advert and then opened from its address alone', async (t) => {
  const slpPort = await freeUdpPort();
  const fake = new FakeAd4q({ slpPort });
  await fake.listen();
  const browser = new SlpBrowser({ port: slpPort, multicast: false, filter: (u) => /^AD4Q/i.test(u.fctn) });
  t.after(async () => {
    browser.stop();
    await fake.stop();
  });
  const unit = await browser.find('127.0.0.1', 3000);
  assert.equal(unit.fctn, 'AD4Q_RX');
  assert.equal(unit.cid, fake.cid.toString('hex'));
  assert.equal(unit.port, fake.controlPort);

  // no component id given: the device learns it from the browse
  const device = new Ad4qDevice({
    host: '127.0.0.1',
    browser,
    localIp: '127.0.0.1',
    advert: false,
    timings: { sendGapMs: 2, connectTimeoutMs: 4000 },
  });
  t.after(() => device.close());
  await device.connect();
  assert.equal((await device.readAll()).device.model, 'AD4Q-C');
});

test('a unit nothing advertises is reported by address, not left to time out silently', async () => {
  const browser = new SlpBrowser({ port: await freeUdpPort(), multicast: false });
  const device = new Ad4qDevice({ host: '127.0.0.1', browser: { find: () => browser.find('127.0.0.1', 200) } });
  await assert.rejects(() => device.connect(), /no AD4Q is advertising at 127\.0\.0\.1/);
  browser.stop();
});

test('the talk switch changes one output without disturbing the rest', async (t) => {
  const { fake, device } = await connected(t);
  assert.equal(await device.setTalkOutput(1, 'aes3Pressed', false), false);
  assert.equal(await device.setTalkOutput(1, 'trsNormal', false), false);
  assert.equal(fake.store.get(chanAddr(1, CH.TALK_ROUTING)).value[0], 0b0100_0010);
  assert.equal(await device.setTalkOutput(1, 'aes3Pressed', true), true);
  assert.equal(fake.store.get(chanAddr(1, CH.TALK_ROUTING)).value[0], 0b0000_0010);
  await assert.rejects(() => device.setTalkOutput(1, 'hdmi', true), /not a talk-switch output/);
});

test('the IR preset RF power writes, including leaving it to the transmitter', async (t) => {
  const { fake, device } = await connected(t);
  assert.equal(await device.setChannel(2, 'rfPower', 'Low'), 'Low');
  assert.equal(await device.setChannel(2, 'rfPower', 'High'), 'High');
  assert.equal(await device.setChannel(2, 'rfPower', 'No change'), 'No change');
  assert.equal(fake.store.get(chanAddr(2, CH.RF_POWER)).value[0], 0xff);
});

test('the transmitter bank reads as absent until one is synced, and the roster flashes', async (t) => {
  const { fake, device } = await connected(t);
  const seen = [];
  device.on('prop', (p) => seen.push(p));
  assert.deepEqual(
    (await device.readAll()).channels[1],
    { ...(await device.readAll()).channels[1], txModel: null, txSerial: null, txBattery: null }
  );
  await device.subscribeAll();
  await delay(50);
  fake.syncTransmitter(1, 3, { model: 'AD3', serial: '00aabbcc', battery: 64 });
  await delay(150);
  assert.ok(seen.some((p) => p.channel === 1 && p.key === 'txModel' && p.value === 'AD3'));
  assert.ok(seen.some((p) => p.channel === 1 && p.key === 'txBattery' && p.value === 64));
  assert.ok(seen.some((p) => p.key === 'rosterId' && p.value?.slot === 3 && p.value.serial === 'aabbcc'));
  assert.ok(seen.some((p) => p.key === 'rosterGuid' && p.value?.slot === 3 && p.value.model === 'AD3'));
  await device.unlinkSlot(1, 3);
  assert.deepEqual([...fake.writes.at(-1).value], new Array(16).fill(0));
  await assert.rejects(() => device.unlinkSlot(1, 9), RangeError);
});
