# Working on this plugin with Claude

Context for Claude Code and any other coding agent working in this repository.
It is also the shortest accurate description of the plugin model here, so it is
worth reading yourself.

## What this repository is

A **SoundBase plugin** for the Shure AD4Q, a four-channel Axient Digital
receiver: a small network service that provides the unit to SoundBase over a
versioned HTTP + SSE contract. SoundBase spawns it as a child process and
supervises it — handshake, health, crash-restart, teardown. The plugin in turn
holds one ACN (ANSI E1.17) session per unit and pushes its state to SoundBase
as it changes.

SoundBase is an RF coordination platform for live events. This plugin lands in
its **device monitoring** views: a card per channel, with the settings that are
safe to change writable from it. `docs/soundbase.md` is the full orientation.

The author writes device logic. The author never writes UI, IPC, or HTTP.

```
soundbase-plugin.json   identity, the product, its layout, config fields, state keys
main.js                 shell bootstrap — never edit
adapter.js              the unit on the contract — the file that changes
driver/
  acn/pdu.js            ACN root/SDT/DMP codec
  acn/slp.js            SLP: unit adverts, SrvRqst, this controller's advert
  acn/session.js        AcnSession: join, acks, NAK retransmit, paced sends
  cmdstrings/client.js  Shure's documented TCP 2202 protocol: transmitter, slots/ShowLink, status flags
  ad4q/properties.js    the address map and value codecs
  ad4q/device.js        Ad4qDevice: typed reads/writes with read-back, and scan()
  ad4q/scan.js          the RF scan: keys, planning on the unit's own range, sample decoding
  fake/fake-ad4q.js     FakeAd4q: the same wire, no hardware; also the in-app simulator
  fake/fake-commands.js FakeCommandServer: the simulator's TCP 2202 side
__tests__/              byte pins, driver vs fake, adapter via the real shell
scripts/ad4q.mjs        the command-line tool for a real unit
docs/                   the plugin template's guide set
```

## Rules specific to this plugin

- **Reverse-engineering notes never go in this repository.** The research this
  driver is built from lives outside every git repo, on purpose. Source code and
  its short comments are fine; findings documents, captures and address-by-address
  write-ups are not. Do not add them, and do not paste their contents into docs.
- **Every setting the unit accepts over the network is writable, by decision.**
  HD mode restarts the unit about 18 s after the write, and the adapter rides that
  out (`#expectRestart` / `#reconnect`) instead of reporting a fault; the band
  retunes the channels and moves the scan limits; encryption changes the key the
  channel's transmitters need. Quadversity is refused because the receiver itself
  refuses it over the network, and the band stays read-only on a range whose band
  list is not known (`BANDS_BY_RANGE`).
- **The talk routing shares one byte.** Writing one output reads the byte first
  and changes only its bit (`Ad4qDevice.setTalkOutput`); never write the byte whole.
- **Channel state merges, so "nothing" must be published.** A key left out of a
  channel map leaves the host showing its old value. Clear with an explicit
  empty value, as `lastSync` and `transmitter` do.
- **Every SET carries its commit PDU, and every write is read back.** The unit
  answers a SET only with it, and a write it ignores looks like one that worked.
  `Ad4qDevice` does both; do not send a SET around it.
- **Reliable sends are paced and windowed** (`DEFAULT_TIMINGS` in `session.js`).
  The unit's receive buffer is small; unpaced bursts drop the session.
- **The state the layout binds to is the state the adapter emits.** A test checks
  that every `x.shure-ad4q.*` key is declared and that the layout reads only keys
  the adapter provides.
- **One unit is one device, with two adapters.** Each product declares channel
  monitoring and `spectrumAnalyzer`, so the shell opens a monitoring adapter and
  a spectrum adapter on the same `net:<ip>` device; each holds its own session
  to the unit, as Wireless Workbench and this plugin do side by side.
- **Never UNSUBSCRIBE the RF_SCAN keys, and read the claim before every scan.**
  An unsubscribe makes a real unit silently ignore every later scan in the
  session; the claim (`Ad4qDevice.scan` reads `0x0n00090f`) is spent by each
  scan. Both are modelled by `FakeAd4q`, so a regression fails the driver tests.
- **A scan's geometry comes from the unit.** Range, raster and index origin are
  read (`scanLimits()`), never assumed from the model letter; that is what makes
  a B- or C-range receiver scan correctly.


## Invariants — do not violate these without being asked

- **Never edit `main.js`.** It is byte-identical across every first-party
  plugin and is the contract's entry point. Anything you are tempted to put
  there belongs in `adapter.js`. The single exception is adding a lifecycle
  hook (`init`, `configUpdated`, `destroy`) to the `Plugin` class body — and
  `this.config` is already threaded into both adapter exports, so that is
  rarely needed.
- **Never implement HTTP, routing, SSE, auth, or sweep bookkeeping.**
  `@soundbase/plugin-shell` owns all of it. If a change involves an HTTP verb,
  it is almost certainly wrong.
- **Never read a device address from machine-local state.** Addressing arrives
  explicitly in `device.config` on `POST /devices`. The same project opened on
  another machine must work.
- **Device ids must be stable across restarts.** They appear in URLs and are
  stored in users' projects. `usb:<path>` and `net:<host>` are the conventions.
