#!/bin/bash
# Start INDIGO Devices server
# Usage: ./start.sh [indigo_host:port] [--port 8080]
cd "$(dirname "$0")"
if [ -d ".venv" ]; then
    source .venv/bin/activate
else
    source venv/bin/activate
fi
exec "$VIRTUAL_ENV/bin/python3" run.py "$@"