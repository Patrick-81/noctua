#!/bin/sh
# =============================================================================
# Noctua — installation en une ligne (Linux / macOS)
#
#   curl -fsSL https://raw.githubusercontent.com/Patrick-81/noctua/master/get.sh | sh
#
# Options (env ou arguments) :
#   --dir <chemin>     répertoire d'installation   (NOCTUA_DIR,     défaut ~/noctua)
#   --branch <nom>     branche à installer         (NOCTUA_BRANCH,  défaut master)
#   --repo <url>       dépôt git                   (NOCTUA_REPO,    défaut GitHub)
#   --dev              installe aussi requirements-dev.txt
#   --run              lance Noctua à la fin de l'installation
#
# Le script clone (ou met à jour) le dépôt, puis exécute install.sh.
# Il ne lit jamais stdin : sûr en `curl | sh`.
# =============================================================================
set -eu

REPO_URL="${NOCTUA_REPO:-https://github.com/Patrick-81/noctua.git}"
BRANCH="${NOCTUA_BRANCH:-master}"
DIR="${NOCTUA_DIR:-$HOME/noctua}"
PYTHON="${NOCTUA_PYTHON:-python3}"
DO_DEV=0
DO_RUN=0

usage() {
    sed -n '2,17p' "$0" 2>/dev/null || printf '%s\n' "Noctua installer — voir README.md"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)      DIR="$2"; shift 2 ;;
        --dir=*)    DIR="${1#*=}"; shift ;;
        --branch)   BRANCH="$2"; shift 2 ;;
        --branch=*) BRANCH="${1#*=}"; shift ;;
        --repo)     REPO_URL="$2"; shift 2 ;;
        --repo=*)   REPO_URL="${1#*=}"; shift ;;
        --dev)      DO_DEV=1; shift ;;
        --run)      DO_RUN=1; shift ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "✗ Option inconnue : $1" >&2; usage; exit 1 ;;
    esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── 0. Sommes-nous déjà dans le dépôt (get.sh local) ? ───────────────────────
LOCAL_REPO=0
SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0" 2>/dev/null || echo .)" 2>/dev/null && pwd || echo .)"
if [ -f "$SELF_DIR/install.sh" ] && [ -f "$SELF_DIR/run.py" ]; then
    DIR="$SELF_DIR"
    LOCAL_REPO=1
    say "• Dépôt Noctua détecté : $DIR"
fi

# ── 1. Prérequis : Python 3.10+ ───────────────────────────────────────────────
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    fail "Python introuvable ($PYTHON).
  Ubuntu/Debian : sudo apt install python3 python3-venv python3-pip
  Fedora        : sudo dnf install python3 python3-pip
  macOS         : brew install python3"
fi
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    fail "Python 3.10+ requis (détecté : $("$PYTHON" --version 2>&1))."
fi
say "✔ $("$PYTHON" --version 2>&1)"

# venv disponible ?
if ! "$PYTHON" -c 'import venv' 2>/dev/null; then
    fail "Le module venv est absent.
  Ubuntu/Debian : sudo apt install python3-venv"
fi

# ── 2. Récupération du code ───────────────────────────────────────────────────
fetch_repo() {
    if [ -d "$DIR/.git" ]; then
        say "• Mise à jour de $DIR (branche $BRANCH)…"
        git -C "$DIR" fetch --depth 1 origin "$BRANCH"
        git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
    else
        say "• Clonage de $REPO_URL → $DIR (branche $BRANCH)…"
        mkdir -p "$(dirname "$DIR")"
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DIR"
    fi
}

fetch_tarball() {
    # Repli sans git : archive de branche GitHub.
    slug="${REPO_URL%.git}"
    slug="${slug#*://}"
    slug="${slug#*@}"
    slug="${slug#*/}"
    url="https://github.com/${slug}/archive/refs/heads/${BRANCH}.tar.gz"
    tmp="$(mktemp -d 2>/dev/null || echo "$DIR.tmp")"
    say "• Téléchargement de $url…"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" | tar -xz -C "$tmp" || fail "Téléchargement impossible : $url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$url" | tar -xz -C "$tmp" || fail "Téléchargement impossible : $url"
    else
        fail "Ni git, ni curl, ni wget disponibles. Installez git puis relancez."
    fi
    src="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
    [ -n "$src" ] || fail "Archive invalide."
    mkdir -p "$(dirname "$DIR")"
    rm -rf "$DIR"
    mv "$src" "$DIR"
    rm -rf "$tmp"
}

if [ -d "$DIR/.git" ]; then
    fetch_repo
elif [ "$LOCAL_REPO" = 1 ]; then
    say "• Dépôt local (sans .git) — pas de mise à jour du code."
elif command -v git >/dev/null 2>&1; then
    fetch_repo
else
    say "• git absent — repli sur l'archive GitHub."
    fetch_tarball
fi

[ -f "$DIR/install.sh" ] || fail "install.sh introuvable dans $DIR."
[ -f "$DIR/run.py" ]     || fail "run.py introuvable dans $DIR."

# ── 3. Installation (venv + dépendances + config) ────────────────────────────
say "• Installation des dépendances…"
if [ "$DO_DEV" = 1 ]; then
    bash "$DIR/install.sh" --dev </dev/null
else
    bash "$DIR/install.sh" </dev/null
fi

say ""
say "✔ Noctua est installé dans $DIR"

# ── 4. Lancement (optionnel) ─────────────────────────────────────────────────
if [ "$DO_RUN" = 1 ]; then
    say "• Démarrage de Noctua (Ctrl+C pour arrêter)…"
    exec bash "$DIR/start.sh" </dev/null
fi

say "  Démarrer :   $DIR/start.sh"
say "  Interface :  http://localhost:8080"
say ""
say "  INDIGO (indigo_server, port 7624) doit être joignable ;"
say "  pour tester sans matériel : $DIR/start-mock-server.sh"
