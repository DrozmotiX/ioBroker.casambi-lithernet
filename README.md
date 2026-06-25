![Logo](admin/casambi-lithernet.png)
# ioBroker.casambi-lithernet

[![NPM version](https://img.shields.io/npm/v/iobroker.casambi-lithernet.svg)](https://www.npmjs.com/package/iobroker.casambi-lithernet)
[![Downloads](https://img.shields.io/npm/dm/iobroker.casambi-lithernet.svg)](https://www.npmjs.com/package/iobroker.casambi-lithernet)
![Number of Installations](https://iobroker.live/badges/casambi-lithernet-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/casambi-lithernet-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.casambi-lithernet.png?downloads=true)](https://nodei.co/npm/iobroker.casambi-lithernet/)

**Tests:** ![Test and Release](https://github.com/DrozmotiX/ioBroker.casambi-lithernet/workflows/Test%20and%20Release/badge.svg)

## casambi-lithernet adapter for ioBroker

Integrates a **Lithernet Casambi gateway** into ioBroker over **MQTT**. The gateway
bridges the Casambi *Bluetooth* lighting mesh to the IP network via Ethernet; this
adapter speaks to it locally, with no cloud involved.

The Casambi gateway is an MQTT *client* and needs a broker to connect to. Rather than
forcing you to install and configure a separate broker, **this adapter runs its own
embedded MQTT broker** ([aedes](https://github.com/moscajs/aedes)). You simply point the
gateway's MQTT client at the ioBroker host and the configured port.

- Manufacturer / product: <https://casambi.lithernet.de/> · system manual <https://lither.net/man>
- Casambi: <https://casambi.com/>

> **Disclaimer:** *Casambi* and *Lithernet* are trademarks of their respective owners.
> This is an independent, community-developed adapter and is not affiliated with or
> endorsed by Casambi Technologies Oy or Lithernet.

## Features

- Embedded MQTT broker – no external broker required.
- Scenes, groups and individual devices are **auto-discovered** from the gateway's cyclic
  status feedback and exposed as ioBroker states.
- Control of the gateway's own luminaire, scenes and groups (with fade duration).
- Inject **light (lux)** and **PIR** sensor values, and optional virtual **button** events
  back into the Casambi network.
- Dimmer levels exposed as 0–100 % (default) or raw 0–254.
- **Casambi cloud catalog** (your own network credentials, no developer API key): device/scene/group
  names, structure, capabilities and button→scene wiring, with on-demand and scheduled sync.
- **Scene-coverage diagnostics**: flags devices with no / multiple control scenes.

## Data sources & live state

The adapter uses up to three sources, each with a distinct role — **the Casambi cloud is the
*catalog*; the MQTT gateway is the *live/control* plane.**

| Capability | Casambi cloud (key-free, your network credentials) | MQTT gateway (Lithernet) | Casambi Developer API (needs API key) |
|---|---|---|---|
| Names, structure, capabilities, button→scene | ✅ source of truth | ids only | ✅ |
| **Live** device level / on, scene active | ❌ no live (poll snapshot, no push) | ✅ real-time (~1–2 s) | ✅ real-time (WebSocket) |
| **Control** (recall / dim) | ❌ | ✅ via scene recall | ✅ |
| Update cadence | poll: at start + every *X* min | continuous push | continuous push |

What this means:

- **The key-free cloud gives the catalog only** — it is request/response and carries **no live
  state**. So **for live state and control you need the MQTT gateway** (or the developer API).
- **When an MQTT gateway is present it provides live state + control** and takes precedence over
  the cloud.
- **With a Casambi Developer API key**, the cloud can *also* deliver live state + control
  (WebSocket) — so the MQTT gateway becomes optional even for live updates. *(Planned; the
  key-free path does not include this.)*

Per-device control is **scene-only**: create **one single-member scene per device** in the
Casambi app. The adapter derives each device's control scene and reports gaps in
`info.devicesWithoutControlScene` / `info.devicesWithMultipleControlScenes`.

## Prerequisites

- A Lithernet Casambi gateway on the same trusted network as ioBroker.
- Casambi **Evolution** firmware **> v35** is recommended (Classic firmware works with
  reduced functionality).
- **No SSL:** the gateway does not support MQTT over TLS, so the broker listens on plain
  TCP. Run it on a trusted VLAN only.

## Setup

1. Install the adapter and create an instance.
2. In the instance settings configure the **MQTT broker** (listen address, **port** –
   default `3791`, optional username/password) and the **Gateway ID** (the `<deviceId>`
   you set in the gateway's web UI – default `0`).
3. In the gateway's web UI, enable **MQTT mode** and point its MQTT client at
   `<ioBroker-host>:<port>` (and the credentials, if you set any).
4. Once the gateway connects, `info.connection` turns green. To receive **feedback**
   (scene/group/device state), the gateway must be set to **Polling Method = active** in its
   own web UI, with the number of scenes/groups/devices to query configured. The
   `broadcast`, `scenes`, `groups`, `devices` and `ungrouped` trees then populate live.
5. **Cloud (catalog):** in the **Cloud** tab enter your **Network UUID** (Casambi app → *More →
   Network Setup → iBeacon → UUID*) and **network password** (stored encrypted). The catalog is
   built on start and re-synced on the configured interval or on demand via `control.syncNow`
   (last run in `info.lastSync`). Optionally limit the **build range** (device/scene) to try a subset.

## Objects

> With the **cloud catalog** enabled, devices are keyed by their **BLE address**
> (`devices.<address>`, name/`deviceId`/`uuid`/`type`/`controlScene` + live `level`/`on`/health) and
> scenes by id; the MQTT tree below is the **gateway-only** (no-cloud) layout. `info.lastSync`,
> `info.devicesWithoutControlScene`, `info.devicesWithMultipleControlScenes` and
> `control.syncNow` are added in cloud mode. A device with **exactly one** control scene exposes
> **writable** `level`/`on` (a write recalls that scene); devices with none/multiple stay read-only.

All dimmer levels honour the **Dimmer level scale** setting (percent by default). Feedback
arrives on `get/poll_*` topics; the trees below are created on demand as the gateway polls.

| State | Role | Direction | MQTT |
|-------|------|-----------|------|
| `info.connection` | `indicator.connected` | read | gateway client connected |
| `broadcast.level` | `level.dimmer` | read/write | `set/level` ↔ `poll_broadcast` (whole network) |
| `broadcast.{last_level,cct_level,vertical}` | `value` | read | `poll_broadcast` |
| `scenes.<n>.level` | `level.dimmer` | read/write | `set/scene_level` ↔ `poll_scene/<n>` |
| `scenes.<n>.active` | `indicator` | read | `poll_scene/<n>` |
| `groups.<n>.level` | `level.dimmer` | read/write | `set/group_level` ↔ `poll_group/<n>` |
| `groups.<n>.{last_level,cct_level,vertical}` | `value` | read | `poll_group/<n>` |
| `devices.<n>.level` | `level.dimmer` | read | `poll_device/<n>/values` (monitoring) |
| `devices.<n>.{cct_level,red,green,blue,white,hue,sat,…}` | colour | read | `poll_device/<n>/values` |
| `devices.<n>.online` | `indicator.reachable` | read | `poll_device/<n>/propertys` |
| `devices.<n>.{condition,battery_level,overheating,general_failure,…}` | health | read | `poll_device/<n>/propertys` |
| `ungrouped.*` | `value` | read | `poll_ungrouped` |
| `sensors.lux` | `value.brightness` | write | `set/light_sensor` |
| `sensors.pir` | `switch` | write | `set/pir_sensor` |
| `buttons.<n>.{level,pressed,released}` | `level.dimmer`/`button` | write | `set/button_level` / `set/push_button_*` |

`broadcast` (all lights), `scenes` and `groups` are **controllable** (writable `level`).
`devices` and `ungrouped` are **monitoring only** — the gateway exposes no per-device set
topic. `sensors` and `buttons` are inputs the adapter injects (`Injectable buttons` = count,
0 = none).

## Limitations

- Individual `devices.<n>` are **monitoring only** – the gateway exposes no per-device set
  topic; control luminaires via scenes, groups or the gateway luminaire instead.
- The gateway uses **fixed MQTT topics** that cannot be remapped on the device.
- Per-gateway limits: 250 devices, 255 groups, 255 scenes. More polled devices means
  slower cyclic status updates.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### 0.6.0 (2026-06-25)
* (DutchmanNL) Live MQTT mapping onto the cloud catalog: device `level`/`on`, scene `active`, broadcast and device health (`online`/`condition`/`battery_level`/colour) update in real time
* (DutchmanNL) Device states are now keyed by the **BLE address** (`devices.<address>`) instead of the uuid — shorter and more readable; stale uuid-keyed channels are cleaned up on sync

### 0.5.0 (2026-06-25)
* (DutchmanNL) Per-device control for unambiguous devices: a device with exactly one control scene gets writable `level`/`on` that recall that scene (devices with no/multiple control scenes stay read-only)

### 0.4.1 (2026-06-25)
* (DutchmanNL) Docs: "Data sources & live state" section - the key-free cloud is the catalog only (no live state); live state + control come from the MQTT gateway, or a Casambi developer API key (which can also serve live via the cloud)

### 0.4.0 (2026-06-25)
* (DutchmanNL) Casambi cloud as the catalog source of truth: reads the network structure (names, scenes, groups, capabilities) using your own network credentials (UUID + network password) - no developer API key required
* (DutchmanNL) New "Cloud" settings tab; the network password is stored encrypted (encryptedNative/protectedNative)
* (DutchmanNL) Builds a uuid-keyed device tree with names/capabilities and derives each device's single-member control scene; live MQTT mapping follows in a later step
* (DutchmanNL) Sync: poll at start + configurable auto-sync interval + `control.syncNow` button + `info.lastSync`
* (DutchmanNL) Scene-coverage diagnostics: `info.devicesWithoutControlScene` / `info.devicesWithMultipleControlScenes` (+ log warnings) to troubleshoot the one-scene-per-device setup
* (DutchmanNL) Optional build-range filter for devices and scenes (default `0-*` = all, e.g. `1-30`) to build objects for a subset while testing

### 0.3.3 (2026-06-25)
* (DutchmanNL) Device states are now read-only (the gateway has no per-device set topic over MQTT)
* (DutchmanNL) Each device exposes a derived read-only `on` state (level > 0) for downstream consumers (e.g. oikos-connect SwitchCurrent)
* (DutchmanNL) Add ADR: state model & cloud-enrichment strategy

### 0.3.2 (2026-06-25)
* (DutchmanNL) CI: test on Node.js 22.x/24.x and trim the adapter test matrix to Ubuntu

### 0.3.1 (2026-06-25)
Leaner, correct object tree built from the gateway's padded cyclic poll: placeholder slots are no longer created, indices sort naturally, and a plain dimmer only gets the states it needs. Adds an opt-in cleanup of orphaned objects. Derived from a live REV2.5 / fw 4.56 mapping session.

* (DutchmanNL) New **Remove orphaned objects** option (Settings → Maintenance, off by default) — after a full poll cycle on start, deletes scene/group/device objects whose entity no longer exists on the gateway; skipped while the gateway is offline so it can never wipe the tree
* (DutchmanNL) Scene/group/device/button indices are now **zero-padded** (`devices.001`) so they sort naturally in admin; legacy unpadded objects are cleaned up automatically on first start
* (DutchmanNL) **Placeholder slots are skipped** — unconfigured scenes/groups (level 255 sentinel; verified live: real scenes max at 254, an `active` scene is never dropped) and empty device slots (`node_type` 0) no longer create phantom states; honours `node_deleted`
* (DutchmanNL) **Capability-gated states** — a plain dimmer only gets `level`/`last_level`/`scene` + health; colour/cct/battery states are created only once a device actually reports them (live-validated: 12 luminaires, 25 scenes, no per-device set topic exists)

### 0.3.0 (2026-06-24)
* (DutchmanNL) Added a **Names** config tab — assign friendly names to scenes, groups and devices by number; applied as the channel name (e.g. `devices.12` → "Kitchen Spot")

### 0.2.0 (2026-06-24)
* (DutchmanNL) Rewrote the feedback parser for the gateway's real `get/poll_*` topics — live scene/group/device state (level, colour, online, condition, battery) auto-populates
* (DutchmanNL) Whole-network `broadcast` control (`set/level`) replaces the previous `control.*` channel
* (DutchmanNL) Removed the temporary "Log all incoming MQTT messages" toggle — inbound is logged at debug level only

### 0.1.1 (2026-06-24)
* (DutchmanNL) Added "Log all incoming MQTT messages" option for setup/diagnostics

### 0.1.0 (2026-06-24)
* (DutchmanNL) Initial release: embedded MQTT broker, scene/group/device discovery, gateway/scene/group control, lux/PIR/button injection

## License
MIT License

Copyright (c) 2026 DutchmanNL <oss@drozmotix.eu>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
