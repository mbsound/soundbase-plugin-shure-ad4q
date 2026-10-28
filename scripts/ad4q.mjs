#!/usr/bin/env node
// Talk to a real AD4Q through the plugin's own driver, with SoundBase nowhere
// in the picture. The thing to reach for in the first hour with real hardware.
//
//   npm run ad4q -- discover                       who answers on this network?
//   npm run ad4q -- status  <ip>                   every modelled setting
//   npm run ad4q -- watch   <ip>                   print what the unit pushes
//   npm run ad4q -- tone    <ip> <ch> <dB|off> [hz]
//   npm run ad4q -- mute    <ip> <ch> <on|off>
//   npm run ad4q -- gain    <ip> <ch> <dB>
//   npm run ad4q -- freq    <ip> <ch> <MHz>        retuning drops the RF link
//   npm run ad4q -- name    <ip> <ch> <text>
//   npm run ad4q -- scan    <ip> <ch> <A|B> [startMHz stopMHz] [--out file.json]   about 21 ms a point
//
// Every write is read back and reported CONFIRMED or NOT APPLIED, because a SET
// the unit silently ignores looks the same as one that worked.

import { Ad4qDevice, WriteRefused } from '../driver/ad4q/device.js';
import { SlpBrowser } from '../driver/acn/slp.js';
import { isIpv4 } from '../driver/netutil.js';
import { writeFileSync } from 'node:fs';
import { CHANNEL_COUNT, DEV, decodeString, isReceiverAdvert } from '../driver/ad4q/properties.js';
import { defaultSpan, planScan, scanDurationMs } from '../driver/ad4q/scan.js';

const [command, ...args] = process.argv.slice(2);
const log = (level, message) => level !== 'info' && console.error(`[${level}] ${message}`);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// narrowed to the unit's own channel count once it has connected (an AD4D has two)
let channelLimit = CHANNEL_COUNT;
const channelArg = (text) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > channelLimit) fail(`channel must be 1..${channelLimit}`);
  return n;
};
const hostArg = (text) => {
  if (!isIpv4(text)) fail('give the unit\'s IPv4 address');
  return text;
};

async function connect(host) {
  const browser = new SlpBrowser({ filter: isReceiverAdvert, targets: [host], log });
  const device = new Ad4qDevice({ host, browser, log });
  device.on('lost', (err) => fail(`lost the unit: ${err.message}`));
  console.error(`connecting to ${host} (the unit wants a few seconds of handshake)...`);
  await device.connect();
  browser.stop();
  return device;
}

async function write(device, label, run, expected) {
  try {
    const held = await run();
    const ok = expected === undefined || held === expected;
    console.log(`${ok ? 'CONFIRMED' : 'NOT APPLIED'}  ${label}: the unit now holds ${JSON.stringify(held)}`);
  } catch (err) {
    if (err instanceof WriteRefused) console.log(`REFUSED  ${label}: the unit rejected it (reason ${err.reason})`);
    else throw err;
  }
}

