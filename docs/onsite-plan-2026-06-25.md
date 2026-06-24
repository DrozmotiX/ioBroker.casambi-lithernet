# Casambi gateway — on-site test plan (2026-06-25)

Follow-up to `docs/simulation-findings-2026-06-24.md`. Goal: with physical access to buttons
and switches, fill the gaps that remote snooping couldn't — **how buttons/switches report and
how to control on/off** — and live-validate the new adapter logic.

> ⚠️ Live customer site. Confirm before any broadcast/all-lights action; keep stimuli small
> and reversible; restore to the customer's expected state (all-off) at the end.

## 0. Setup (repeat from yesterday)
- [ ] User opens SSH tunnel: `ssh -L 14883:127.0.0.1:3791 oikosadmin@<node-host>`.
- [ ] Recreate snoop tooling (not committed): `mkdir -p /tmp/casambi-snoop && npm install --prefix /tmp/casambi-snoop mqtt`
      then `sub.js` (subscribe `#` → TSV) + `pub.js` (publish `casambi/0/<sub>` + MARKER). See yesterday's findings doc §tooling.
- [ ] Start subscriber to a fresh capture file; confirm `poll_*` feedback is flowing.
- [ ] (Optional but recommended) Deploy this branch to cross-check states:
      `iobroker url "DrozmotiX/ioBroker.casambi-lithernet#feat/mqtt-integration"` + restart.

## 1. Button read mechanism  ← the key unknown
Physical button presses, not the `set/push_button_*` *injection* topics. We don't yet know what
a real press publishes.
- [ ] With subscriber running, **press each physical button** (note time + which button).
- [ ] Identify the topic/payload a press emits — candidates: a `get/...` event, a
      `poll_device/<N>` change, or a dedicated button/scene message.
- [ ] Map each button → its message, and whether press/hold/release/multi-press differ.
- [ ] **Adapter follow-up:** wire the discovered read topic into `parseGet` so button presses
      surface as states/events (currently buttons are injection-only / write-only).

## 2. Nature of devices 4, 5, 6, 11 (and any other non-luminaires)
Yesterday: online, `node_type:3`, never carry a level, not in any scene, ignore broadcast.
- [ ] While snooping, physically actuate the switches and watch which index reacts.
- [ ] Correlate buttons pressed (§1) with indices 4/5/6/11 — are these the buttons/switches?
- [ ] Record their `node_type` / `scene_type` / `condition` signature vs the 12 luminaires so
      the adapter can classify input-vs-output devices (refine the §5 capability rules).

## 3. On/off control of an individual device (switch or single light)
No per-device set topic exists (proven, 7 candidates). Only path = a **single-member scene/group**.
- [ ] In the Casambi app, identify or create a scene whose only member is the target device.
- [ ] Recall it ON: `set/scene_level {scene:N, level:254}` → verify that device's `level` reads
      ~254 (switch on) / full (light). Recall OFF: `level:0` → verify back to 0.
- [ ] Confirm a switch reports state we can read back (level 254/0, or another field).
- [ ] **Decision:** model per-device on/off as "recall control-scene at 0/254"; document the
      required Casambi-app setup (one control-scene per individually-controllable device).

## 4. Off-scene vs empty/switch disambiguation
Scenes 2, 5, 6, 7, 8, 9, 11, 15, 17, 18, 19, 20, 21, 48, 49, 54 showed no dimmable members when
recalled **from off** — could be off-scenes (members → 0) or switch-only/empty.
- [ ] Set a baseline **all-on** (broadcast `level:128`), then recall each "empty" scene and
      watch for devices dropping to 0 (= off-scene) vs no change (= empty/switch-only).
- [ ] Tag each scene real/off-scene/empty → finalises the scene model + filtering confidence.

## 5. Capability encoding (only if a colour/tunable/sensor device exists on site)
Current adapter uses **create-on-nonzero** for colour/cct/battery (no colour device seen yet).
- [ ] If any tunable-white / RGB / sensor fixture exists, capture its `propertys`
      (`color_selector`, `color_balance`, `scene_type`) and `values` colour fields.
- [ ] Learn the `color_selector` value→capability mapping, then (optional) upgrade the adapter
      from create-on-nonzero to **explicit capability gating** off `color_selector`.

## 6. Live-validate the new adapter logic (this branch)
- [ ] Tree is **zero-padded** (`devices.001…021`) and sorts correctly in admin (the bug in the
      screenshot is gone); legacy unpadded objects were auto-removed on first start.
- [ ] **No phantom devices** (7,8,13,14,15 absent) and **no placeholder scenes** (only
      1–21,28,48,49,54 exist).
- [ ] A plain dimmer shows only `level`/`last_level`/`scene` + `online`/`node_type`/`condition`
      — **no RGB/cct/battery** clutter.
- [ ] **Names** tab still labels channels correctly with padded indices.
- [ ] Control still works end-to-end: `broadcast.level`, `scenes.<n>.level` write → lights move.

## 7. Deliverables
- [ ] Update `docs/simulation-findings-2026-06-24.md` (or a new dated findings doc) with the
      button read protocol, device 4/5/6/11 verdict, on/off model, scene tags.
- [ ] Update `TODO.md`: close the button-read item, capability-encoding item; record on/off model.
- [ ] Restore site to all-off; confirm via `poll_broadcast` + per-device values.
```detail
Open adapter items this plan feeds:
- buttons: read path (parseGet) — currently write/injection only
- input-device classification (node_type/scene_type) to mark switches/sensors
- per-device on/off via control-scene mapping (+ optional writable devices.<n>.on)
- capability gating refinement (color_selector) once a colour device is observed
```
