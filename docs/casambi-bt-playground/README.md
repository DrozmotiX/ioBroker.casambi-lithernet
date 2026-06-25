# Casambi direct-BLE playground (Raspberry Pi)

A throwaway experiment: drive a Casambi lighting mesh **directly over Bluetooth LE** from a
spare Raspberry Pi using the reverse-engineered [`casambi-bt`](https://github.com/lkempf/casambi-bt)
library — **no cloud gateway, no Lithernet box, no adapter integration**.

Goal of this round: prove the Pi can *discover the network, list units/groups/scenes, and drive
the lights*. If that works, we later decide whether to wrap it in an MQTT shim for the
ioBroker adapter. **Nothing here gets copied into the adapter repo** — this stays a local
playground; the library is **cloned/installed at runtime on the Pi**, not vendored.

---

## ⚠️ What this is (and isn't)

- **Unofficial & reverse-engineered.** Not associated with Casambi. Breaks when Casambi ships
  firmware/protocol changes — expect to occasionally `pip install -U`.
- **Local control, one cloud touch.** First `connect()` fetches the network's encryption keys
  from the Casambi cloud once → the Pi needs **internet on first run**. Control afterwards is
  local BLE.
- **Range-bound.** The Pi must be **physically within Bluetooth range** of the mesh.
- **One connection slot.** The mesh accepts only a few simultaneous connections and the lib
  holds **one**. Don't have the phone app actively connected to the same network while testing.
- **Linux only.** macOS does **not** work (it doesn't expose the BT MAC). Pi/BlueZ is the right
  platform.

---

## 0. Check two things in the Casambi app first

1. **Firmware type** — open your network → note **Evolution** vs **Classic**.
   - Evolution → use `casambi-bt` (default below).
   - Classic (legacy) → use `casambi-bt-revamped` instead (same API).
2. **Network password** — Settings → the network → sharing/password. You need this. It is the
   *network* password, **not** your Casambi account login.

---

## 1. Raspberry Pi prep

Any Pi with BLE works (3 / 4 / Zero 2 W). Onboard BT is fine to start; add a USB BLE dongle
later if range is flaky.

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y python3 python3-venv python3-pip bluez git

# sanity check: BlueZ should see the adapter
bluetoothctl show

# make sure the bluetooth service is running
sudo systemctl status bluetooth

# allow your user to use BT without sudo (re-login after this)
sudo usermod -aG bluetooth "$USER"
```

---

## 2. Get the library (clone + install at runtime — not vendored)

```bash
mkdir -p ~/casambi-play && cd ~/casambi-play

# clone the UPSTREAM library locally (ships its own example `demo.py`); we do NOT commit this anywhere.
# NOTE: this clone does NOT contain our `play.py` — that lives in this docs folder; see step 3.
git clone https://github.com/lkempf/casambi-bt.git

python3 -m venv .venv
source .venv/bin/activate

# Evolution firmware:
pip install casambi-bt

# --- OR --- Classic (legacy) firmware:
# pip install casambi-bt-revamped
```

To update later when Casambi changes something:

```bash
cd ~/casambi-play && source .venv/bin/activate
pip install -U casambi-bt        # or casambi-bt-revamped
cd casambi-bt && git pull        # refresh the cloned reference/demo
```

---

## 3. Playground script

> **Note:** cloning `casambi-bt` in step 2 only gives you the **upstream library**, whose
> example is named **`demo.py`** (at `~/casambi-play/casambi-bt/demo.py`). The `play.py` below
> is *our own* script and lives in **this** repo (`docs/casambi-bt-playground/play.py`) — it is
> **not** in the cloned library. On the Pi, either create it with the heredoc below, or just run
> the upstream `demo.py` (see [3b](#3b-shortcut--use-the-upstream-demo)).

Create it on the Pi by pasting this whole block (the quoted `'PYEOF'` stops the shell from
expanding `$`/`{}`):

```bash
cat > ~/casambi-play/play.py <<'PYEOF'
import asyncio
import logging
from CasambiBt import Casambi, discover

logging.basicConfig(level=logging.INFO)


async def main():
    print("Scanning for Casambi networks...")
    devices = await discover()
    if not devices:
        print("No networks found. Move the Pi closer / check the dongle.")
        return

    for i, d in enumerate(devices):
        print(f"[{i}] {d.address}")
    idx = int(input("Pick network index: "))
    device = devices[idx]

    pwd = input("Network password: ")

    casa = Casambi()
    try:
        await casa.connect(device, pwd)
        print("Connected!\n")

        print("UNITS:")
        for u in casa.units:
            print("  ", u)
        print("GROUPS:")
        for g in casa.groups:
            print("  ", g)
        print("SCENES:")
        for s in casa.scenes:
            print("  ", s)

        await casa.turnOn(None)         # None = all units
        await asyncio.sleep(2)
        await casa.setLevel(None, 128)  # ~50% brightness (0-255)
        await asyncio.sleep(2)
        await casa.setLevel(None, 0)    # all off
    finally:
        await casa.disconnect()


asyncio.run(main())
PYEOF
```

For reference, the same script (with extra commented-out per-unit / scene examples) is committed
alongside this README:

```python
import asyncio
import logging
from CasambiBt import Casambi, discover

logging.basicConfig(level=logging.INFO)

async def main():
    # 1. Find Casambi networks in BLE range
    print("Scanning for Casambi networks...")
    devices = await discover()
    if not devices:
        print("No networks found. Move the Pi closer / check the dongle.")
        return

    for i, d in enumerate(devices):
        print(f"[{i}] {d.address}")
    idx = int(input("Pick network index: "))
    device = devices[idx]

    pwd = input("Network password: ")

    casa = Casambi()
    try:
        # 2. Connect (touches Casambi cloud ONCE for keys, then local BLE)
        await casa.connect(device, pwd)
        print("Connected!\n")

        # 3. Inspect what's on the mesh
        print("UNITS:")
        for u in casa.units:
            print("  ", u)
        print("GROUPS:")
        for g in casa.groups:
            print("  ", g)
        print("SCENES:")
        for s in casa.scenes:
            print("  ", s)

        # 4. Drive the lights
        await casa.turnOn(None)         # None = all units
        await asyncio.sleep(2)
        await casa.setLevel(None, 128)  # ~50% brightness (0–255)
        await asyncio.sleep(2)

        # per-unit:
        # await casa.setLevel(casa.units[0], 255)

        # a scene:
        # await casa.switchToScene(casa.scenes[0])

        await casa.setLevel(None, 0)    # all off
    finally:
        await casa.disconnect()

asyncio.run(main())
```

Run it:

```bash
cd ~/casambi-play && source .venv/bin/activate
python play.py
```

### 3b. Shortcut — use the upstream demo

If you'd rather not create a file, the cloned library already ships an equivalent example:

```bash
cd ~/casambi-play && source .venv/bin/activate
python casambi-bt/demo.py        # add -d for debug logging
```

Quick check that the files you expect are actually present:

```bash
ls ~/casambi-play/casambi-bt/demo.py   # always there after the clone
ls ~/casambi-play/play.py              # only there if you ran the heredoc above
```

---

## 4. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Permission / adapter errors on connect | `bluetooth` service up? user in `bluetooth` group (re-login)? test once with `sudo` to rule out perms. |
| "No networks found" | Range / weak onboard BT. Get closer, use a USB BLE dongle. Verify scan: `bluetoothctl` → `scan on`. |
| Connect hangs / desyncs | Mesh connection slot taken — close the Casambi phone app / detach other gateways from this network while testing. |
| First connect fails (cloud/key error) | Pi needs internet on first run; confirm you used the **network** password, not the account login. |
| Worked yesterday, broke today | Casambi likely pushed firmware → `pip install -U casambi-bt` (and `git pull` the clone). |

---

## API quick reference

| Call | Does |
| --- | --- |
| `await discover()` | list Casambi networks in BLE range |
| `await casa.connect(device, pwd)` | authenticate + bind to the mesh |
| `casa.units` / `casa.groups` / `casa.scenes` | inventory |
| `await casa.turnOn(target)` / `await casa.turnOff(target)` | on/off (`None` = all) |
| `await casa.setLevel(target, 0–255)` | brightness |
| `await casa.switchToScene(scene)` | activate a scene |
| `await casa.disconnect()` | release the connection slot |

---

## Next step (not now)

If discovery + control work: wrap `casambi-bt` in a small Python→MQTT shim that speaks the
**same topic shape** as the existing `casambi-lithernet` ioBroker adapter, so the DIY Pi gateway
becomes a drop-in alternative to the commercial box. That work lives in its own service — **not**
copied into the adapter repo.

## Sources

- <https://github.com/lkempf/casambi-bt> — library + `demo.py`
- <https://pypi.org/project/casambi-bt/> — PyPI (Evolution)
- <https://pypi.org/project/casambi-bt-revamped/> — Classic-firmware fork
