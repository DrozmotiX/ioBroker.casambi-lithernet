# TODO — ioBroker.casambi-lithernet

Working tracker for the adapter. Ordered by priority. Check items off as they land;
add new ones under the right priority block.

Status: **v0.1.0** built on branch `feat/mqtt-integration` (not merged, not released).
Embedded aedes MQTT broker + scene/group/device discovery + control + sensor/button
injection. Lint/type/test green; broker round-trip verified locally.

---

## P0 — Correctness / go-live blockers (do first, in order)

- [ ] **Live-test against a real Lithernet Casambi gateway.** Point the gateway's MQTT
      client at `<ioBroker-IP>:3791`, gateway ID `0`. Confirm `info.connection` goes green.
- [ ] **Confirm the real `get/*` feedback topic strings.** Enable *Log all incoming MQTT
      messages* (or debug level) and snoop `casambi/0/get/#`. The exact topic names for the
      cyclic reports are not 100% documented — capture what the gateway actually emits.
- [ ] **Tighten `lib/casambi.js` `parseGet`** to match the observed topics/payloads
      (device level/condition + scene/group reports). Add/adjust cases + unit tests.
- [ ] **Verify command direction actuates lights.** Write `control.level`, `scenes.<n>.level`,
      `groups.<n>.level` and confirm the luminaires respond (and feedback echoes back).

## P1 — Release readiness

- [ ] **Run the ioBroker Adapter Checker** (https://adapter-check.iobroker.in/) against the
      repo; resolve any errors/warnings.
- [ ] **Open PR** `feat/mqtt-integration` → `main`; let CI (test + checker) run; merge.
- [ ] **Cut the release from `main`** via `npm run release` (tag `v0.1.0`, CI publishes to
      npm). Use the local finalize flow if GH Actions credits are exhausted.
- [ ] **Human-review the i18n.** The machine translations are rough (e.g. DE `Port`→"Hafen",
      `Gateway`→"Tor", `Listen address`→"Ansprache anhören"). Fix at least DE/EN, or onboard
      to the central Weblate server.

## P2 — Robustness / polish

- [ ] **Broker resilience:** handle "port already in use" gracefully (clear error + retry or
      terminate); confirm clean restart on config change.
- [ ] **Devices monitoring:** confirm `devices.<n>.condition` semantics and whether per-device
      level feedback is actually emitted; document.
- [ ] **Button injection:** validate `set/push_button_pressed/released` + `button_level` on a
      real network (currently unit-tested only).
- [ ] **`levelScale: raw`** end-to-end check (0–254 path).
- [ ] **Decide `scene_call` handling** — currently mapped to `scenes.<n>.active=true`; consider
      a dedicated momentary event/last-called timestamp.
- [ ] **Resolve the 2 non-blocking `@type` JSDoc lint warnings** in `main.js` (cosmetic).

## P3 — Future / ecosystem

- [ ] **Normalize into `oikos-connect`** device model (alias mapping) once the adapter is stable.
- [ ] **Multi-gateway support** — multiple gateway IDs on one broker, or per-gateway instances.
- [ ] **Observability** — jsonexplorer supports Sentry; decide whether to wire it in.
- [ ] **Optional:** add a "Testing" section to `README.md` (currently only in chat/handover).

---

## Notes / decisions (don't re-litigate)

- **aedes pinned to `^0.51.3`.** aedes **1.0.2 is broken here** — TCP connects but the MQTT
  handshake never completes (no CONNACK), so the gateway can't connect. 0.51.x is what the
  official ioBroker.mqtt adapter uses. Use `aedes.createBroker()` + `net.createServer(aedes.handle)`.
- **Default port 3791** (not 1883 — avoids colliding with an existing broker).
- **Devices are monitoring-only** — the gateway exposes no per-device `set` topic; control via
  scenes/groups/the gateway luminaire.
- **No SSL** — the gateway doesn't support MQTT over TLS; trusted network only.
- **House style:** `iobroker-jsonexplorer` + `lib/state_attr.js` for objects, `lib/converter.js`
  for transforms, direct `this.log.*` (mirrors DrozmotiX BambuLab/WLED).
