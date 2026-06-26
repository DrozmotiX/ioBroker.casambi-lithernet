# Changelog

All notable changes to this adapter are documented here.

<!--
	Placeholder for the next version (at the beginning of the line):
	## **WORK IN PROGRESS**
-->
## 0.8.0 (2026-06-26) - Document multi-member scene control as a known issue

Documents a working-as-designed behaviour: a device can only be mapped to a single-member control scene, so attempts to assign it to a multi-member scene are intentionally rejected. Adds a worked example and the resolution to the troubleshooting guide.

* (DutchmanNL) Docs: troubleshooting now documents the known issue that a device can't be assigned to a multi-member scene (control scenes must be single-member), with a worked example and the resolution

## 0.7.0 (2026-06-26) - Stable: correct, always-synced device on/off

First stable release of the on/off-correctness work that landed across the `0.6.12-beta.*` series, validated live on a customer gateway: no on/off **flip** on a switch, **confirmed-only** state that always reflects the device (never an assumed value), a per-device **off that wins over a foreign/button scene**, and correct on/off for **relay/switch units** (which signal state via the active scene, not `level`). Also documents the **Casambi network setup convention**.

* (DutchmanNL) Consolidates the beta fixes into a stable release: readback debounce + command settle window (no flip), confirmed-only ack with restore-on-timeout (state always matches the device), override-then-zero off (beats an active foreign scene), and `on = level > 0 || scene > 0` (relay/switch support)
* (DutchmanNL) Docs: new **Casambi network setup convention** — one single-member control scene per device, switches are scene-only (one scene each, never toggled directly), everything else (groups/scenes/schedules/automations) belongs in Oikos; physical multi-device buttons are the documented exception

## 0.6.12-beta.3 (2026-06-26) - Correct on/off for relay/switch units (not just dimmers)

A relay/switch (e.g. SWITCH-102) keeps its `level` at 0 and signals on/off only through the scene it follows, so the old `on = level > 0` left such devices stuck reading off. Verified live: toggling the switch flips its `scene` field `0 ↔ 103` while `level` stays 0. `on` is now derived from level **or** an active scene, so switches track correctly and dimmers are unchanged.

* (DutchmanNL) Fix: device `on` is now `level > 0 || scene > 0` — a relay/switch that reports `level 0` but follows a scene (`scene` non-zero) is correctly shown as **on**; a manually-dimmed lamp (scene 0, level up) and all dimmer cases are unchanged

```detail
- lib/casambi.js parseGet: on-derivation for poll_device values now unions level and the active-scene signal; unit test covers relay (level 0 + scene), dimmer-via-scene, dimmer-by-hand, and off
- Not addressed here: a relay turning OFF while a foreign scene is active (override-then-zero grab is skipped at level 0) — separate follow-up
```

## 0.6.12-beta.2 (2026-06-26) - Reliable per-device off + state always synced to the device

Fixes the "switch a lamp on with a button, off with the adapter → lamp stays on, and we show it as off" case. Two causes, both fixed: (1) our control "off" recalled the device's scene at level 0, which the gateway treats as *deactivate that scene* — so if a button's scene was active the lamp fell back to it and stayed on; (2) because the lamp didn't change, passive mode reported nothing, so our `on=false` was never corrected. Now the off uses **override-then-zero** (grab the load onto its control scene at its current level, then set 0) so it wins over a foreign scene, and a **settle timeout** restores the last gateway-confirmed value if any command produces no readback — so our state can never be left showing a value the device never reached.

