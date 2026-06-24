# Casambi gateway — live simulation findings (2026-06-24)

Empirical results from the live session against the REV2.5 / fw 4.56 gateway, run per
`docs/simulation-plan.md`. ~13.6k MQTT messages captured (raw: `/tmp/casambi-snoop/casambi-session-2026-06-24.tsv`).
Scope run: A baseline · B broadcast · C scenes (full 1–54 real set) · per-device discovery.
Groups out of scope (site uses none). Site restored to all-off at end.

## 1. Latency profile
- **Full poll cycle ≈ 22.4s**, rock-steady (broadcast polled every 22.31–22.37s; device-1
  reappears every 22.36s). This is the feedback-visibility ceiling.
- **Actuation is near-instant.** First feedback after a publish landed in **1.5–2.8s**
  (whenever the affected device was next polled). The 0–22.4s "latency" is purely poll-phase
  position, *not* device response lag. Full roster visible within one cycle.
- Implication: control feels instant at the fixture; *state read-back* lags up to one cycle.
  For snappy UI confirmation the Cloud WebSocket API (TODO P3) remains the real-time option.

## 2. Command → effect matrix
| Command | Topic | Payload | Effect |
|---|---|---|---|
| Broadcast | `set/level` | `{level,duration}` | ✅ all 12 live luminaires to level |
| Scene recall | `set/scene_level` | `{scene,level,duration}` | ✅ scene's member devices to level; **cumulative** (stacks) |
| Group level | `set/group_level` | `{group,level,duration}` | not tested (no groups on site) |
| **Per-device** | — | — | ❌ **no topic exists** (see §5) |

## 3. Real entities on this site (vs gateway padding)
Gateway polls 100 scenes / 100 groups / 21 devices; most are empty padding.
- **Devices:** indices 1–21. **12 live luminaires:** 1, 2, 3, 9, 10, 12, 16, 17, 18, 19, 20, 21.
  - Empty slots (`node_type:0`): 7, 8 (carry *stale non-zero* level 16/4 — ignore; never change).
  - `node_type:0` offline slots: 13, 14, 15.
  - **4, 5, 6, 11** — `online:1, node_type:3` but **never carry a level, never join a scene,
    ignore broadcast** → almost certainly **input/switch/sensor nodes, not dimmable outputs**
    (or absent fixtures). `last_level:255` sentinel reinforces "no dim level ever stored".
- **Scenes:** **25 configured**, IDs NOT contiguous: **1–21 + 28, 48, 49, 54** (highest = 54).
  Empty slots report `level:255` (0xFF sentinel); configured report a real stored level.

## 4. Scene → luminaire membership map
Derived from the per-device `scene` field (the reliable membership signal).
| Scene | Devices | Scene | Devices |
|---|---|---|---|
| 1 | dev1, dev2 | 13 | dev9 |
| 3 | dev18, dev19 | 14 | dev10 |
| 4 | dev20, dev21 | 16 | dev12 |
| 10 | dev1 | 28 | dev16, dev17 |
| 12 | dev3 | | |

Scenes **2, 5, 6, 7, 8, 9, 11, 15, 17, 18, 19, 20, 21, 48, 49, 54** claimed **no dimmable
device** when recalled from off. Caveat: recalled from an *off* baseline, so any **off-scene**
(members → 0) is indistinguishable from empty here. Separating them needs a recall from
all-on (deferred — extra light-flashing on a live site).

## 5. Per-device control — conclusive NEGATIVE
7 candidates probed on dev1 (dimmable, isolated), all failed except the broadcast false-positive:
| Candidate | Result |
|---|---|
| `set/device_level {device:1}` | no effect |
| `set/device_level {id:1}` | no effect |
| `set/unit_level {unit:1}` | no effect |
| `set/node_level {node:1}` | no effect |
| `set/device_level/1` (index in path) | no effect |
| `set/device/1` (index in path) | no effect |
| `set/level {device:1}` | **broadcast** — extra field ignored, hit all devices |

→ The gateway exposes **only broadcast / scene / group** setters. **Individual devices are
monitoring-only** (confirms README). Per-device control requires a single-member scene/group
or the Casambi Cloud WebSocket API.

## 6. Detection rules for adapter logic (empirically derived)
For the deferred "filter empty slots in the adapter" work (gateway poll counts left as-is):
- **Device is real/controllable luminaire** ⇔ `poll_device/<N>/propertys.node_type != 0`
  **AND** it carries/echoes a `level` (responds to broadcast). `node_type:0` = empty slot.
- **Device is likely input/switch/sensor** ⇔ `node_type:3` but `last_level:255`, never in a
  scene, ignores broadcast (dev 4/5/6/11 signature). Treat as non-dimmable.
- **Scene is configured** ⇔ `poll_scene/<N>.level != 255`. `255` = empty padding slot.
  **Verified, not assumed:** across the whole capture, all 25 configured scenes only ever
  reported 254 (full)/their stored value/the recall level — **never 255**; all 75 placeholder
  slots reported **only 255** (level histogram: 254×110, 178/73/15/6×few, 255×424). A real
  full scene maxes at 254 (= 100%); 255 is one above wire-max = the 0xFF unset sentinel.
  Safety net in the adapter: an **`active:1` scene is never dropped** even if it read 255, so a
  currently-recalled scene can never be hidden.
- **Scene membership** = the per-device `scene` field, NOT level deltas.
- **Don't trust `poll_scene.active` for speed** — the flag lagged ~100s in the sweep
  (all recalled scenes only flipped `active:1` in the final cycle). Use device-level deltas.
- **`poll_broadcast.level` is an aggregate**, not exact (reported 108 for a set of 128) —
  use per-device `values.level` for truth.
- **Gateway double-publishes** each `poll_device/<N>/values` (~10–13ms apart); the transition
  can appear across the pair. Debounce / take last.
- Ignore stale non-zero levels on `node_type:0` slots (dev7=16, dev8=4 here).
