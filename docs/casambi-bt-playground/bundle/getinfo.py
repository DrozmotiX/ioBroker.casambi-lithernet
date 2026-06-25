"""
Get the Casambi network UUID + metadata (units/groups/scenes). NO lights touched.

Run after ./setup.sh:
    source .venv/bin/activate
    python getinfo.py

It scans over BLE, connects with the NETWORK password (the one-time connect touches the
Casambi cloud for keys), and prints the UUID and the full structure. Paste the output back.
"""

import asyncio
import logging
from CasambiBt import Casambi, discover

# The network UUID shows up in the cloud call the lib makes:
#   api.casambi.com/network/uuid/<UUID>
# So turn the lib's logging up enough to see it.
logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
logging.getLogger("CasambiBt").setLevel(logging.DEBUG)
logging.getLogger("httpx").setLevel(logging.INFO)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("bleak").setLevel(logging.WARNING)


def dump_attrs(o, indent="    "):
    for a in sorted(dir(o)):
        if a.startswith("__"):
            continue
        try:
            v = getattr(o, a)
        except Exception:
            continue
        if callable(v):
            continue
        print(f"{indent}{a} = {v!r}")


async def main():
    print("Scanning for Casambi networks (BLE)...")
    devices = await discover()
    if not devices:
        print("No Casambi networks in range. Move closer / check Bluetooth.")
        return
    for i, d in enumerate(devices):
        print(f"[{i}] {d.address}")
    idx = 0 if len(devices) == 1 else int(input("Pick network index: "))

    pwd = input("NETWORK password (not your account login): ")

    casa = Casambi()
    try:
        await casa.connect(devices[idx], pwd)
        print("\n*** CONNECTED ***")
        print(">>> Look above for a log line like  api.casambi.com/network/uuid/<UUID>  — that <UUID> is what we need.\n")

        # Also try to surface the UUID/id straight off the objects:
        print("=== casa attributes ===")
        dump_attrs(casa)
        net = getattr(casa, "_network", None)
        if net is not None:
            print("=== casa._network attributes ===")
            dump_attrs(net)

        print("\n=== UNITS ===")
        for u in casa.units:
            print("  ", u)
        print("=== GROUPS ===")
        for g in casa.groups:
            print("  ", g)
        print("=== SCENES ===")
        for s in casa.scenes:
            print("  ", s)
    finally:
        await casa.disconnect()


asyncio.run(main())
