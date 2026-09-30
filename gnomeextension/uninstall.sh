#!/usr/bin/env bash
# ==============================================================================
# Deinstalliert die GNOME Shell Extension 'Ubuntu Maintenance'
# UUID: ubuntu-maintenance@johnlose.de
#
#   ./uninstall.sh           entfernt Extension-Ordner und Wartungsskript,
#                            BEHÄLT Einstellungen (dconf), Ignoreliste und Log-Basislinie
#   ./uninstall.sh --purge   entfernt zusätzlich Einstellungen, Schema, Konfiguration,
#                            Zustands- und Log-Dateien (nach Rückfrage)
# ==============================================================================
set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

UUID="ubuntu-maintenance@johnlose.de"
SCHEMA_ID="org.gnome.shell.extensions.ubuntu-maintenance"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ubuntu-maintenance-indicator"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ubuntu-maintenance-indicator"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ubuntu-maintenance-indicator"
SCHEMA_XML="${XDG_DATA_HOME:-$HOME/.local/share}/glib-2.0/schemas/$SCHEMA_ID.gschema.xml"

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

echo -e "${CYAN}=== Deinstallation der GNOME Shell Extension '$UUID' ===${NC}"

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi

if [ -d "$EXT_DIR" ]; then
    rm -rf "$EXT_DIR"
    echo "Entfernt: $EXT_DIR"
fi
if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    echo "Entfernt: $DATA_DIR (Wartungsskript, maintenance.json)"
fi

if [ "$PURGE" -eq 1 ]; then
    echo -e "${YELLOW}--purge löscht außerdem:${NC}"
    echo "  - gespeicherte Einstellungen (dconf: /org/gnome/shell/extensions/ubuntu-maintenance/)"
    echo "  - $SCHEMA_XML"
    echo "  - $CONF_DIR (u. a. log_ignore.json)"
    echo "  - $STATE_DIR (u. a. log_seen.json, Logs, am-declined)"
    read -r -p "Wirklich alles löschen? [j/N] " ans
    case "$ans" in
        j|J|y|Y|ja|Ja)
            command -v dconf >/dev/null 2>&1 && dconf reset -f /org/gnome/shell/extensions/ubuntu-maintenance/ || true
            rm -f "$SCHEMA_XML"
            command -v glib-compile-schemas >/dev/null 2>&1 && glib-compile-schemas "$(dirname "$SCHEMA_XML")" 2>/dev/null || true
            rm -rf "$CONF_DIR" "$STATE_DIR"
            echo "Einstellungen und Benutzerdaten entfernt."
            ;;
        *)
            echo "Purge abgebrochen, Einstellungen bleiben erhalten."
            ;;
    esac
else
    echo -e "${CYAN}Einstellungen, Ignoreliste und Log-Basislinie bleiben erhalten (vollständig löschen: --purge).${NC}"
fi

echo -e "${GREEN}✅ Deinstallation abgeschlossen.${NC} Melde dich ggf. neu an, damit GNOME die Extension aus dem Speicher entlässt."
