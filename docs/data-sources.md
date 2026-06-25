# Data sources & live state

[← back to README](../README.md)

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
`info.devicesWithoutControlScene` / `info.devicesWithMultipleControlScenes`. See
[Control & state synchronisation](control-and-state.md) for the full control model.
