# ADR: State model & cloud-enrichment strategy

- **Date:** 2026-06-25
- **Status:** §2 Accepted (implemented) · §3/§4 Proposed (for review)

## Context

On-site investigation (2026-06-24/25) of the Lithernet **Casambi Ethernet Gateway**
(fw 4.56, REV2.5) established, empirically:

- The MQTT gateway is **poll/listen only**: it exposes **no per-device set topic**
  (control is only `broadcast` / `scene` / `group` level) and surfaces **no raw
  button/sensor events** — in **active *and* passive** polling modes.
- **Passive polling mode** (BLE advertisement listening) gives **~1 s state latency**,
  **real-time scene `active`**, and **full-mesh device discovery** (active mode is capped
  by the device poll count and undercounts the mesh). Channel variants (`passive_37_*`,
  `passive_39_*`) showed no measurable benefit over plain `passive`.
- The site is controlled by **KNX** (`openKNX` → Casambi KNX bridge), which is
  **write-only — no state readback** (the operator's core pain point).

**Conclusion — a fusion of complementary planes:**

| Plane | Source | Strength |
|---|---|---|
| Control (hands) | KNX / scene recall | per-device control |
| Live state (eyes) | **MQTT passive** | ~1 s state, full mesh, local |
| Identity/structure (dictionary) | **Cloud** (optional) | names, scene/group membership, capabilities |
| Raw events | **Pi-BLE** (`casambi-bt`, future) | button/sensor press events |

## Decision

### 1. The adapter is a raw, isolated state source
No rooms / names / alias logic in this adapter. The Oikos alias + naming layer is owned by
**oikos-connect**, which is isolated and merely *reads* this adapter's states via its
`virtualState` overrule:

- alias `BrightnessCurrent` ← `casambi-lithernet.0.devices.<n>.level`
- alias `SwitchCurrent` ← `casambi-lithernet.0.devices.<n>.on`
- alias control (`*Target`) = KNX today, or MQTT scene recall later.

### 2. State-model corrections — **implemented in this PR**
- `devices.<n>.level` forced **read-only** (the gateway has no per-device set topic; it had
  been sharing the writable control-channel `level` leaf, making it a misleading no-op).
- `devices.<n>.on` **added** — read-only boolean (`role: switch.light`, = `level > 0`),
  for a clean `SwitchCurrent` mapping.
- Control states **unchanged**: `broadcast` / `scenes.<n>` / `groups.<n>` `.level` stay
  writable and publish `set/*`. (Each light is controlled via its **scene** — see §4.)

### 3. Cloud enrichment — optional module (**proposed**, Option 1: app-login)
A bootstrap module, **off by default**, that the operator may enable:

1. **Read all from cloud** — network structure: unit / scene / group **names**,
   **membership**, **capabilities**.
2. **Build the device structures** from that (complete, named, capability-typed) —
   strictly better than MQTT auto-discovery (knows non-advertising units, real names,
   authoritative membership → resolves the empirical-map overlaps and the active-mode
   undercount).
3. **Map MQTT live data** onto the structure (passive `poll_*` → level / `on` / scene state).
4. **Cloud no longer needed at runtime** — pure local MQTT; a **"Resync from cloud"** action
   re-reads on demand. With the module off, today's MQTT-only auto-discovery remains the
   fallback (no regression).

### 4. Control model & mandatory setup instruction
MQTT **cannot control individual devices**. Therefore, for per-device control, a
**single-member scene must be created per device in the Casambi app** — this is a documented
setup prerequisite. The control **transport** (API-only / MQTT-only / both) is **open**
(§Open questions).

## Open questions (to resolve during API exploration)

1. **State structure — by numeric ID, or by cloud metadata?** The model is currently
   ID-keyed (`devices.001…`). Cloud names could allow logical/name-based structuring, but
   **the MQTT-ID linkage must be preserved** for live mapping. Decide once we see the data.
2. **Cloud-access sub-path:**
   - (a) **App user-account login** (email + password, pure cloud, no BLE, no partner key —
     likely the iPad app's own method) — preferred for pure metadata if reachable.
   - (b) **`casambi-bt` network-password** (BLE-to-find + cloud-for-keys — the playground
     already on `main`).
   - (c) **Developer Cloud API** (partner key — deferred).
   Verify which yields names + membership **without** requiring BLE.
3. **Control transport:** API-only / MQTT-only / both.

## Plan (cloud module — next phase)
Phase 0 read cloud → Phase 1 build structures → Phase 2 map MQTT → Phase 3 resync.
Port the auth/fetch flow from `docs/casambi-bt-playground`. **Linchpin:** confirm the cloud
unit/scene/group IDs equal the MQTT `poll_*/<N>` indices (verify first — it makes the mapping
trivial).

## Status
- §2 (state model): implemented + unit-tested in this PR.
- §3/§4: proposed; cloud API data exploration is the next step.
