#!/bin/bash
# Start Mock INDIGO server with guide drift simulation
# Usage: ./start-mock-server.sh [options]
#
# Options:
#   --port PORT          Mock server port (default: 17624)
#   --drift-vel-x FLOAT  Guide drift velocity X pixels/frame (default: 3.0)
#   --drift-vel-y FLOAT  Guide drift velocity Y pixels/frame (default: 1.5)
#   --correction-strength FLOAT  Pixels per correction pulse (default: 8.0)
#   --no-drift           Disable drift (star stays centered)
#
# Example: ./start-mock-server.sh --drift-vel-x 5 --drift-vel-y 0
#
# Then in another terminal: python run.py 127.0.0.1:17624 --port 8080

cd "$(dirname "$0")"
source venv/bin/activate
exec "$VIRTUAL_ENV/bin/python" tests/mock_indigo.py "$@"
