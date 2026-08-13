#!/usr/bin/env bash
# =============================================================================
# Noctua — Script d'installation (Linux / macOS)
# Usage : ./install.sh
#
# Ce script est conçu pour évoluer au fil des améliorations du projet.
# Il crée l'environnement Python, installe les dépendances et prépare la config.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
VENV_DIR=".venv"

# --- 1. Vérification de Python -----------------------------------------------
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "✗ Python introuvable ($PYTHON). Installez Python 3.10+ puis relancez." >&2
    exit 1
fi
if ! "$PYTHON" -c 'import sys; exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYVER="$("$PYTHON" -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')"
    echo "✗ Python $PYVER détecté, mais Python 3.10 ou plus récent est requis." >&2
    exit 1
fi
echo "✔ Python $("$PYTHON" --version)"

# --- 2. Environnement virtuel -------------------------------------------------
if [ -d "$VENV_DIR" ]; then
    echo "• Environnement virtuel $VENV_DIR déjà présent."
else
    echo "• Création de l'environnement virtuel $VENV_DIR…"
    "$PYTHON" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "• Mise à jour de pip…"
python -m pip install --upgrade pip --quiet

# --- 3. Dépendances ------------------------------------------------------------
echo "• Installation des dépendances (requirements.txt)…"
python -m pip install -r requirements.txt

# --- 4. Configuration -----------------------------------------------------------
if [ ! -f "config.yaml" ]; then
    echo "• Aucun config.yaml — copie du modèle config.example.yaml."
    cp config.example.yaml config.yaml
fi

echo
echo "✔ Installation terminée."
echo
echo "  Lancement :   ./start.sh [indigo_host:port]"
echo "  Serveur web : http://localhost:8080"
echo
echo "  INDIGO : le serveur indigo_server doit être accessible sur le réseau."
echo "  Pour tester sans matériel :  ./start-mock-server.sh"