* (DutchmanNL) Fix: per-device **off now overrides an active foreign scene** (e.g. a wall button's scene) instead of falling back to it. The off recalls the control scene at the load's current level then 0 ("override-then-zero", verified live); a non-zero on/dim already overrides, so it's unchanged
* (DutchmanNL) Fix: if a command gets **no confirming readback** within the settle window (it had no physical effect, so passive mode stays silent), the load's last gateway-confirmed `on`/`level` is **restored** — the device state always reflects reality, never an assumed value
* (DutchmanNL) `offGrabDelayMs` (default 300 ms) spacing for the override-then-zero recall

```detail
- lib/casambi.js: new pure `planDeviceLevels(target, current)` -> recall sequence ([current,0] for off-while-on, else [target]); unit-tested
- main.js: device-control publishes the planned sequence (grab spaced by offGrabDelayMs); `deviceExpect[key].restore` snapshots pre-command on/level; `deviceSettleTimers` + `onSettleTimeout` restore it if unconfirmed; timers cleared on confirm, unload, cloud rebuild
- builds on 0.6.12-beta.1 (settle window / flip suppression), unchanged
```

## 0.6.12-beta.1 (2026-06-26) - Command settle window (completes the on/off flip fix)

Completes the on/off flip fix. The 0.6.12-beta.0 debounce alone wasn't enough: the gateway re-polls every load continuously, so a **routine poll reports the still-old level ~0.5–1 s after a recall**, before the physical change — and that pre-change reading was written, re-introducing the flip. A per-device **command settle window** now ignores readbacks that still contradict the commanded on/off until the gateway reflects it; if the window elapses (command lost / didn't take), the true state is accepted — so a failed switch reverts to its real value instead of showing an assumed one.

* (DutchmanNL) Fix: on/off flip on a switch is now fully suppressed — a **command settle window** (`commandSettleMs`, default 2500 ms) drops the gateway's pre-change re-polls until it reflects the command. Live MQTT capture confirmed the contradicting reading is a separate poll cycle ~1 s after the recall, which the 300 ms readback debounce could not catch
* (DutchmanNL) When the settle window elapses without the command taking effect, the real gateway state is accepted (`ack:true`) — a lost/failed switch reverts to its true on/off rather than sticking on an assumed value (also addresses the occasional "shows on but really off")

```detail
- lib/casambi.js: new pure `settleReadback(pending, expect, now)` -> 'drop'|'accept' (unit-tested)
- main.js: `deviceExpect[key]={on,until}` armed on a device command; `flushDeviceReadback` consults `settleReadback`; cleared on unload + cloud rebuild
- builds on 0.6.12-beta.0 (debounce + confirmed-only ack); debounce still coalesces the ~10ms stale→fresh pair for non-command (external) changes
```

## 0.6.12-beta.0 (2026-06-26) - Confirmed-only device state + readback debounce (no on/off flip)

Fixes the on/off **state flip** on a switch: turning a light on/off briefly showed the *old* value before the *new* one. The gateway emits a stale-then-fresh level pair (~10 ms apart) on every scene recall; the adapter wrote both, and also optimistically acked the command. Device `level`/`on` are now **coalesced over a short window and only ever acked from confirmed gateway readback — never assumed**.

* (DutchmanNL) Fix: device `level`/`on` readbacks are **debounced** (`readbackDebounceMs`, default 300 ms) so the gateway's stale→fresh recall pair collapses to the settled value — no more old→new flip in the UI when switching a light
* (DutchmanNL) Fix: removed the **optimistic ack** on device control (and on broadcast/scene/group level writes) — these are now confirmed (`ack:true`) only by the real `poll_device`/`poll_*` readback, matching the documented control→confirm model. Injected sensors and virtual buttons (no gateway readback) still self-ack
* (DutchmanNL) A control command invalidates the device's confirmed snapshot so the next readback re-confirms even when the value is unchanged (commanding a load already in that state)

```detail
- lib/casambi.js: new pure `diffConfirmedReadback(pending, confirmed)` (writes only changed fields; unit-tested)
- main.js: `queueDeviceReadback`/`flushDeviceReadback` debounce in `routeLiveFeedback`; `deviceConfirmed` snapshot; ack removed from the device-control and generic publish paths (kept for sensors/buttons); timers cleared on unload + cloud rebuild
- The legacy (non-cloud) MQTT discovery path is unchanged; the fix targets the live cloud-mapped path used in production
```

