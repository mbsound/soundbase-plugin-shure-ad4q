// The driver against the simulated AD4Q, over real UDP on loopback: the
// session, the DMP association, reads, committed writes and read-back.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { Ad4qDevice, ScanAborted, WriteRefused } from '../driver/ad4q/device.js';
import { SlpBrowser } from '../driver/acn/slp.js';
import { AcnSession } from '../driver/acn/session.js';
import { FakeAd4q } from '../driver/fake/fake-ad4q.js';
import { CH, chanAddr, channelsFor, decodeUint, isReceiverAdvert, modelOf } from '../driver/ad4q/properties.js';
import { DMP, strBatch } from '../driver/acn/pdu.js';
import { SCAN_OBJ, configEntries, planScan } from '../driver/ad4q/scan.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connected(t, overrides = {}, fakeOptions = {}) {
  const fake = new FakeAd4q(fakeOptions);
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
  assert.equal(all.device.model, 'AD4Q-A');
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
  // the three live meters stream: RF at each antenna in dBm (tenths on the wire), and audio
  const rfA = seen.find((p) => p.key === 'rfADbm');
  const rfB = seen.find((p) => p.key === 'rfBDbm');
  const audio = seen.find((p) => p.key === 'audioDb');
  assert.ok(rfA && rfB && audio, 'the live meters stream');
  assert.ok(rfA.value <= -70 && rfA.value >= -115 && Number.isInteger(rfA.value * 10), `rf A ${rfA.value} dBm`);
  assert.ok(rfB.value < rfA.value, 'the fake hears antenna B a little weaker');
  assert.equal(audio.value, -115, 'audio sits at the silence floor');
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
  assert.equal((await device.readAll()).device.model, 'AD4Q-A');
});

test('an AD4D is read for its two channels and no more', async (t) => {
  const { fake, device } = await connected(t, { channels: 2 }, { model: 'AD4D' });
  assert.equal(fake.channels, 2);
  const all = await device.readAll();
  assert.equal(all.device.model, 'AD4D-A');
  assert.deepEqual(Object.keys(all.channels), ['1', '2']);
  // nothing was asked of channels 3 and 4, which the unit would never answer
  assert.equal(device.timeouts, 0);
});

test('a write to an AD4D, which answers a SET without echoing it, is confirmed by the read-back', async (t) => {
  const { fake, device } = await connected(t, { channels: 2 }, { model: 'AD4D' });
  assert.equal(fake.echoSets, false);
  // the unit answers the commit with a reply that names no address; that must not be waited out
  const started = Date.now();
  assert.equal(await device.setChannel(1, 'name', 'Test1'), 'Test1');
  assert.ok(Date.now() - started < 700, 'the write finished without waiting for a timeout');
  assert.equal(fake.writes.at(-1).committed, true);
  assert.equal((await device.readAll()).channels[1].name, 'Test1');
  // a refused value is still a refusal, not a silent success
  await assert.rejects(() => device.setChannel(1, 'gainDb', 99), WriteRefused);
});

test('the channel count is learned from the advert when the caller does not give it', async (t) => {
  const slpPort = await freeUdpPort();
  const fake = new FakeAd4q({ slpPort, model: 'AD4D' });
  await fake.listen();
  const browser = new SlpBrowser({ port: slpPort, multicast: false, filter: isReceiverAdvert });
  t.after(async () => {
    browser.stop();
    await fake.stop();
  });
  const unit = await browser.find('127.0.0.1', 3000);
  assert.equal(unit.fctn, 'AD4D_RX');

  const device = new Ad4qDevice({
    host: '127.0.0.1',
    browser,
    localIp: '127.0.0.1',
    advert: false,
    timings: { sendGapMs: 2, connectTimeoutMs: 4000 },
  });
  t.after(() => device.close());
  assert.equal(device.channels, 4, 'before it has found the unit, the largest receiver is assumed');
  await device.connect();
  assert.equal(device.channels, 2);
  assert.deepEqual(Object.keys((await device.readAll()).channels), ['1', '2']);
});