- **Clamp, do not reject.** Out-of-range config gets snapped to what the
  hardware accepts and echoed back. Rejection looks like a broken plugin.
- **Every product the adapter announces must be declared in the manifest.** The
  two agree via `npm run rename`; a mismatch produces a device the host
  silently ignores. A test and `npm run doctor` both check it.
- **Do not accumulate trace modes.** The shell does max-hold, min-hold and
  average at the device's full sweep rate. Report raw sweeps.
- **Do not bump the `template` block** in `soundbase-plugin.json`. It records
  what this plugin was generated from and is meant to go stale.

## The adapter contract

`adapter.js` exports `discoverDevices` and one factory per module its
products use — which one a device gets is decided by its product's manifest
`capabilities` (`spectrumAnalyzer` → the first; anything else → the second):

```js
export async function discoverDevices(pluginConfig) → Device[]
export function createSpectrumAnalyzerAdapter(device, pluginConfig) → {
  open()                 → { capabilities, identity }
  applyConfig(cfg)       → effective config, echoing what the device accepted
  startSweep(onTrace)    → calls onTrace(number[]) once per completed sweep; an optional
                           second argument, [{ name, amplitudesDbm }], adds named curves
  stopSweep()
  close()
  onFatal                → assigned by the shell; call it when the transport dies
}
export function createMonitoringAdapter(device, pluginConfig) → {
  open()                 → { channelCount?, layout?, properties?, identity? }; report full state first
  close()
  setProperty(command)   → apply { propertyId, channelIndex?, entityId?, value }; report the result via onState
  onState                → assigned by the shell; onState(key, value) for every state change
  onWarnings, onFatal    → assigned by the shell
}
```

`docs/adapter-reference.md` is the detailed version. The normative
specification is installed, not guessed at:

```
node_modules/@soundbase/plugin-contract/spec/
  soundbase-plugin.schema.json
  core.openapi.yaml
  spectrum-analyzer.openapi.yaml
  channel-monitoring.openapi.yaml
  property-control.openapi.yaml
  state-keys.json
```

**Read those files before answering a question about the contract.** They ship
inside the dependency and always match the shell version in the lockfile, so
they are authoritative in a way that any summary — including this file — is not.

## Verifying a change

In order of what they prove:

```sh
npm run doctor    # is the plugin well-formed at all?
npm test          # adapter through the real shell, over HTTP
npm run manifest  # the manifest the host will refuse or accept
npm run smoke     # boots as a child process, handshakes, sweeps
```

A change is not done because `npm test` passes. If it touches discovery,
startup or the manifest, run the smoke check — that is the path that fails
silently in production, because a plugin that never handshakes is simply
invisible to SoundBase.

## Prompts that work

**Implementing a real device**

> Replace `adapter.js` so it talks to <device> over <transport>. Keep
> `discoverDevices` and `createSpectrumAnalyzerAdapter` as the only exports and
> put the protocol code in `driver/`. Read
> `node_modules/@soundbase/plugin-contract/spec/spectrum-analyzer.openapi.yaml`
> first, and match its semantics
> for `applyConfig`'s echo and trace geometry. Add a fake device beside the
> driver so the tests run with nothing attached. Keep the existing tests
> passing — they are written against the contract, not against the synthetic
> source.

**Adding a device control**

> Add a <name> control. Declare it in `capabilities.controls` from `open()`
> using the config-field vocabulary, read it from `cfg.controls` in
> `applyConfig`, clamp it to what the hardware allows, and echo the settled
> value in the returned `effective.controls`. Add a test that a value outside
> the range comes back clamped rather than rejected, and one that a request
> carrying only this control leaves the others in force.

**Wrapping a native library**

> Read `docs/native-runtimes.md` first. Put the libuhd work in a worker child
> process under `driver/worker/` speaking JSON-lines over stdio, so the driver
> can SIGKILL it when a call wedges. Give the worker a mock mode so tests run
> with no hardware attached.

**Diagnosing "my plugin does not appear in SoundBase"**

> Run `npm run doctor`, then `npm run smoke`, and work from what they report.
> Check in this order: does the manifest validate; does the handshake line
> appear at all; does `GET /devices` return anything; does every device name a
> product the manifest declares. The host gives up on a plugin that does not
> handshake, and logs nothing that explains why. `docs/troubleshooting.md` has
> the full list.

**Renaming the plugin**

> Run `npm run rename <id>` rather than editing by hand — the id appears in the
> manifest, in every product's `deviceTypeId`, in `adapter.js`, in
> `package.json`, and in the `x.<id>.` namespace of every extension state key.
> A partial rename produces a device the host ignores with only a warning line
> in the log, or a manifest the host refuses outright.

## What not to ask for

- **A second transport.** WebSocket, gRPC and subscription protocols are all
  out of scope; the contract is HTTP plus SSE lifecycle events, deliberately.
- **UI.** Plugins do not ship renderer code. If a device needs a knob SoundBase
  has never heard of, that is `capabilities.controls`, which renders generically
  and needs no SoundBase release.
- **Changes to the shell.** If the shell seems to be in the way, that is worth
  raising as an issue rather than working around — a workaround in `adapter.js`
  becomes the thing that breaks on the next contract version.
- **Trace-mode maths, sweep ids, long-polling, or an SSE stream.** All of it is
  already implemented in the shell.
