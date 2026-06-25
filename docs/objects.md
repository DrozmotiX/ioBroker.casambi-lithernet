# Object & state reference

[← back to README](../README.md)

> With the **cloud catalog** enabled, devices are keyed by their **BLE address**
> (`devices.<address>`, name/`deviceId`/`uuid`/`type`/`controlScene` + live `level`/`on`/health) and
> scenes by id; the MQTT tree below is the **gateway-only** (no-cloud) layout. `info.lastSync`,
> `info.devicesWithoutControlScene`, `info.devicesWithMultipleControlScenes`,
> `info.devicesNeedingControlScene` and `control.syncNow` are added in cloud mode. A device with a
> resolved control scene exposes **writable** `level`/`on` (a write recalls that scene); devices
> with none/multiple-unpicked stay read-only.

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
| `devices.<address>.level` / `.on` | `level.dimmer` / `switch.light` | read (write when a control scene is resolved) | `poll_device/<n>/values` |
| `devices.<address>.controlScene` | `value` | read | resolved control scene (`null` = none) |
| `devices.<address>.controlSceneSelect` | `value` (dropdown) | read/write | scene picker for ambiguous devices (by name) |
| `devices.<address>.{cct_level,red,green,blue,white,hue,sat,…}` | colour | read | `poll_device/<n>/values` |
| `devices.<address>.online` | `indicator.reachable` | read | `poll_device/<n>/propertys` |
| `devices.<address>.{condition,battery_level,overheating,general_failure,…}` | health | read | `poll_device/<n>/propertys` |
| `ungrouped.*` | `value` | read | `poll_ungrouped` |
| `sensors.lux` | `value.brightness` | write | `set/light_sensor` |
| `sensors.pir` | `switch` | write | `set/pir_sensor` |
| `buttons.<n>.{level,pressed,released}` | `level.dimmer`/`button` | write | `set/button_level` / `set/push_button_*` |

`broadcast` (all lights), `scenes` and `groups` are **controllable** (writable `level`).
Individual `devices` are controllable **per device via their control scene** (see
[Control & state synchronisation](control-and-state.md)); `ungrouped` is monitoring only.
`sensors` and `buttons` are inputs the adapter injects (`Injectable buttons` = count, 0 = none).
