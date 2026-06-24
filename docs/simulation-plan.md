# Casambi gateway — live simulation & data-mapping session

Handoff plan for a **new session** to empirically map the gateway's control → effect →
feedback behaviour, agree the control/monitor model, then refine the adapter logic.
Read this top-to-bottom, **agree the scope with the user first** (Section 3), then execute
the phases (Section 5) one at a time, listening between each.

> ⚠️ This drives **real lights on a live customer site**. Confirm with the user before any
> broadcast/all-lights action. Keep stimuli small and reversible. Don't run destructive or
> rapid-fire sequences.

---

## 1. Purpose / outcome
Produce, from live data:
- a **command → effect matrix** (what each writable control actually changes),
- a **latency profile** per control type (publish → feedback reflects it),
- a confirmed list of **which controls to expose** as writable and which feedback fields
  carry signal vs noise,
- a finding on **per-device control** (does a per-device set topic exist?),
- concrete adapter-logic refinements (write-on-change, field relevance, named channels).

## 2. Context (where we are)
- Adapter `ioBroker.casambi-lithernet`, branch `feat/mqtt-integration`, **v0.3.0**.
- The adapter runs an embedded MQTT broker (aedes 0.51) on **port 3791**; the gateway
  connects to it as a client (`Bridge ID 0`, topics `casambi/0/...`).
- **Proven already (live):** broadcast on/off (`set/level`), scene recall 1–21
  (`set/scene_level`); feedback flows on `get/poll_*` once gateway Polling Method = active.
- **Confirmed feedback topics** (REV2.5 / fw 4.56):
  `poll_broadcast`, `poll_ungrouped`, `poll_scene/<N>`, `poll_group/<N>`,
  `poll_device/<N>/values`, `poll_device/<N>/propertys`, `node_deleted/`.
- Lab values: gateway IP `192.168.60.222`, ioBroker node `192.168.60.217`, node user
  `oikosadmin`. This site: 21 devices (16 online: 1-6,9-12,16-21 · offline 7,8,13,14,15),
  21 real scenes, groups TBD. Plain dimmable luminaires — **no colour/battery/sensor data**
  (those payload fields are always zero here).
- Poll cycle ≈ 22s with the current 100/100/21 counts → that's the feedback latency. Ask the
  user to **trim poll counts** (Scenes 21, Groups = real, Devices 21) for snappier/cleaner data.

## 3. Control / monitor scope — AGREE WITH USER BEFORE EXECUTING
**Controls (writable → `set/*`):**
| Control | Topic | Status |
|---|---|---|
| Broadcast (all lights) | `set/level` | proven |
| Scene level / recall | `set/scene_level` | proven |
| Group level | `set/group_level` | confirm |
| Lux sensor inject | `set/light_sensor` | test |
| PIR sensor inject | `set/pir_sensor` | test |
| Button inject | `set/button_level`, `set/push_button_pressed|released` | test |
| Per-device level | (unknown) | discover |

**Monitor (read ← `poll_*`):** broadcast, ungrouped, scenes (`active`,`level`), groups
(`level`,…), devices (`level`,`last_level`,`online`,`node_type`,`condition`). Treat the
always-zero colour/battery/fault fields as noise on this site but keep them in code for other
installs. `last_change` is a global heartbeat — use value deltas for change detection.

→ Confirm with the user which of the "test/discover" items they want included this session.

## 4. Prerequisites / setup
1. **Tunnel** (user runs from their Mac; pick a fresh local port if one is stuck):
   `ssh -L 14883:127.0.0.1:3791 oikosadmin@<node-host>` — maps `localhost:14883` → broker.
2. **MQTT client tooling** (recreate; not committed):
   `mkdir -p /tmp/casambi-snoop && npm install --prefix /tmp/casambi-snoop mqtt`
   Subscriber connects `mqtt://127.0.0.1:<localport>`, subscribes `#`, logs
   `<ISO-ts>\t<topic>\t<payload>` to a file. Publisher publishes `casambi/0/set/<...>`.
3. Gateway **Polling Method = active** (already set). Ideally counts trimmed (Section 2).
4. Optional: deploy v0.3.0 to the node (`iobroker url "DrozmotiX/ioBroker.casambi-lithernet#feat/mqtt-integration"` + restart) to cross-check that the adapter's states move as expected.

## 5. Phased execution (stimulus → listen → analyse, one phase at a time)
For **every** stimulus: write a marker line to the capture (`MARKER <ts> <what-we-sent>`),
publish, then **listen ≥1.5 poll cycles** before reading. For each phase record: what was
sent (topic+payload+time), which entities/fields changed, and **latency** (Δt publish→feedback).

- **A — Baseline (1–2 min idle):** confirm steady state, capture the cycle period.
- **B — Broadcast:** `set/level {level:254}` → wait → `{level:0}`. Record which devices flip,
  `poll_broadcast.level` trend, latency. (Confirm with user — affects all lights.)
- **C — Scenes:** recall 2–3 scenes individually (e.g. 1, 5, 10) at a level. Record
  `poll_scene/<n>.active`+`level` and which devices/groups react; latency.
- **D — Groups:** set one group level (`set/group_level {group:N,level:..}`). Confirm group
  control + `poll_group/<N>` reflects it.
- **E — Sensors (if in scope):** inject `set/light_sensor {lux_level:..}` and
  `set/pir_sensor {pir_sensor:1}`; observe whether anything reacts or echoes.
- **F — Buttons (if in scope):** inject `set/push_button_pressed {button:N}` /
  `released`; observe effect.
- **G — Per-device control (discovery, if in scope):** with the user's OK on one safe online
  device, try candidate topics/fields (e.g. `set/level` with an added `id`/`unit`/`device`
  field, or a `set/device_level`) and watch whether exactly that device's
  `poll_device/<N>/values.level` moves. Stop at first that works; note it.

## 6. Analysis & deliverables
After the phases, produce: the command→effect matrix, latency table, the confirmed
control/monitor model, the per-device-control finding, and a short list of adapter-logic
changes to implement (write-on-change, field relevance, anything new discovered). Update
`TODO.md` accordingly. Save the raw capture + a deduped/structured summary for the record.

## 7. New-session kickoff
The new session should: (1) read this file + `TODO.md`, (2) confirm Section 3 scope with the
user, (3) ask the user to open the tunnel and give the local port, (4) set up the MQTT client,
(5) run phases A→ (agreed subset), pausing to analyse and report between phases, (6) summarise
and update `TODO.md`. Keep all stimuli user-confirmed and reversible.