test('model and channel count come from the function tag a unit advertises', () => {
  assert.equal(modelOf('AD4D_RX'), 'AD4D');
  assert.equal(modelOf('ad4q_rx'), 'AD4Q');
  assert.equal(modelOf('ULXD4_RX'), null);
  assert.equal(modelOf(undefined), null);
  assert.equal(isReceiverAdvert({ fctn: 'AD4D_RX' }), true);
  assert.equal(isReceiverAdvert({ fctn: 'QLXD4' }), false);
  assert.equal(channelsFor('AD4D'), 2);
  assert.equal(channelsFor('AD4Q'), 4);
  assert.equal(channelsFor('something-new'), 4);
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

test('HD mode is written and read back, then the unit restarts and the session is reported lost', async (t) => {
  const { fake, device } = await connected(t, {}, { restartMs: 300 });
  const lost = new Promise((resolve) => device.once('lost', resolve));
  assert.equal(await device.setDevice('hdMode', true), true);
  await lost;
  assert.equal(fake.restarts, 1);
  await device.close();
  assert.equal(device.connected, false);
  // once it is back, a fresh session finds the setting kept
  await delay(400);
  const again = new Ad4qDevice({ host: '127.0.0.1', port: fake.controlPort, cid: fake.cid.toString('hex'), localIp: '127.0.0.1', advert: false, timings: { sendGapMs: 2, connectTimeoutMs: 4000 }, requestTimeoutMs: 800 });
  t.after(() => again.close());
  await again.connect();
  assert.equal((await again.readAll()).device.hdMode, true);
});

// --- the RF scan --------------------------------------------------------------------

const expectedLevels = (fake, plan, antenna) =>
  Array.from({ length: plan.points }, (_, i) => Math.round(fake.scanLevelDbm(plan.startKhz + i * plan.stepKhz, antenna) * 10) / 10);

test('a band change moves the scan limits, and the unit pushes them', async (t) => {
  const { device } = await connected(t);
  await device.subscribeAll();
  const pushed = [];
  device.on('prop', (p) => ['band', 'scanStartKhz', 'scanStopKhz'].includes(p.key) && pushed.push(`${p.key}=${p.value}`));
  assert.equal(await device.setDevice('band', 'G62'), 'G62');
  await delay(150);
  assert.deepEqual((await device.scanLimits()), { startKhz: 510_100, stopKhz: 529_900, originKhz: 470_000, stepKhz: 25 });
  assert.ok(pushed.includes('scanStartKhz=510100') && pushed.includes('scanStopKhz=529900'), pushed.join(' '));
  await device.setDevice('band', 'G57');
});

test('a unit reports its own scan range, origin and step', async (t) => {
  const { device } = await connected(t, {}, { scan: { originKhz: 606_000, startKhz: 606_125, stopKhz: 809_875 } });
  assert.deepEqual(await device.scanLimits(), { startKhz: 606_125, stopKhz: 809_875, originKhz: 606_000, stepKhz: 25 });
});

test('a scan returns one level per point, at the frequency each belongs to', async (t) => {
  const { fake, device } = await connected(t, { channels: 2 }, { model: 'AD4D' });
  const limits = await device.scanLimits();
  const plan = planScan({ limits, startKhz: 505_000, stopKhz: 510_000 });
  const progress = [];
  const a = await device.scan({ channel: 1, antenna: 'A', plan, onProgress: (f) => progress.push(f) });
  assert.equal(a.length, 201);
  assert.deepEqual(a, expectedLevels(fake, plan, 'A'));
  // the strong signal at 507.000 MHz is point 80, and is 12 dB stronger to antenna A than to B
  assert.equal(a.indexOf(Math.max(...a)), 80);
  const b = await device.scan({ channel: 2, antenna: 'B', plan });
  assert.deepEqual(b, expectedLevels(fake, plan, 'B'));
  assert.ok(a[80] - b[80] >= 11);
  assert.deepEqual(fake.scans.map((s) => [s.channel, s.antenna]), [[1, 'A'], [2, 'B']]);
  assert.ok(progress.length > 1 && progress.at(-1) === 1, 'progress reaches 100%');
});

test('a unit whose range starts elsewhere is scanned by its own index', async (t) => {
  const geometry = { originKhz: 606_000, startKhz: 606_125, stopKhz: 809_875 };
  const { fake, device } = await connected(t, {}, { scan: geometry });
  const limits = await device.scanLimits();
  const plan = planScan({ limits, startKhz: 700_000, stopKhz: 700_500 });
  assert.equal(plan.loIndex, 3760);
  assert.deepEqual(await device.scan({ channel: 1, antenna: 'A', plan }), expectedLevels(fake, plan, 'A'));
});

test('the unit refuses the scan\'s configuration until the claim has been read', async (t) => {
  const { device } = await connected(t);
  const refused = [];
  device.on('string', (e) => e.vector === DMP.SET_FAIL && refused.push(e.value[0]));
  const config = strBatch(DMP.SET, configEntries(0, { startKhz: 505_000, stopKhz: 506_000, antenna: 'A' }));
  await device.session.send(config);
  await delay(250);
  assert.deepEqual(refused, [1, 1, 1, 1, 1, 1]);
  refused.length = 0;
  await device.get(chanAddr(1, SCAN_OBJ.CLAIM));
  await device.session.send(config);
  await delay(250);
  assert.deepEqual(refused, []);
});

test('stopping a scan releases the unit at once, and the next scan runs', async (t) => {
  const { fake, device } = await connected(t, {}, { scanChunkMs: 40 });
  const limits = await device.scanLimits();
  const whole = planScan({ limits, startKhz: limits.startKhz, stopKhz: limits.stopKhz });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 250);
  const started = Date.now();
  await assert.rejects(() => device.scan({ channel: 1, antenna: 'A', plan: whole, signal: stop.signal }), ScanAborted);
  assert.ok(Date.now() - started < 3000, 'did not wait out the scan');
  assert.equal(fake.scanState.timer, null, 'the unit was released');
  const small = planScan({ limits, startKhz: 505_000, stopKhz: 506_000 });
  assert.equal((await device.scan({ channel: 1, antenna: 'A', plan: small })).length, small.points);
});

test('several scans in one session each run, as the composite needs', async (t) => {
  const { fake, device } = await connected(t, { channels: 2 }, { model: 'AD4D' });
  const limits = await device.scanLimits();
  const plan = planScan({ limits, startKhz: 505_000, stopKhz: 506_000 });
  for (const antenna of ['A', 'B', 'A']) assert.equal((await device.scan({ channel: 1, antenna, plan })).length, plan.points);
  assert.deepEqual(fake.scans.map((s) => s.antenna), ['A', 'B', 'A']);
  // the driver never unsubscribes the scan keys: a real unit then ignores every later scan
  assert.equal(fake.scanState.poisoned, false);
});

test('a scan after a scan key was unsubscribed is ignored by the unit, and reported', async (t) => {
  const { device } = await connected(t, {}, { scanChunkMs: 1 });
  const limits = await device.scanLimits();
  const plan = planScan({ limits, startKhz: 505_000, stopKhz: 505_500 });
  await device.scan({ channel: 1, antenna: 'A', plan });
  await device.session.send(strBatch(DMP.UNSUBSCRIBE, [{ key: 'RF_SCAN:CURRENT_STATUS/CH=0/SCAN=0' }]));
  device.scanTimeoutMs = 400;
  await assert.rejects(() => device.scan({ channel: 1, antenna: 'A', plan }), /did not finish the scan/);
});

test('a channel being scanned by another session is refused, and says so', async (t) => {
  const { fake, device: a } = await connected(t, {}, { scanChunkMs: 40 });
  const b = new Ad4qDevice({ host: '127.0.0.1', port: fake.controlPort, cid: fake.cid.toString('hex'), localIp: '127.0.0.1', advert: false, timings: { sendGapMs: 2, connectTimeoutMs: 4000 }, requestTimeoutMs: 800 });
  t.after(() => b.close());
  await b.connect();
  const limits = await a.scanLimits();
  const whole = planScan({ limits, startKhz: limits.startKhz, stopKhz: limits.stopKhz });
  const stop = new AbortController();
  const running = a.scan({ channel: 1, antenna: 'A', plan: whole, signal: stop.signal }).catch(() => {});
  await delay(200);
  b.scanTimeoutMs = 1500;
  await assert.rejects(() => b.scan({ channel: 1, antenna: 'B', plan: planScan({ limits, startKhz: 505_000, stopKhz: 505_500 }) }), /already being scanned by another controller/);
  stop.abort();
  await running;
  await delay(100);
  assert.equal((await b.scan({ channel: 1, antenna: 'B', plan: planScan({ limits, startKhz: 505_000, stopKhz: 505_500 }) })).length, 21, 'free again once released');
});

test('a second scan on the same session cannot start while one is running', async (t) => {
  const { device } = await connected(t, {}, { scanChunkMs: 20 });
  const limits = await device.scanLimits();
  const plan = planScan({ limits, startKhz: 505_000, stopKhz: 508_000 });
  const first = device.scan({ channel: 1, antenna: 'A', plan });
  await assert.rejects(() => device.scan({ channel: 1, antenna: 'B', plan }), /already running/);
  assert.equal((await first).length, plan.points);
});
