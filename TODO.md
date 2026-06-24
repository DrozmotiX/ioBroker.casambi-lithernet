# TODO — ioBroker.casambi-lithernet

Working tracker for the adapter. Ordered by priority. Check items off as they land;
add new ones under the right priority block.

Status: **v0.2.0** on branch `feat/mqtt-integration` (not merged, not released).
**Control proven live** (broadcast / scenes / groups) and **feedback proven live** (full
scene/group/device state via `get/poll_*`), validated against 349 real messages from a
REV2.5 / fw 4.56 gateway. Lint/type/test green.

---

## ✅ Done (P0 — was the critical path)

- [x] Live-test against the real gateway — connects, `info.connection` green.
- [x] Confirm the real `get/*` feedback topics (snooped live) — they are `poll_*`, **not**
      the `scene_level` names from old research.
- [x] Rewrite `parseGet` / `state_attr` / object model to the real `poll_*` protocol.
- [x] Verify control actuates lights — `set/scene_level` (1–21), `set/group_level`,
      `set/level` (broadcast all). All confirmed on real fixtures.
- [x] Gateway-side feedback config understood: **Polling Method = active** + cyclic-query
      counts (set via the gateway Wizard).
- [x] Removed the temporary log-all-messages toggle; inbound logs at debug.

## P0b — finish the live loop

- [ ] **Deploy v0.2.0 to the node** (`iobroker url "...#feat/mqtt-integration"` + restart) and
      confirm `broadcast` / `scenes` / `groups` / `devices` / `ungrouped` states populate live.
- [ ] **Trim the gateway poll counts** — currently 100 scenes / 100 groups / 21 devices, which
      creates many empty states and slows the poll cycle. Set them to the site's real totals
      (21 scenes + actual group/device counts) in the gateway Wizard.

## Live simulation 2026-06-24 — outcomes (see `docs/simulation-findings-2026-06-24.md`)

- Full findings + detection rules: **`docs/simulation-findings-2026-06-24.md`** (13.6k msgs captured).
- **Latency:** poll cycle ≈ 22.4s steady; actuation near-instant (1.5–2.8s to first feedback);
  the 0–22.4s lag is poll-phase, not device response.
- **Per-device control = conclusively NONE** — 7 topic candidates failed; gateway exposes only
  broadcast/scene/group setters. Devices are monitoring-only (resolves the P1 item below).
- **Site reality:** 12 live luminaires (1,2,3,9,10,12,16,17,18,19,20,21); 25 scenes at
  non-contiguous IDs (1–21,28,48,49,54); dev 4/5/6/11 are likely input/switch/sensor nodes
  (online, never carry a level, not in any scene, ignore broadcast).
- **NEXT (deferred, adapter-side):** filter empty slots in the adapter (gateway poll counts left
  as-is) using the detection rules in the findings doc — `node_type!=0` for real devices,
  `poll_scene.level!=255` for configured scenes, per-device `scene` field for membership.

## P1 — capability gaps

- [x] **Per-device control** — RESOLVED (negative): no per-device set topic exists. 7 candidates
      probed live (`set/device_level` with device/id, `set/unit_level`, `set/node_level`,
      path-based `set/device_level/1` & `set/device/1`; `set/level {device}` just broadcasts).
      Gateway supports only broadcast/scene/group. Individual lights → use a single-member
      scene/group, or the Casambi Cloud WebSocket API (P3). `devices.<n>` stays read-only.
- [ ] **Colour control** — whitepaper mentions setting colour temperature and colour; only
      `level` is wired today. Add CCT / RGB set commands + writable states.
- [ ] **`node_deleted` handling** — currently ignored; optionally delete the corresponding
      `devices.<n>` object when the gateway reports a deletion.
- [ ] **Level scale 0–255 vs 0–254** — feedback levels reach 255 (clamped to 254 for %); revisit
      whether the wire max should be 255 throughout. Colour/cct fields are raw 0–255 (not scaled).

## P2 — release readiness

- [ ] **ioBroker Adapter Checker** (https://adapter-check.iobroker.in/) — resolve findings.
- [ ] **Open PR** `feat/mqtt-integration` → `main`; CI runs; merge.
- [ ] **Release from `main`** via `npm run release` (tag, publish). Local finalize if Actions
      credits are out.
- [ ] **Human-review the i18n** (machine translations are rough, e.g. DE `Port`→"Hafen").
- [ ] Resolve the 2 cosmetic `@type` JSDoc lint warnings in `main.js`.

## P3 — future / ecosystem

- [ ] **Normalize into `oikos-connect`** device model once stable.
- [ ] **Multi-gateway** — multiple Bridge IDs on one broker, or per-gateway instances.
- [ ] **Full real-time alternative** — if cyclic-poll latency is too slow for a site, evaluate the
      **Casambi Cloud WebSocket API** (what Home Assistant uses) as a separate integration
      (real-time push of all units; needs Casambi API key + app-gateway + cloud).

---

## Reference — confirmed protocol & gateway facts

**Control (set, all proven):**
- `set/level` `{level,duration}` — **broadcast** to whole network
- `set/scene_level` `{scene,level,duration}` — scene N
- `set/group_level` `{group,level,duration}` — group N
- `set/button_level` / `set/push_button_pressed|released`, `set/light_sensor`, `set/pir_sensor` — injected inputs

**Feedback (get, REV2.5 / fw 4.56):** topic = `casambi/<id>/get/poll_<type>[/<idx>][/values|propertys]`
- `poll_broadcast`, `poll_ungrouped` → `{level,last_level,cct_level,vertical,last_change}`
- `poll_scene/<N>` → `{active,level,last_change}`
- `poll_group/<N>` → `{level,last_level,cct_level,vertical,last_change}`
- `poll_device/<N>/values` → `{scene,level,last_level,cct_level,red,green,blue,white,hue,sat,x,y,level_xy,vertical,last_change}`
- `poll_device/<N>/propertys` → `{online,node_type,priority,scene_type,color_selector,color_balance,condition,ambient_temperatur,battery_level,overheating,general_failure,last_change}`
- `node_deleted/` → `{device}`

**Gateway-side requirements:** Polling Method **active**; cyclic-query counts > 0; **Bridge ID 0**
(must match adapter `gatewayId`); MQTT-Port **3791** (must match broker — the Wizard defaults to
1883, so re-set it); no SSL.

## Notes / decisions (don't re-litigate)

- **aedes pinned `^0.51.3`** — 1.0.2 is broken (TCP connects, MQTT handshake never completes).
  Use `aedes.createBroker()` + `net.createServer(aedes.handle)`.
- **Default broker port 3791** (not 1883).
- **No SSL** — gateway doesn't support TLS; trusted network only.
- **House style:** `iobroker-jsonexplorer` + `lib/state_attr.js` + `lib/converter.js`, direct `this.log.*`.
- Lab values this session: gateway IP `192.168.60.222`, ioBroker node `192.168.60.217`.
