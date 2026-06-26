# Control & state synchronisation

[← back to README](../README.md)

Switching a luminaire is a **two-step round-trip on two separate channels** — the control
goes out as a scene recall, and the confirmation comes back as a real readback from the
Casambi mesh. The light's reported state is therefore *measured*, never an optimistic echo of
the command.

1. **Write — command, `ack:false` (control via scene).** You set `devices.<address>.on` (or
   `.level`). The adapter translates it to an MQTT `set/scene_level` recall of that device's
   **control scene** (single-member scene; there is no per-device set topic) and publishes it to
   the gateway, which recalls the scene on the mesh. The written state stays `ack:false` — the
   adapter does **not** echo the command.
2. **Readback — confirmation, `ack:true` (state from MQTT).** The gateway observes the mesh
   change and pushes `get/poll_device/<N>/values`; the adapter writes the real achieved
   `devices.<address>.level`/`.on` with **`ack:true`**. So `ack:true` always means
   *mesh-confirmed state*, read back over MQTT — not a confirmation of your write.

**It is a direct push (in `passive` polling mode).** Passive listens to the Casambi BLE
advertisements and pushes `poll_device/values` **on change**, event-driven, no request needed —
so the confirmation lands in **~0.4–1.5 s** (measured ~0.4 s). In `active` mode the same
confirmation would instead arrive on the cyclic poll (~20 s), not as a push, so **`passive` is
recommended** for snappy feedback.

**What to watch:** the **device** states `devices.<address>.level` / `.on` (with `ack:true`) —
*not* `scenes.<n>.active`. A single-member control scene recalled programmatically does **not**
flip its `active` flag, so scene `active` is not a reliable "did it switch" signal; the device
readback is.

This split is deliberate — scenes are the **hands** (write/control), the per-device MQTT
readback is the **eyes** (confirmed state). They are independent channels, which is exactly why
the reported state stays trustworthy even though control happens via a scene. A downstream
consumer (e.g. an alias' *Current*) should bind to the `ack:true` device states.

**Source-independent state.** Because the readback reflects the *mesh*, the reported state is
correct no matter **how** the light was changed — the Casambi app, a wall switch, a KNX/Casambi
bridge, another scene, or this adapter. And since control is an **absolute** scene recall (`on` =
recall at full, `off` = recall at level 0), a command always lands correctly regardless of the
prior state: if a light is on and you send `off`, it turns off. There is no toggle and no need to
know the previous state.

## Setting up per-device control

Per-device control is **scene-only** (the gateway has no per-device set topic), so each
controllable device needs **one single-member scene** — a Casambi scene whose only member is
that device.

1. **Create one single-member scene per device** in the **Casambi app** (a scene that contains
   exactly that one luminaire/relay). Naming it clearly (e.g. `_LivingRoom-Spot`) makes the next
   step easier.
2. **Sync the cloud catalog** (Cloud tab / `control.syncNow`). The adapter discovers each
   device's candidate control scenes.
3. **Assign the control scene:**
   - A device with **exactly one** single-member scene is mapped **automatically** — its
     `devices.<address>.level`/`.on` become writable immediately.
   - A device with **several** candidate scenes stays read-only until you choose one: open
     **Objects → `casambi-lithernet.<instance>.devices.<address>`** and set the
     **`controlSceneSelect`** dropdown to the right scene (by name). The choice applies
     instantly and survives restarts. `info.devicesNeedingControlScene` lists everything still
     awaiting a choice.
4. **Control** the device by writing `devices.<address>.on` (or `.level`). The write recalls the
   assigned scene; the confirmed state comes back on the device states (see above).
   `devices.<address>.controlScene` shows which scene currently controls each device (`null` =
   unresolved/uncontrollable).

> A control scene **must be single-member** so a write only affects that one device. The adapter
> only offers single-member scenes as candidates for exactly this reason.

## Casambi network setup convention (scenes, switches & buttons)

To integrate cleanly, **keep the Casambi network minimal and put grouping, multi-device scenes,
mood scenes, schedules and automation logic in Oikos/ioBroker** — Oikos then drives each Casambi
device through its own control scene. Overlapping Casambi scenes are what cause the awkward cases
(a foreign scene "winning", an off not taking, or a device's state going stale), so the less the
Casambi network decides on its own, the better.

Two things **must** still live in Casambi:

1. **One single-member control scene per controllable device** — this is mandatory, it is the only
   way the gateway lets the adapter control or read a single unit (no per-unit set topic). See
   [Setting up per-device control](#setting-up-per-device-control).
2. **The minimum scenes a physical multi-device button needs.** A wall button has to be bound to
   something Casambi-side, and the adapter cannot yet read raw button presses over MQTT, so a button
   that switches several luminaires still needs a multi-device Casambi scene. The adapter *handles*
   these overlaps (it grabs a load onto its own control scene before switching it off, and derives
   on/off from the active scene), but keep them to the minimum.

### Switches / relays — scene-only, one scene

A **relay/switch unit behaves differently from a dimmer**. It keeps `level` at **0** and signals
its state **only through the scene it follows** — so `on` is derived as **`level > 0` OR an active
scene** (`scene > 0`). Consequences for setup:

- **Drive a switch only via its single control scene — never by toggling the unit directly.** A
  *direct* relay toggle is **invisible over MQTT** in passive mode (the gateway reports `scene=0,
  level=0` whether the relay is on or off); only a *scene-driven* change is observable.
- **Assign a switch to exactly one single-member control scene.** With one scene, `scene = N` means
  on and `scene = 0` (deactivated) means off — unambiguous. The case that would *break* this is a
  switch that is a **member of a scene which turns it off**: recalling that scene makes the unit
  follow it (`scene > 0`) while it is physically off, so it would be mis-read as on. One control
  scene plus "off = scene deactivation" avoids that entirely.

> **Rule of thumb:** in Casambi build only (a) one single-member control scene per device and
> (b) the minimum scenes physical multi-device buttons require. Everything else — groups, scenes,
> schedules, automations — belongs in Oikos. Switches are scene-only, one scene each.
