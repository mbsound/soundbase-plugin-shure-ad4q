// The RF scan's description: what a scan may ask for, and how the unit's samples are read.
// Geometry comes from the unit, so planning is tested against more than one range.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTENNAS,
  SCAN_OBJ,
  configEntries,
  dataKey,
  defaultSpan,
  parseDataEvent,
  peakOf,
  planScan,
  scanDurationMs,
  statusKeys,
} from '../driver/ad4q/scan.js';

// what an AD4D-A reports of itself
const A = { startKhz: 470_125, stopKhz: 607_875, originKhz: 470_000, stepKhz: 25 };
// a unit built for the 606 MHz range: the same shape, a different origin and limits
const B = { startKhz: 606_125, stopKhz: 809_875, originKhz: 606_000, stepKhz: 25 };

test('the whole of a unit\'s range is 5511 points on an AD4D-A, from index 5 to 5515', () => {
  const plan = planScan({ limits: A, ...defaultSpan(A) });
  assert.deepEqual([plan.loIndex, plan.hiIndex, plan.points], [5, 5515, 5511]);
  assert.deepEqual([plan.startKhz, plan.stopKhz], [470_125, 607_875]);
});

test('a request is snapped inward to the unit\'s raster and held inside its range', () => {
  const plan = planScan({ limits: A, startKhz: 505_010, stopKhz: 509_990 });
  assert.deepEqual([plan.startKhz, plan.stopKhz], [505_025, 509_975]);
  // past either edge it is held to what the unit reports, whatever was asked
  const wide = planScan({ limits: A, startKhz: 100_000, stopKhz: 900_000 });
  assert.deepEqual([wide.startKhz, wide.stopKhz], [470_125, 607_875]);
});

test('nothing is left when the request lies outside the range, or is a single point', () => {
  assert.equal(planScan({ limits: A, startKhz: 620_000, stopKhz: 700_000 }), null);
  assert.equal(planScan({ limits: A, startKhz: 505_000, stopKhz: 505_000 }), null);
  assert.equal(planScan({ limits: { ...A, stepKhz: 0 }, startKhz: 500_000, stopKhz: 510_000 }), null);
});

test('a unit with a different origin counts its index from there', () => {
  const plan = planScan({ limits: B, startKhz: 700_000, stopKhz: 701_000 });
  assert.equal(plan.loIndex, (700_000 - 606_000) / 25);
  assert.equal(plan.hiIndex, (701_000 - 606_000) / 25);
  assert.equal(plan.startKhz, 700_000);
  // the declared index range is what the unit will stream back, so it must be counted from this unit's origin
  assert.equal(dataKey(0, 1, plan.loIndex, plan.hiIndex), '&RF_SCAN_DATA:RSSI/CH=0/SCAN=0/CURVE_IDX=1/FREQ_IDX=3760-3800');
});

test('a unit with a different step is planned on its own step', () => {
  const plan = planScan({ limits: { ...A, stepKhz: 50 }, startKhz: 500_000, stopKhz: 501_000 });
  assert.equal(plan.stepKhz, 50);
  assert.equal(plan.points, 21);
  assert.equal(configEntries(0, { startKhz: 500_000, stopKhz: 501_000, stepKhz: 50, antenna: 'A' })[2].value.readUInt32BE(0), 50);
});

test('keys name the zero-based channel; the trigger and release are per channel objects', () => {
  assert.equal(statusKeys(1).status, 'RF_SCAN:CURRENT_STATUS/CH=1/SCAN=0');
  assert.equal(dataKey(1, 2, 5, 20), '&RF_SCAN_DATA:RSSI/CH=1/SCAN=0/CURVE_IDX=2/FREQ_IDX=5-20');
  assert.deepEqual([SCAN_OBJ.CLAIM, SCAN_OBJ.START, SCAN_OBJ.RELEASE], [0x090f, 0x0903, 0x090e]);
  assert.deepEqual([ANTENNAS.A.select, ANTENNAS.B.select, ANTENNAS.A.curve, ANTENNAS.B.curve], [2, 4, 1, 2]);
});

test('a sample chunk from a real unit decodes to dBm', () => {
  const value = Buffer.from('002700000010' + '02' + 'fc4dfc2bfc24fc24fc19fc26fc1efc1cfc1bfc1dfc21fc24fc42fc65fc70fc79', 'hex');
  const chunk = parseDataEvent('&RF_SCAN_DATA:RSSI/CH=0/SCAN=0/CURVE_IDX=1/FREQ_IDX=5-20', value);
  assert.equal(chunk.curve, 1);
  assert.equal(chunk.lo, 5);
  assert.equal(chunk.dbm.length, 16);
  assert.deepEqual(chunk.dbm.slice(0, 3), [-94.7, -98.1, -98.8]);
});

test('a chunk whose count disagrees with its indices, or that is cut short, is not a chunk', () => {
  const value = Buffer.from('002700000010' + '02' + 'fc4d'.repeat(16), 'hex');
  assert.equal(parseDataEvent('&RF_SCAN_DATA:RSSI/CH=0/SCAN=0/CURVE_IDX=1/FREQ_IDX=5-30', value), null);
  assert.equal(parseDataEvent('&RF_SCAN_DATA:RSSI/CH=0/SCAN=0/CURVE_IDX=1/FREQ_IDX=5-20', value.subarray(0, 20)), null);
  assert.equal(parseDataEvent('RF_SCAN:CURRENT_STATUS/CH=0/SCAN=0', Buffer.from([2])), null);
});

test('the composite is the strongest antenna at each point', () => {
  assert.deepEqual(peakOf([[-90, -80, -100], [-95, -85, -70]]), [-90, -80, -70]);
  assert.deepEqual(peakOf([[-90, -80]]), [-90, -80]);
});

test('a full scan is about two minutes an antenna, from the rate seen on a real unit', () => {
  const seconds = scanDurationMs(5511) / 1000;
  assert.ok(seconds > 115 && seconds < 121, `${seconds} s`);
});
