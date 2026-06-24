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

## Objects

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

### **WORK IN PROGRESS**
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
