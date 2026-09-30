#!/usr/bin/env bash
# ==============================================================================
# Installiert die neueste Version der GNOME Shell Extension 'Ubuntu Maintenance'
# aus den GitHub-Releases (Prüfsumme wird geprüft, läuft ohne root).
#
#   curl -fsSLO https://raw.githubusercontent.com/joeMJ/ubuntu-maintenance-extension/main/install-remote.sh
#   less install-remote.sh      # erst lesen
#   bash install-remote.sh
#
# Hinweis: Die Prüfsumme liegt im selben Release und erkennt Übertragungsfehler,
# schützt aber nicht vor einem kompromittierten GitHub-Konto.
# ==============================================================================
set -euo pipefail

REPO="joeMJ/ubuntu-maintenance-extension"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for c in curl tar sha256sum; do
    command -v "$c" >/dev/null || { echo "Fehlt: $c" >&2; exit 1; }
done

# Neuesten Tag über den Redirect von /releases/latest ermitteln (kein API-Token nötig)
final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
TAG="${final##*/}"
[[ "$TAG" =~ ^v[0-9]+(\.[0-9]+){0,2}$ ]] || { echo "Kein Release gefunden oder unerwarteter Tag: '$TAG'" >&2; exit 1; }

ASSET="ubuntu-maintenance-extension-$TAG.tar.gz"
BASE="https://github.com/$REPO/releases/download/$TAG"
echo "Lade $TAG ..."
curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fsSL -o "$TMP/$ASSET.sha256" "$BASE/$ASSET.sha256"

( cd "$TMP" && sha256sum -c "$ASSET.sha256" ) || { echo "Prüfsumme stimmt nicht, Abbruch." >&2; exit 2; }

if tar -tzf "$TMP/$ASSET" | grep -qE '(^/|(^|/)\.\.(/|$))'; then
    echo "Unsichere Pfade im Archiv, Abbruch." >&2; exit 3
fi
tar -xzf "$TMP/$ASSET" -C "$TMP" --no-same-owner
DIR="$TMP/ubuntu-maintenance-extension-$TAG"
[ -x "$DIR/gnomeextension/install.sh" ] || { echo "install.sh fehlt im Archiv." >&2; exit 3; }

echo "Starte install.sh (Benutzerrechte) ..."
bash "$DIR/gnomeextension/install.sh"
