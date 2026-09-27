#!/bin/sh
# Local research only. Keep the service bound to this computer.
set -eu
cd "$(dirname "$0")"

if [ ! -f models/scut-prototype-v1/beauty_regressor.pt ]; then
  echo "Research weights are missing. Follow the download steps in service/README.md." >&2
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "Create service/.venv and install requirements-dev.txt first (see service/README.md)." >&2
  exit 1
fi

# Plain-HTTP localhost: use the separately named dev session cookie.
SESSION_COOKIE_SECURE=0 MODEL_DIR=models/scut-prototype-v1 exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
