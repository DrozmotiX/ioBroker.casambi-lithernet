#!/usr/bin/env bash
#
# Casambi-bt playground — run the interactive script.
# Requires ./setup.sh to have been run once.
#
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
    echo "!! .venv not found — run  ./setup.sh  first." >&2
    exit 1
fi

# shellcheck disable=SC1091
. .venv/bin/activate
exec python play.py
