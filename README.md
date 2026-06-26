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
- Scenes, groups and individual devices **auto-discovered** and exposed as ioBroker states.
- Per-device control via single-member **control scenes**, with live, mesh-confirmed state.
- **Casambi cloud catalog** (your own network credentials, no developer API key): names,
  structure, capabilities and button→scene wiring, with on-demand and scheduled sync.
- Inject **light (lux)** / **PIR** sensor values and virtual **button** events.
- Dimmer levels as 0–100 % (default) or raw 0–254; scene-coverage diagnostics.

## Quick start

1. Install the adapter and create an instance.
2. Configure the **embedded MQTT broker** (port `3791`) + **Gateway ID**, enable **MQTT mode** in
   the gateway's web UI and point its MQTT client at `<ioBroker-host>:<port>`.
3. Set the gateway **Polling Method = `passive`** (recommended — pushes state on change,
   sub-second).
4. In the **Cloud** tab enter your **Network UUID** + **network password** — the catalog source of
   truth for names, structure and scenes.
5. Make luminaires controllable: create **one single-member scene per device** in the Casambi app;
   they then auto-map (or pick the scene in each device's `controlSceneSelect`).

→ Full walk-through: **[Setup & prerequisites](docs/setup.md)** ·
**[per-device control](docs/control-and-state.md#setting-up-per-device-control)**.

## Control types & impact

| Control | Write to | Affects |
|---|---|---|
| Whole network | `broadcast.level` | every light on the network |
| Group | `groups.<n>.level` | the members of that group |
| Scene | `scenes.<n>.level` (recall) | the members of that scene |
| Single device | `devices.<address>.on` / `.level` | just that one device (via its single-member control scene) |

Per-device control is **scene-only** — a device write recalls its assigned control scene, so it
affects only that device. However the light is changed — this adapter, the Casambi app, a wall
switch, KNX, or another scene — the reported `devices.<address>.level`/`.on` is the **real,
mesh-confirmed state** (`ack:true`), and on/off is **absolute** (no toggle). See
**[Control & state synchronisation](docs/control-and-state.md)** for the full model.

## Documentation

| Guide | What's inside |
|---|---|
| [Setup & prerequisites](docs/setup.md) | Install, broker, gateway, polling mode, cloud credentials |
| [Data sources & live state](docs/data-sources.md) | Cloud catalog vs MQTT live vs developer API — who provides what |
| [Control & state synchronisation](docs/control-and-state.md) | How switching works (scene recall + mesh readback), per-device control setup, and the **Casambi network setup convention** (scenes/switches/buttons) |
| [Object & state reference](docs/objects.md) | Every state: role, direction and MQTT topic |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and limitations |

## Changelog

See **[CHANGELOG.md](CHANGELOG.md)** for the full version history.

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