async function main() {
  if (command === 'discover') {
    const browser = new SlpBrowser({ filter: isReceiverAdvert, log });
    browser.on('found', (u) => console.log(`${u.ip}:${u.port}  ${u.fctn}  "${u.uacn}"  ${u.cidText}`));
    await browser.start();
    console.error('listening for 10 seconds...');
    await new Promise((r) => setTimeout(r, 10_000));
    if (!browser.devices().length) console.error('nothing answered: is the unit on this subnet?');
    browser.stop();
    return;
  }
  const host = hostArg(args[0]);
  const device = await connect(host);
  channelLimit = device.channels;
  try {
    if (command === 'status') {
      const all = await device.readAll();
      console.log('device ', JSON.stringify(all.device));
      for (const [n, props] of Object.entries(all.channels)) console.log(`ch ${n}   `, JSON.stringify(props));
    } else if (command === 'watch') {
      device.on('prop', ({ channel, key, value }) => console.log(`${channel ? `ch ${channel}` : 'device'}  ${key} = ${JSON.stringify(value)}`));
      await device.subscribeAll();
      console.error('watching; change something on the unit. Ctrl-C to stop.');
      await new Promise(() => {});
    } else if (command === 'scan') {
      const ch = channelArg(args[1]);
      const antenna = String(args[2] ?? '').toUpperCase();
      if (antenna !== 'A' && antenna !== 'B') fail('antenna is A or B');
      const model = decodeString(await device.get(DEV.MODEL));
      const limits = await device.scanLimits();
      const rest = args.slice(3).filter((a) => !a.startsWith('--') && Number.isFinite(Number(a)));
      const span = rest.length >= 2 ? { startKhz: Number(rest[0]) * 1000, stopKhz: Number(rest[1]) * 1000 } : defaultSpan(limits);
      const plan = planScan({ limits, ...span });
      if (!plan) fail(`nothing is left of that range once it is held inside what the unit scans (${limits.startKhz / 1000} to ${limits.stopKhz / 1000} MHz)`);
      console.error(`${model} scans ${limits.startKhz / 1000} to ${limits.stopKhz / 1000} MHz (index from ${limits.originKhz / 1000} MHz, ${limits.stepKhz} kHz steps)`);
      console.error(`antenna ${antenna} of channel ${ch}, ${plan.startKhz / 1000} to ${plan.stopKhz / 1000} MHz, ${plan.points} points, about ${Math.round(scanDurationMs(plan.points) / 1000)} s`);
      let lastTen = -1;
      const levels = await device.scan({
        channel: ch,
        antenna,
        plan,
        onProgress: (f) => {
          const ten = Math.floor(f * 10);
          if (ten !== lastTen) console.error(`  ${ten * 10}%`);
          lastTen = ten;
        },
      });
      const mhz = (i) => (plan.startKhz + i * plan.stepKhz) / 1000;
      const peaks = [];
      for (let i = 0; i < levels.length; i += 1) {
        const near = levels.slice(Math.max(0, i - 40), i + 41);
        if (levels[i] >= Math.max(...near) && levels[i] > Math.min(...levels) + 12 && (!peaks.length || mhz(i) - mhz(peaks.at(-1)) > 3)) peaks.push(i);
      }
      console.log(`${levels.length} points, ${Math.min(...levels)} to ${Math.max(...levels)} dBm; strongest peaks:`);
      for (const i of [...peaks].sort((a, b) => levels[b] - levels[a]).slice(0, 8)) console.log(`  ${mhz(i).toFixed(3)} MHz  ${levels[i]} dBm`);
      const out = args.find((a) => a.startsWith('--out='))?.slice(6);
      if (out) {
        writeFileSync(out, JSON.stringify({ plan, antenna, channel: ch, levels }));
        console.error(`saved ${out}`);
      }
    } else if (command === 'tone') {
      const ch = channelArg(args[1]);
      const level = args[2] === 'off' ? null : Number(args[2]);
      if (level !== null && !Number.isFinite(level)) fail('level is a number of dB, or "off"');
      if (args[3]) await write(device, `tone frequency ch ${ch}`, () => device.setChannel(ch, 'toneFreqHz', Number(args[3])), Number(args[3]));
      await write(device, `tone level ch ${ch}`, () => device.setChannel(ch, 'toneLevelDb', level), level === null ? -128 : level);
    } else if (command === 'mute') {
      const ch = channelArg(args[1]);
      const on = args[2] === 'on';
      await write(device, `mute ch ${ch}`, () => device.setChannel(ch, 'muted', on), on);
    } else if (command === 'gain') {
      const ch = channelArg(args[1]);
      await write(device, `gain ch ${ch}`, () => device.setChannel(ch, 'gainDb', Number(args[2])), Number(args[2]));
    } else if (command === 'freq') {
      const ch = channelArg(args[1]);
      await write(device, `frequency ch ${ch}`, () => device.setChannel(ch, 'frequencyMhz', Number(args[2])), Number(args[2]));
    } else if (command === 'antenna') {
      const ch = channelArg(args[1]);
      const pair = String(args[2] ?? '').toUpperCase();
      if (pair !== 'AB' && pair !== 'CD') fail('antenna is AB or CD (ANX4)');
      await write(device, `antenna ch ${ch}`, () => device.setAntenna(ch, pair), pair);
    } else if (command === 'name') {
      const ch = channelArg(args[1]);
      await write(device, `name ch ${ch}`, () => device.setChannel(ch, 'name', args.slice(2).join(' ')), args.slice(2).join(' '));
    } else {
      fail('usage: ad4q.mjs discover | status <ip> | watch <ip> | scan <ip> <ch> <A|B> [startMHz stopMHz] | tone|mute|gain|freq|name|antenna <ip> <ch> <value>');
    }
  } finally {
    await device.close();
  }
}

main().then(() => process.exit(0), (err) => fail(err.message));
