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
