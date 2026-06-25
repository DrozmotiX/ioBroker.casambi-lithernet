# Changelog

All notable changes to this adapter are documented here.

<!--
	Placeholder for the next version (at the beginning of the line):
	## **WORK IN PROGRESS**
-->
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
