# Shure AD4Q for SoundBase

A [SoundBase](https://soundbase.app) plugin that puts a Shure **AD4Q**
four-channel Axient Digital receiver into SoundBase's device monitoring, over
the network, with no Wireless Workbench in between: each channel's name,
frequency, gain, mute, tone generator and diversity on a card, with the
settings that are safe to change writable from SoundBase.

> **Status: not yet run against a real AD4Q.** The driver is tested against a
> simulated unit that speaks the same wire protocol, and the protocol layer is
> pinned to bytes captured from real traffic. [First hour with
> hardware](#first-hour-with-hardware) lists what to check first.

## Requirements

- **macOS** with SoundBase Desktop.
- **The AD4Q on the same network as this computer**, on a show network or
  cabled straight to it. Discovery and control rely on traffic that does not
  cross a router.
- Node 20 or newer, to run from source. SoundBase Desktop ships its own.

## What is exposed

| Setting | Where in SoundBase | Writable |
|---|---|---|
| Channel name | channel card | yes |
| Frequency | channel card | yes (25 kHz steps, 470 to 1000 MHz) |
| Gain | channel card | yes (-18 to +42 dB) |
| Mute | channel card | yes |
| Tone generator level | channel card | yes (Off, or -60 to -12 dB in 6 dB steps) |
| Tone generator frequency | list view | yes (Hz) |
| Diversity mode | channel card | yes (Off, Selection, Combining) |
| Overload hold | list view | yes |
| Interference avoidance | list view | yes (Off, Manual, Automatic) |
| Unregistered transmitter action | list view | yes (Allow, Warn, Block) |
| IR preset RF power | list view | yes (Low, Normal, High, or No change) |
| Talk-switch routing: XLR, TRS, AES3 and Dante, for each switch position | device settings | yes (one switch per output) |
| Unlink a registered transmitter | device settings | yes (pick a slot; it returns to None) |
| Unit name | device settings | yes |
| Fan mode, power-switch lock, front-panel lock | device settings | yes |
| RF level | channel meter | read-only |
| Paired transmitter: model, battery | channel card, list view | read-only |
| Last transmitter synced to the channel | list view | read-only |
| Encryption | list view | **read-only** |
| Band, HD mode, Quadversity, antenna bias | device settings | **read-only** |

**Read-only on purpose.** HD mode reboots the receiver, encryption forces every
transmitter to re-sync, and antenna bias puts DC on the antenna ports. They are
shown here and changed in Wireless Workbench or on the unit, where a mistake is
harder to make.

**Transmitters and the roster.** The receiver reports the paired transmitter's
model and battery as soon as one is IR-synced, and clears them when it leaves.
Its registered-transmitter slots only fill for a moment during a sync, so they
are shown as "last synced" rather than as a standing list. Unlinking clears one
slot on the unit. The IR preset RF power is what a transmitter takes on at its
next IR sync, not a live transmit power.

Out-of-range values are snapped to what the unit accepts, and what the unit
reports back is what SoundBase shows. Changes made on the unit's front panel or
in Workbench appear in SoundBase as they happen.

## Using it

Units on the computer's network appear in SoundBase's device setup by
themselves, named as the unit announces itself. To add one by hand, give its IP
address, or list addresses under **Additional AD4Q addresses** in the plugin's
settings. Tick **Simulate an AD4Q** to get a pretend four-channel unit with no
hardware at all.

Opening a unit takes a few seconds: the AD4Q wants a paced handshake before it
will talk. If something else already controls it, such as Wireless Workbench on
another computer, check there first.

## Try it

```sh
npm install
npm run doctor      # is the plugin well-formed?
npm test            # the codec, the driver and the adapter, with nothing attached
npm run smoke       # boots main.js as a child process, as SoundBase does
```

### First hour with hardware

The command-line tool talks to a real unit through the plugin's own driver,
with SoundBase out of the picture. Every write is read back and reported
`CONFIRMED` or `NOT APPLIED`.

```sh
npm run ad4q -- discover                    # who answers on this network?
npm run ad4q -- status  <ip>                # every modelled setting, all four channels
npm run ad4q -- watch   <ip>                # print what the unit pushes as you touch it
npm run ad4q -- tone    <ip> 1 -24 1000     # tone generator, channel 1: -24 dB at 1 kHz
npm run ad4q -- tone    <ip> 1 off
npm run ad4q -- mute    <ip> 2 on
```

Things worth confirming before trusting the card:

1. **The RF level meter.** The channel's live level is shown as an RF level in
   dBm. That reading is identified but not yet confirmed as RF rather than
   audio; `watch` shows it moving against a real transmitter.
2. **Pacing.** Requests are paced and batched conservatively. If the unit drops
   some, or the session ends under load, loosen `sendGapMs` and `maxInFlight` in
   `driver/acn/session.js`.
3. **Transmitter battery and unlink.** Sync a transmitter and compare the
   battery percentage with the transmitter's own display, then try unlinking a
   slot on a spare channel.
4. **Ranges.** Tone frequency, the tone level steps and the channel name length
   are limited to what has been seen; the unit rejects anything else and the
   plugin leaves the setting alone.

## Developing

```
adapter.js                  discovery, descriptors, state, setProperty
driver/
  acn/pdu.js                the packet codec
  acn/slp.js                finding units; advertising this controller
  acn/session.js            one held-open session: join, acks, pacing
  ad4q/properties.js        the property map and value encodings
  ad4q/device.js            typed reads and writes, with read-back
  fake/fake-ad4q.js         a simulated unit speaking the real wire on loopback
scripts/ad4q.mjs            the command-line tool for a real unit
```

Environment variables, all optional: `SB_AD4Q_SIMULATE=1` adds the simulated
unit; `SB_AD4Q_NO_DISCOVERY=1` turns off network discovery (the tests use it).

The guide set the plugin template ships is in [docs/](docs/README.md), and
[CLAUDE.md](CLAUDE.md) is the short version of the plugin model.

## Known limits

- macOS only for now; the code has not been run elsewhere.
- One controller per unit is the safe assumption: running this beside Wireless
  Workbench on the same AD4Q has not been tried.
- The battery reading is the unit's best-identified field for it and has not
  been checked against a transmitter's own display.
- Unlinking has been seen on one roster slot; the other seven are assumed to
  behave the same.

## What you are trusting

Installing a plugin means trusting its author. SoundBase runs it as a separate
process, which isolates faults but is not a security sandbox: this code runs with
your user's privileges, like a VST or a Companion module. It talks only to the
AD4Q units on your network and to SoundBase. Its source is all in this
repository, and the author is listed in the manifest.

Maintained by Matt Bell, <matt@mbsound.org>.

This plugin is not affiliated with, authorized or endorsed by Shure
Incorporated. "Shure", "AD4Q", "Axient" and "Wireless Workbench" are trademarks
of their owner, used here only to say what the plugin works with.

## License

MIT. See [LICENSE](LICENSE).

The SoundBase SDK this plugin runs on (`@soundbase/plugin-contract` and
`@soundbase/plugin-shell`) is a separate work under its own licence, the Business
Source License 1.1, which permits building and distributing plugins for SoundBase.
It is installed as a dependency and is not part of this repository.
