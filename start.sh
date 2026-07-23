#!/bin/bash
# Start INDIGO Devices server
# Usage: ./start.sh [indigo_host:port] [--port 8080]
cd "$(dirname "$0")"
source venv/bin/activate
exec -a indigo-devices python3 run.py "$@"
