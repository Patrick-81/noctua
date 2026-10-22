#!/bin/bash
# Start Noctua server
# Usage: ./start.sh [indi_host:port] [--port 8080]
#
# Si une instance tourne déjà (même port web ou process run.py),
# elle est arrêtée proprement avant de relancer — évite les doublons
# (deux serveurs sur 8080, WS/images qui partent à l'ancienne instance).
cd "$(dirname "$0")"

# ── Port web effectif : --port > config.yaml > 8080 ──────────────
WEB_PORT=""
for a in "$@"; do
    case "$a" in
        --port=*) WEB_PORT="${a#--port=}" ;;
        --port) _want_port=1 ;;
        *)
            if [ -n "${_want_port:-}" ]; then WEB_PORT="$a"; _want_port=""; fi
            ;;
    esac
done
if [ -z "$WEB_PORT" ] && [ -f config.yaml ]; then
    WEB_PORT=$(awk '/^web:/{f=1} f&&/port:/{print $2; exit}' config.yaml)
fi
WEB_PORT="${WEB_PORT:-8080}"

# ── PIDs de l'instance existante (hors ce shell) ──────────────────
PIDS=""
# 1) process python run.py (le serveur lui-même)
for p in $(pgrep -f "run\.py" 2>/dev/null); do
    [ "$p" != "$$" ] && PIDS="$PIDS $p"
done
# 2) process à l'écoute sur le port web (filet de sécurité)
if command -v lsof >/dev/null 2>&1; then
    for p in $(lsof -ti "TCP:${WEB_PORT}" -sTCP:LISTEN 2>/dev/null); do
        [ "$p" != "$$" ] && PIDS="$PIDS $p"
    done
fi
# Déduplique
PIDS=$(echo "$PIDS" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u | tr '\n' ' ')

if [ -n "$PIDS" ]; then
    echo "Arrêt de l'instance existante (PIDs:$PIDS, port $WEB_PORT)..."
    kill -TERM $PIDS 2>/dev/null
    # Attente sortie propre (max ~5 s)
    for _ in $(seq 1 10); do
        ALIVE=""
        for p in $PIDS; do
            kill -0 "$p" 2>/dev/null && ALIVE="$ALIVE $p"
        done
        [ -z "$ALIVE" ] && break
        sleep 0.5
    done
    # Forcé si récalcitrant
    for p in $PIDS; do
        if kill -0 "$p" 2>/dev/null; then
            echo "PID $p récalcitrant → kill -KILL"
            kill -KILL "$p" 2>/dev/null
        fi
    done
    sleep 0.5
    echo "Ancienne instance arrêtée."
fi

if [ -d ".venv" ]; then
    source .venv/bin/activate
else
    source venv/bin/activate
fi
exec "$VIRTUAL_ENV/bin/python3" run.py "$@"
