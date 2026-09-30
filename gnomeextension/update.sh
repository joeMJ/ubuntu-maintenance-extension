#!/usr/bin/env bash
# ==============================================================================
# Updater für Ubuntu Maintenance GNOME Shell Extension
# UUID: ubuntu-maintenance@johnlose.de
# ==============================================================================
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="ubuntu-maintenance@johnlose.de"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo -e "${CYAN}=== Aktualisierung der GNOME Shell Extension '$UUID' ===${NC}"

# Optional Git Pull falls in Git-Repo
if [ -d "$SCRIPT_DIR/../.git" ]; then
    echo -e "${CYAN}Prüfe Git-Repository auf Aktualisierungen...${NC}"
    cd "$SCRIPT_DIR/.."
    git pull || echo -e "${YELLOW}Hinweis: git pull konnte nicht automatisch ausgeführt werden.${NC}"
    cd "$SCRIPT_DIR"
fi

# Neu installieren / kopieren
"$SCRIPT_DIR/install.sh"

# Extension neustarten
if command -v gnome-extensions >/dev/null 2>&1; then
    echo -e "${CYAN}Lade Extension neu...${NC}"
    gnome-extensions disable "$UUID" 2>/dev/null || true
    sleep 1
    gnome-extensions enable "$UUID" 2>/dev/null || true
fi

echo -e "${GREEN}✅ Aktualisierung auf neuesten Stand abgeschlossen!${NC}"
