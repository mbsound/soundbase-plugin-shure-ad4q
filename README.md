# Shure AD4Q for SoundBase

A [SoundBase](https://soundbase.app) plugin that puts a Shure **AD4Q**
four-channel or **AD4D** two-channel Axient Digital receiver, or an **ANX4**
multichannel receiver, into SoundBase,
over the network, with no Wireless Workbench in between. In device monitoring:
each channel's name, frequency, gain, mute, tone generator and diversity on a
card, with the settings that are safe to change writable from SoundBase. In the
spectrum analyzer: the receiver's own RF scan, from the channel and antenna you
choose.

> **Status: run against a real AD4D-A** (monitoring, writes and the RF scan).
> A real AD4Q has not been tried; the driver treats it as the same unit with
> four channels, and the protocol layer is pinned to bytes captured from real
> traffic. [First hour with hardware](#first-hour-with-hardware) lists what to
> check first.

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
| Tone generator quick toggle | channel settings | yes: one switch, on = -30 dB, off = off. Hidden by the "Quick toggles" plugin setting |
| Diversity mode | channel card | yes (Off, Selection, Combining) |
| Overload hold | list view | yes |
| Interference avoidance | list view | yes (Off, Manual, Automatic) |
| Unregistered transmitter action | list view | yes (Allow, Warn, Block) |
| IR preset RF power | list view | yes (Low, Normal, High, or No change) |
| Talk-switch routing: XLR, TRS, AES3 and Dante, for each switch position | device settings | yes (one switch per output) |
| Unlink a registered transmitter | device settings | yes (pick a slot; it returns to None) |
| Unit name | device settings | yes |
| Encryption | device settings | yes (Off/On), one setting for the whole unit; the transmitters need an IR sync afterwards |
| Antenna bias | device settings | yes |
| Require Showlink For Frequency | device settings | built and tested but hidden until SoundBase can push frequencies to a plugin device (see Known limits); `SB_AD4Q_SHOWLINK_LOCK=1` offers it. While on, every frequency change through the plugin is refused on a channel whose transmitter has no ShowLink |
| Fan mode, power-switch lock, front-panel lock | device settings | yes |
| HD mode | device settings | yes; the receiver restarts itself (about 30 s off the air) and unpairs its transmitters, which need an IR sync again. The plugin reconnects on its own |
| Quadversity | device settings | no: the receiver refuses it over the network, so it is shown only |
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

### The transmitter, ShowLink and the unit's alarms

Beside its control session the plugin also opens Shure's documented control port (TCP 2202, the
"command strings" protocol) and keeps it open. From there it shows the transmitter being received on
each channel (model, name, battery with runtime, power, audio state, talk switch), whether a
registered ADX transmitter is online over **ShowLink** and how good that link is, and the unit's own
alarms (interference, an unregistered transmitter, an encryption mismatch) as device notices. If
that port does not answer, monitoring still works without those details.

### The RF scan

The same unit is also a spectrum-analyzer source in the plot's Live Scan
picker. Starting a sweep takes **one scan** from the chosen channel
and antenna and then holds the result; start again for a fresh one. With
**A + B** it scans each antenna in turn and shows the stronger of the two at
every point, with each antenna's own curve overlaid. A scan covers the unit's
whole range by default (about two minutes per antenna at 25 kHz steps) or the
span you set, snapped to the unit's raster. The range, raster and index origin
are read from the unit, so a 470, 606 or 750 MHz model each scans its own band.
Audio is not interrupted by a scan.

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

### If a scan stalls

A scan that starts and then receives nothing is reported within about 20 s as
"the scan stalled: …" with what the plugin saw: the unit's scan status, how many
points arrived, and whether samples arrived under a curve index other than the
one asked for (those are used automatically, and logged). The plugin log
(SoundBase's plugin manager, or `pluginLogs/shure-ad4q.log`) carries the same
milestones for every scan: claimed, status changes, first samples, complete.

All scan testing was on an AD4D-A. If an AD4Q stalls, send that log together
with the unit's firmware, band and Quadversity setting; `AD4Q_DEBUG=1` in the
plugin's environment logs every packet, which is enough to find the difference
without a Workbench capture.

## The ANX4

The ANX4 is a one-rack-space frame that receives up to 16 channels of Axient
Digital or 24 of ULX-D, with as many channels active as it has licences for
(bought in one- and four-channel steps, so any count from 1 to 24). On the wire
it is an AD4Q with more channels: the same session, the same channel objects,
the same device settings. The differences this plugin handles:

- **It advertises its receiver module, not the frame.** The SLP function tag is
  `MCR_AD` (the Axient Digital module); the model string on the unit reads
  `ANX4`. Discovery accepts the tag and, because the channel count is a licence
  only the unit knows, opens a short session to count the channels before
  listing it. SoundBase fixes a device's channel count from its product, so the
  ANX4 is offered as `anx4-1` … `anx4-24` and discovery lists the one that
  matches.
- **The band is per channel**, where an AD4Q has one for the unit. Each
  channel's band is a cell on its card (`x.shure-ad4q.band`); the unit cell
  shows the channels' bands, and the band is not changed from here.
- **Four named antennas** (A–D) are shown with the unit's settings. There is no
  Quadversity flag and no antenna-bias flag at the AD4Q's addresses.
- **Sync presets.** What the next IR sync sends to a transmitter — RF power level,
  bodypack pad and offset, handheld offset, the plug-on's phantom power, pad,
  offset and high-pass filter, polarity, mute mode, locks, battery type and
  custom groups — are shown and set per channel (`x.shure-ad4q.sync`, a
  "Sync presets" group on the card). Each row offers the values read from a
  unit plus their obvious neighbours and "No change"; the unit's read-back is
  the check. The AD4Q's own IR-preset RF power control is not offered on the
  ANX4, which keeps that setting here instead.
- **No RF scan yet.** The ANX4 has no per-channel scan trigger (the antennas are
  shared), and its scan has not been captured from Workbench; the ANX4 products
  do not declare the spectrum analyzer.
- Command strings (TCP 2202) are off until enabled on the unit, and the ANX4
  firmware seen (1.0.16.0) had no such option; transmitter details then come
  from the ACN bank alone.

Status: read on a real ANX4 licensed for 16 channels (2026-10-28, firmware
1.2.18.0): discovery, the session, every channel's properties, meters and sync
presets, the device settings; a full read takes about 3.5 s the first time and
1.6 s after. Writes and the card in SoundBase are still to be checked on the
unit.

## Known limits

- **SoundBase cannot yet push coordinated frequencies to a plugin device** (SoundBase Desktop as of
  October 2026). Frequencies link to the plugin's channels, but the push option never appears: the
  plot's push logic only offers devices whose record has `sessionStarted`, a flag SoundBase sets from a
  `communicationStarted` event it raises for its first-party device sessions only; plugin devices arrive
  through `DeviceManagerService.applyExternalState`, which never raises it, and the contract gives a
  plugin no way to set the flag. Reported to SoundBase. Until it is fixed, a frequency change from the
  coordination view has to go through SoundBase's own Shure AD4 integration, which talks to the unit
  directly and so bypasses this plugin's "Require Showlink For Frequency" lock.

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