## 0.6.11 (2026-06-25)
* (DutchmanNL) Docs: how to find your short **Network UUID** (it is **not** the app's 128-bit iBeacon UUID — entering that makes the cloud sync 404). Ship the read-only `getinfo.py` in the [casambi-bt playground](docs/casambi-bt-playground/) — it connects over Bluetooth with your network password and prints the UUID + network structure, **no lights touched**

## 0.6.10 (2026-06-25)
* (DutchmanNL) Docs: moved the changelog out of the README into this `CHANGELOG.md`; the README keeps a short **Control types & impact** overview and links here

## 0.6.9 (2026-06-25)
* (DutchmanNL) Docs: restructured the README into a short **overview + quick start + documentation index**, with the detailed guides moved into separate files under [`docs/`](docs/) (setup, data sources, control & state, object reference, troubleshooting). Easier to scan; no functional change

## 0.6.8 (2026-06-25)
* (DutchmanNL) Fix: a button/dimmer module no longer **explodes the object tree**. The gateway sends `element_*` sub-topics (`poll_device/<n>/element_{button,pushbutton,slider,onoff,dimmer}`) for those modules; `parseGet` was flattening every field into a raw state (`button_1..8`, `dimmer_1..4`, …). It now only flattens `values`/`propertys`; the `element_*` families are **sampled** (logged once) for proper button/dimmer mapping later, and existing leaked `element_*` states are cleaned up on sync

## 0.6.7 (2026-06-25)
* (DutchmanNL) Docs: new **Control & state synchronisation** section — control = scene recall (`ack:false`), confirmation = real MQTT device readback (`ack:true`, mesh-measured), pushed directly in `passive` (~0.4–1.5 s); state is correct no matter how the light was changed (app/wall/KNX/scene) and absolute on/off always works. Added **Per-device control: setup** (one single-member scene per device + assignment) and **Troubleshooting**; Setup now recommends `passive` polling

## 0.6.6 (2026-06-25)
* (DutchmanNL) Fix: a controllable device's `on` no longer reverts to **read-only after being switched** — the live MQTT readback ran `level`/`on` through jsonExplorer, which re-applied `state_attr`'s `write:false` for `on` and clobbered the per-device writability. `level`/`on` **values** are now set directly (`setState`), leaving writability untouched

## 0.6.5 (2026-06-25)
* (DutchmanNL) **Control-scene assignment moved to per-device dropdown states** (replaces the manual settings table): each ambiguous device gets a writable `devices.<address>.controlSceneSelect` whose admin dropdown lists its candidate scenes **by name** — choosing one assigns control **live** (no restart) and **survives restarts** (persisted in the state). The device list builds itself; single-candidate devices auto-map; `info.devicesNeedingControlScene` lists what still needs a choice

## 0.6.4 (2026-06-25)
* (DutchmanNL) Fix: `controlScene` of an unresolved (multiple-scene) or re-assigned device now clears to `null` instead of keeping a stale lowest-id value — it always reflects the real control scene (or none). Read-only gating was already correct; this fixes only the displayed value
* (DutchmanNL) The "control scene not set" warning is now **JSON** (`device`, `deviceId`, `address` tree key, `candidates` as `{sceneId, name}`) and is also published to **`info.devicesNeedingControlScene`** — readable, and tells you exactly which `sceneId` to assign

## 0.6.3 (2026-06-25)
* (DutchmanNL) Per-device **control scene mapping**: a device with exactly one single-member scene auto-maps as before; a device with **several** candidates is no longer silently mapped to the lowest id — it stays read-only and is **named in the log** until you assign its control scene in the new admin **Control mapping** tab (pick the scene by name; `uniqueColumns` prevents reusing a scene). Each single-member scene controls exactly one device, so choosing the scene is enough

## 0.6.2 (2026-06-25)
* (DutchmanNL) Diagnostic: unmapped gateway feedback topics (e.g. the `element_*` battery/button family) are now logged once at info level, deduplicated by topic shape — captures new payloads for mapping without raising the instance to debug. No behaviour change

## 0.6.1 (2026-06-25)
* (DutchmanNL) Crash/error reporting via GlitchTip (Sentry protocol) using `@iobroker/plugin-sentry` — uncaught exceptions are reported to the Oikos GlitchTip instance, tagged with the adapter `release` (version). Respects the ioBroker diagnostics setting and can be disabled per instance (`system.adapter.casambi-lithernet.<n>.plugins.sentry.enabled`)

## 0.6.0 (2026-06-25)
* (DutchmanNL) Live MQTT mapping onto the cloud catalog: device `level`/`on`, scene `active`, broadcast and device health (`online`/`condition`/`battery_level`/colour) update in real time
* (DutchmanNL) Device states are now keyed by the **BLE address** (`devices.<address>`) instead of the uuid — shorter and more readable; stale uuid-keyed channels are cleaned up on sync

## 0.5.0 (2026-06-25)
* (DutchmanNL) Per-device control for unambiguous devices: a device with exactly one control scene gets writable `level`/`on` that recall that scene (devices with no/multiple control scenes stay read-only)

## 0.4.1 (2026-06-25)
* (DutchmanNL) Docs: "Data sources & live state" section - the key-free cloud is the catalog only (no live state); live state + control come from the MQTT gateway, or a Casambi developer API key (which can also serve live via the cloud)

## 0.4.0 (2026-06-25)
* (DutchmanNL) Casambi cloud as the catalog source of truth: reads the network structure (names, scenes, groups, capabilities) using your own network credentials (UUID + network password) - no developer API key required
* (DutchmanNL) New "Cloud" settings tab; the network password is stored encrypted (encryptedNative/protectedNative)
* (DutchmanNL) Builds a uuid-keyed device tree with names/capabilities and derives each device's single-member control scene; live MQTT mapping follows in a later step
* (DutchmanNL) Sync: poll at start + configurable auto-sync interval + `control.syncNow` button + `info.lastSync`
* (DutchmanNL) Scene-coverage diagnostics: `info.devicesWithoutControlScene` / `info.devicesWithMultipleControlScenes` (+ log warnings) to troubleshoot the one-scene-per-device setup
* (DutchmanNL) Optional build-range filter for devices and scenes (default `0-*` = all, e.g. `1-30`) to build objects for a subset while testing

## 0.3.3 (2026-06-25)
* (DutchmanNL) Device states are now read-only (the gateway has no per-device set topic over MQTT)
* (DutchmanNL) Each device exposes a derived read-only `on` state (level > 0) for downstream consumers (e.g. oikos-connect SwitchCurrent)
* (DutchmanNL) Add ADR: state model & cloud-enrichment strategy

## 0.3.2 (2026-06-25)
* (DutchmanNL) CI: test on Node.js 22.x/24.x and trim the adapter test matrix to Ubuntu

## 0.3.1 (2026-06-25)
Leaner, correct object tree built from the gateway's padded cyclic poll: placeholder slots are no longer created, indices sort naturally, and a plain dimmer only gets the states it needs. Adds an opt-in cleanup of orphaned objects. Derived from a live REV2.5 / fw 4.56 mapping session.

* (DutchmanNL) New **Remove orphaned objects** option (Settings → Maintenance, off by default) — after a full poll cycle on start, deletes scene/group/device objects whose entity no longer exists on the gateway; skipped while the gateway is offline so it can never wipe the tree
* (DutchmanNL) Scene/group/device/button indices are now **zero-padded** (`devices.001`) so they sort naturally in admin; legacy unpadded objects are cleaned up automatically on first start
* (DutchmanNL) **Placeholder slots are skipped** — unconfigured scenes/groups (level 255 sentinel; verified live: real scenes max at 254, an `active` scene is never dropped) and empty device slots (`node_type` 0) no longer create phantom states; honours `node_deleted`
* (DutchmanNL) **Capability-gated states** — a plain dimmer only gets `level`/`last_level`/`scene` + health; colour/cct/battery states are created only once a device actually reports them (live-validated: 12 luminaires, 25 scenes, no per-device set topic exists)

## 0.3.0 (2026-06-24)
* (DutchmanNL) Added a **Names** config tab — assign friendly names to scenes, groups and devices by number; applied as the channel name (e.g. `devices.12` → "Kitchen Spot")

## 0.2.0 (2026-06-24)
* (DutchmanNL) Rewrote the feedback parser for the gateway's real `get/poll_*` topics — live scene/group/device state (level, colour, online, condition, battery) auto-populates
* (DutchmanNL) Whole-network `broadcast` control (`set/level`) replaces the previous `control.*` channel
* (DutchmanNL) Removed the temporary "Log all incoming MQTT messages" toggle — inbound is logged at debug level only

## 0.1.1 (2026-06-24)
* (DutchmanNL) Added "Log all incoming MQTT messages" option for setup/diagnostics

## 0.1.0 (2026-06-24)
* (DutchmanNL) Initial release: embedded MQTT broker, scene/group/device discovery, gateway/scene/group control, lux/PIR/button injection
