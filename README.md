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
4. Once the gateway connects, `info.connection` turns green and the
   `scenes`, `groups` and `devices` trees populate from the gateway's feedback.

## Objects

All dimmer levels honour the **Dimmer level scale** setting (percent by default).

| State | Role | Direction | MQTT |
|-------|------|-----------|------|
| `info.connection` | `indicator.connected` | read | gateway client connected |
| `control.level` | `level.dimmer` | write | `set/level` (gateway luminaire) |
| `control.duration` | `value` | write | fade duration (ms) for `control.level` |
| `scenes.<n>.level` | `level.dimmer` | read/write | `set/scene_level` ↔ feedback |
| `scenes.<n>.active` | `indicator` | read | feedback |
| `groups.<n>.level` | `level.dimmer` | read/write | `set/group_level` ↔ feedback |
| `devices.<n>.level` | `level.dimmer` | read | feedback (monitoring only) |
| `devices.<n>.condition` | `value` | read | feedback |
| `sensors.lux` | `value.brightness` | write | `set/light_sensor` |
| `sensors.pir` | `switch` | write | `set/pir_sensor` |
| `buttons.<n>.level` | `level.dimmer` | write | `set/button_level` |
| `buttons.<n>.pressed` | `button` | write | `set/push_button_pressed` |
| `buttons.<n>.released` | `button` | write | `set/push_button_released` |

`scenes`, `groups` and `devices` are created on demand from the gateway's feedback.
`sensors` and `buttons` are inputs the adapter injects; the number of virtual buttons is
set with the **Injectable buttons** option (0 = none).

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

### 0.1.0 (2026-06-24)
* (DutchmanNL) Initial release: embedded MQTT broker, scene/group/device discovery, gateway/scene/group control, lux/PIR/button injection
* (DutchmanNL) Added "Log all incoming MQTT messages" option for setup/diagnostics

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
