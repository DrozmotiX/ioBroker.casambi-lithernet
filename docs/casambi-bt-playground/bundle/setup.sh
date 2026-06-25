#!/usr/bin/env bash
#
# Casambi-bt playground — one-shot setup.
# Run once after extracting the bundle on the Pi.
#
#   ./setup.sh              # Evolution firmware (default)
#   ./setup.sh --classic    # Classic / legacy firmware
#
set -euo pipefail
cd "$(dirname "$0")"

PKG="casambi-bt"
if [ "${1:-}" = "--classic" ]; then
    PKG="casambi-bt-revamped"
    echo ">> Classic firmware mode -> installing $PKG"
else
    echo ">> Evolution firmware mode (default) -> installing $PKG"
    echo "   (re-run with  ./setup.sh --classic  if your network is Classic/legacy)"
fi
echo

# --- sanity: bluetooth ---------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet bluetooth; then
        echo ">> Bluetooth service: active"
    else
        echo "!! Bluetooth service not active. Start it with:"
        echo "     sudo systemctl start bluetooth"
    fi
fi

# --- prerequisites -------------------------------------------------------
for bin in python3 git; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "!! Missing '$bin'. Install with:  sudo apt install -y python3 python3-venv python3-pip bluez git" >&2
        exit 1
    fi
done

# --- clone upstream lib (for reference + demo.py) ------------------------
echo ">> Fetching upstream casambi-bt (reference + demo.py)..."
if [ -d casambi-bt/.git ]; then
    git -C casambi-bt pull --ff-only || true
else
    git clone https://github.com/lkempf/casambi-bt.git
fi

# --- venv + install ------------------------------------------------------
echo ">> Creating virtualenv (.venv)..."
python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate

echo ">> Installing $PKG (pulls in bleak)..."
pip install --quiet --upgrade pip
pip install --quiet "$PKG"

echo
echo ">> Setup complete. Next:"
echo "     ./run.sh"
echo
echo "   Have your Casambi NETWORK password ready (not your account login)."
echo "   The first connect needs internet (one-time key fetch from the cloud)."
