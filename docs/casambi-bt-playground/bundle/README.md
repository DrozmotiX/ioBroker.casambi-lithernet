# Casambi-bt playground bundle — v1.0.0

Self-contained kit to drive a Casambi mesh **directly over Bluetooth LE** from a Raspberry Pi,
using the unofficial [`casambi-bt`](https://github.com/lkempf/casambi-bt) library. No cloud
gateway, no Lithernet box.

## Use it (on the Pi)

```bash
# 1. copy the zip to the Pi (from your workstation), e.g.:
#    scp casambi-bt-playground-v1.0.0.zip root@<pi>:~

# 2. on the Pi: extract into a folder
unzip casambi-bt-playground-v1.0.0.zip -d casambi-play
cd casambi-play

# 3. one-time setup (clones the upstream lib, makes a venv, installs casambi-bt)
./setup.sh                # Evolution firmware (default)
# ./setup.sh --classic    # use this instead for Classic / legacy networks

# 4. run it
./run.sh
```

`run.sh` scans for networks, asks you to pick one and enter the **network password**, then lists
units/groups/scenes and flashes the lights on → 50% → off.

### Get the network UUID (read-only, no lights touched)

To just read the **network UUID** and structure — e.g. for the adapter's **Cloud** tab — run
`getinfo.py` instead (after `./setup.sh`):

```bash
source .venv/bin/activate
python getinfo.py
```

It connects with the network password and prints a log line
`api.casambi.com/network/uuid/<UUID>` — that `<UUID>` is the short network id the adapter needs
(not the app's 128-bit iBeacon UUID). It never changes any light.

## Prerequisites

Already present on a standard Raspberry Pi OS, but if `setup.sh` complains:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip bluez git
```

The Pi must be **within Bluetooth range** of the mesh, and `bluetooth` service active
(`systemctl status bluetooth`).

## Notes / gotchas

- **Network password**, not your Casambi *account* login.
- **First connect needs internet** — `casambi-bt` fetches the network keys from the Casambi cloud
  once, then operates locally over BLE.
- **One connection slot** — close the Casambi phone app on that network while testing, or they
  fight over the single gateway connection.
- **Unofficial / reverse-engineered** — may break on Casambi firmware updates. To update later:
  `cd casambi-play && . .venv/bin/activate && pip install -U casambi-bt` (or `casambi-bt-revamped`).
- **macOS doesn't work** for this lib — Pi/Linux only.

## What's in the bundle

| file | purpose |
| --- | --- |
| `setup.sh` | one-time: clone upstream lib, create venv, install `casambi-bt` |
| `run.sh` | activate venv + run `play.py` |
| `play.py` | the interactive discover → connect → list → drive script |
| `VERSION` | bundle version |
| `README.md` | this file |

Full background, troubleshooting table and API reference live in the parent guide:
`docs/casambi-bt-playground/README.md` in the repo.
