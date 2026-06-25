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
5. **Set up the cloud catalog.** In the **Cloud** tab enter your **Network UUID** and **network
   password** (stored encrypted) — see [Finding your Network UUID](#finding-your-network-uuid)
   below. The catalog is built on start and re-synced on the configured interval or on demand via
   `control.syncNow` (last run in `info.lastSync`). Optionally limit the **build range**
   (device/scene) to try a subset.

To make individual luminaires controllable, continue with
[per-device control setup](control-and-state.md#setting-up-per-device-control).

## Finding your Network UUID

The adapter needs the **short network UUID** — a 12-character hex id like `ef3de41cf5d3`. This is
**not** the 128-bit *iBeacon UUID* shown in the Casambi app (entering that one makes the cloud
sync fail with a 404).

If the app doesn't clearly show the short id, discover it with the bundled **casambi-bt
playground** ([`docs/casambi-bt-playground`](casambi-bt-playground/)) — a small Python tool that
talks to the mesh over Bluetooth LE. Its `getinfo.py` is **read-only (no lights are touched)**:

```bash
# on a Linux box / Raspberry Pi within Bluetooth range of the mesh
./setup.sh            # one-time: venv + casambi-bt   (--classic for legacy networks)
source .venv/bin/activate
python getinfo.py     # scan -> pick network -> enter the NETWORK password
```

It connects with your **network password** (not your Casambi account login) and prints a log line

```
CasambiBt ... api.casambi.com/network/uuid/<UUID>
```

— that `<UUID>` is the value to paste into the **Cloud** tab. The same run also dumps the
network's units/groups/scenes. (Bluetooth/BLE is required, so run it on Linux/Pi, not macOS.)
