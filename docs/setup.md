# Setup & prerequisites

[← back to README](../README.md)

## Prerequisites

- A Lithernet Casambi gateway on the same trusted network as ioBroker.
- Casambi **Evolution** firmware **> v35** is recommended (Classic firmware works with
  reduced functionality).
- **No SSL:** the gateway does not support MQTT over TLS, so the broker listens on plain
  TCP. Run it on a trusted VLAN only.

## Steps

1. **Install the adapter** and create an instance.
2. **Configure the broker.** In the instance settings set the **MQTT broker** (listen address,
   **port** – default `3791`, optional username/password) and the **Gateway ID** (the
   `<deviceId>` you set in the gateway's web UI – default `0`).
3. **Point the gateway at ioBroker.** In the gateway's web UI, enable **MQTT mode** and point its
   MQTT client at `<ioBroker-host>:<port>` (and the credentials, if you set any). When it
   connects, `info.connection` turns green.
4. **Choose the polling method** (gateway web UI). **`passive` is recommended** — it listens to
   the Casambi BLE advertisements and **pushes** state on change (sub-second, and it discovers the
   whole mesh). `active` cyclically polls a configured count instead (~20 s, slower, and
   undercounts the mesh if the device count is set too low). Either way the `broadcast`, `scenes`,
   `groups`, `devices` and `ungrouped` trees populate live — see
   [Control & state synchronisation](control-and-state.md) for why `passive` matters.
5. **Set up the cloud catalog.** In the **Cloud** tab enter your **Network UUID** (Casambi app →
   *More → Network Setup → iBeacon → UUID*) and **network password** (stored encrypted). The
   catalog is built on start and re-synced on the configured interval or on demand via
   `control.syncNow` (last run in `info.lastSync`). Optionally limit the **build range**
   (device/scene) to try a subset.

To make individual luminaires controllable, continue with
[per-device control setup](control-and-state.md#setting-up-per-device-control).
