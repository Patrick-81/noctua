#!/bin/bash
# debian/build-deb.sh — construit le .deb sans debhelper (fallback dpkg-deb)
# Usage: ./debian/build-deb.sh [/tmp/noctua_1.0.0-1_all.deb]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/noctua_1.0.0-1_all.deb}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "→ Construction .deb → $OUT (workdir $WORKDIR)"

mkdir -p "$WORKDIR/DEBIAN" "$WORKDIR/opt/noctua" "$WORKDIR/usr/bin" \
  "$WORKDIR/lib/systemd/system" "$WORKDIR/etc/noctua" "$WORKDIR/usr/share/doc/noctua"

# 1. copie sources (exclusions = git, venv, caches, configs perso)
tar --exclude='.git' --exclude='.github' --exclude='.claude' \
  --exclude='.venv' --exclude='venv' --exclude='venv_*' \
  --exclude='node_modules' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='.pytest_cache' --exclude='test-results' --exclude='backups' \
  --exclude='data/catalogs' --exclude='fake_fits' --exclude='debian' \
  --exclude='.gitignore' --exclude='.opencode' --exclude='.code-review-graph' \
  --exclude='config.yaml' --exclude='ui.yaml' --exclude='profiles.yaml' \
  --exclude='sequence_templates.yaml' \
  -cf - -C . . | tar -xf - -C "$WORKDIR/opt/noctua"

# 2. wrapper + service + config
install -m 0755 debian/noctua-wrapper "$WORKDIR/usr/bin/noctua"
install -m 0644 debian/noctua.service "$WORKDIR/lib/systemd/system/noctua.service"
install -m 0644 config.example.yaml "$WORKDIR/etc/noctua/config.yaml.example"
install -m 0644 README.md "$WORKDIR/usr/share/doc/noctua/README.md"
install -m 0644 LICENSE "$WORKDIR/usr/share/doc/noctua/copyright"

# 3. control + maintainer scripts
cat > "$WORKDIR/DEBIAN/control" <<'EOF'
Package: noctua
Version: 1.0.0-1
Section: science
Priority: optional
Architecture: all
Depends: python3 (>= 3.10), python3-venv, python3-pip
Maintainer: Noctua contributors <noctua@example.com>
Description: Interface web pour piloter des équipements astronomiques via INDIGO
 Noctua — FastAPI + Vanilla JS, monture/caméra/focuser/roue à filtres,
 autoguidage, séquences, stacking live, astrométrie. Installé sous
 /opt/noctua avec venv isolé, commande /usr/bin/noctua et service systemd.
EOF
install -m 0755 debian/postinst "$WORKDIR/DEBIAN/postinst"
install -m 0755 debian/prerm "$WORKDIR/DEBIAN/prerm"
install -m 0755 debian/postrm "$WORKDIR/DEBIAN/postrm"

# 4. droits
chmod -R go-w "$WORKDIR"
find "$WORKDIR" -type d -exec chmod 0755 {} \;
find "$WORKDIR/usr" -type f -exec chmod 0644 {} \;
chmod 0755 "$WORKDIR/usr/bin/noctua" "$WORKDIR/DEBIAN/postinst" "$WORKDIR/DEBIAN/prerm" "$WORKDIR/DEBIAN/postrm"
chmod 0644 "$WORKDIR/lib/systemd/system/noctua.service" "$WORKDIR/etc/noctua/config.yaml.example"

# 5. build
dpkg-deb --build "$WORKDIR" "$OUT"
echo "✔ .deb créé : $OUT ($(du -h "$OUT" | cut -f1))"
dpkg-deb --info "$OUT" | head -n 20
echo ""
echo "Install (test) : sudo dpkg -i $OUT && sudo apt-get install -f"
echo "Service       : sudo systemctl enable --now noctua && journalctl -u noctua -f"
