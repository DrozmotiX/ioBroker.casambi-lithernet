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
        await casa.setLevel(None, 128)  # ~50% brightness (0-255)
        await asyncio.sleep(2)

        # per-unit:
        # await casa.setLevel(casa.units[0], 255)

        # a scene:
        # await casa.switchToScene(casa.scenes[0])

        await casa.setLevel(None, 0)    # all off
    finally:
        await casa.disconnect()


asyncio.run(main())
