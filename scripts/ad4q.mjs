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
//
// Every write is read back and reported CONFIRMED or NOT APPLIED, because a SET
// the unit silently ignores looks the same as one that worked.

import { Ad4qDevice, WriteRefused } from '../driver/ad4q/device.js';
import { SlpBrowser } from '../driver/acn/slp.js';
import { isIpv4 } from '../driver/netutil.js';
import { CHANNEL_COUNT } from '../driver/ad4q/properties.js';

const [command, ...args] = process.argv.slice(2);
const log = (level, message) => level !== 'info' && console.error(`[${level}] ${message}`);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const channelArg = (text) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > CHANNEL_COUNT) fail(`channel must be 1..${CHANNEL_COUNT}`);
  return n;
};
const hostArg = (text) => {
  if (!isIpv4(text)) fail('give the unit\'s IPv4 address');
  return text;
};

async function connect(host) {
  const browser = new SlpBrowser({ filter: (u) => /^ad4q/i.test(u.fctn), targets: [host], log });
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
    const browser = new SlpBrowser({ filter: (u) => /^ad4q/i.test(u.fctn), log });
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
    } else if (command === 'name') {
      const ch = channelArg(args[1]);
      await write(device, `name ch ${ch}`, () => device.setChannel(ch, 'name', args.slice(2).join(' ')), args.slice(2).join(' '));
    } else {
      fail('usage: ad4q.mjs discover | status <ip> | watch <ip> | tone|mute|gain|freq|name <ip> <ch> <value>');
    }
  } finally {
    await device.close();
  }
}

main().then(() => process.exit(0), (err) => fail(err.message));
