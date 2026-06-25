# Troubleshooting

[← back to README](../README.md)

- **A device's `level`/`on` is read-only (can't control it).** It has **no** single-member
  control scene, or **several** and none picked yet. Create one in the app, or pick one in the
  device's `controlSceneSelect` dropdown. Check `info.devicesNeedingControlScene` and the warning
  in the log (it names each device + its candidate scenes). See
  [per-device control setup](control-and-state.md#setting-up-per-device-control).
- **State doesn't update / is stale.** Check `info.connection` is green (gateway connected) and
  the gateway **Polling Method** is `passive` (or `active`). In `passive`, idle devices only
  report **on change** — that is expected; trigger a change to see an update.
- **A re-sync fixed something on its own.** A cloud re-sync (`control.syncNow`) re-asserts each
  device's resolved control scene and writability; if a state looks wrong, a re-sync is a safe
  reset.
- **Sending `off` seems to do nothing.** Confirm the device actually has a resolved
  `controlScene` (not `null`) and that its control scene is genuinely single-member; a
  multi-member scene would move several devices and is intentionally not offered.
- **Cloud sync fails (`info.lastSync` not advancing).** Re-check the **Network UUID** (the short
  network id, not the app iBeacon UUID) and **network password** in the Cloud tab.

## Limitations

- Individual `devices.<address>` are controllable **only via a single-member control scene** — the
  gateway exposes no per-device set topic. Whole-network `broadcast`, `scenes` and `groups` are
  directly writable.
- The gateway uses **fixed MQTT topics** that cannot be remapped on the device.
- Per-gateway limits: 250 devices, 255 groups, 255 scenes. In `active` mode, more polled devices
  means slower cyclic status updates (another reason to prefer `passive`).
