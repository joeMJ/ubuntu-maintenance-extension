#!/usr/bin/env bash
# ==============================================================================
# Installer für Ubuntu Maintenance GNOME Shell Extension
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

echo -e "${CYAN}=== Installation der GNOME Shell Extension '$UUID' ===${NC}"

# 1. Schemas kompilieren
echo -e "${CYAN}Kompiliere GSettings-Schemas...${NC}"
glib-compile-schemas "$SCRIPT_DIR/schemas"

# 2. Zielverzeichnis anlegen
echo -e "${CYAN}Installiere nach $TARGET_DIR...${NC}"
mkdir -p "$TARGET_DIR"

# 3. Dateien kopieren
# Wichtig: Eine laufende GNOME Shell hat Dateien dieser Extension geladen (JS-Module,
# gschemas.compiled per mmap). Niemals an Ort und Stelle ueberschreiben (cp auf eine
# bestehende Datei behaelt die Inode und aendert den Inhalt unter der Shell weg ->
# GLib-Abbruch 'Settings schema ... does not contain a key'). Stattdessen in eine
# Temp-Datei kopieren und per mv ersetzen: die Shell behaelt die alte, intakte Datei.
install_file() {
    local src="$1" dst="$2" tmp
    tmp="${dst}.new.$$"
    cp -f "$src" "$tmp" && mv -f "$tmp" "$dst"
}
for f in metadata.json extension.js stylesheet.css prefs.js updater.js startup.js \
         maintenance_backend.py selfupdate.py; do
    install_file "$SCRIPT_DIR/$f" "$TARGET_DIR/$f"
done
chmod +x "$TARGET_DIR/maintenance_backend.py" "$TARGET_DIR/selfupdate.py"

# Schema: nur die XML kopieren, gschemas.compiled schreibt glib-compile-schemas selbst
# (atomar per Umbenennen). Die kompilierte Datei aus dem Quellordner wird bewusst NICHT kopiert.
mkdir -p "$TARGET_DIR/schemas"
for x in "$SCRIPT_DIR/schemas/"*.xml; do
    install_file "$x" "$TARGET_DIR/schemas/$(basename "$x")"
done
glib-compile-schemas "$TARGET_DIR/schemas"

# User-weite GSettings-Schemas aktualisieren
mkdir -p "$HOME/.local/share/glib-2.0/schemas"
for x in "$SCRIPT_DIR/schemas/"*.xml; do
    install_file "$x" "$HOME/.local/share/glib-2.0/schemas/$(basename "$x")"
done
glib-compile-schemas "$HOME/.local/share/glib-2.0/schemas"

# Wartungsskript + Konfiguration (liegen im Repo-Stamm, eine Ebene über gnomeextension/)
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ubuntu-maintenance-indicator"
if [ -f "$SCRIPT_DIR/../ubuntumaintenance.sh" ]; then
    echo -e "${CYAN}Installiere Wartungsskript nach $DATA_DIR...${NC}"
    mkdir -p "$DATA_DIR"
    cp -f "$SCRIPT_DIR/../ubuntumaintenance.sh" "$DATA_DIR/"
    chmod +x "$DATA_DIR/ubuntumaintenance.sh"
    [ -f "$SCRIPT_DIR/../maintenance.json" ] && cp -f "$SCRIPT_DIR/../maintenance.json" "$DATA_DIR/"
else
    echo -e "${YELLOW}Hinweis: ubuntumaintenance.sh nicht gefunden (erwartet: $SCRIPT_DIR/..). Wartungsskript wird nicht installiert.${NC}"
fi

# 4. Alten AppIndicator-Dienst deaktivieren (falls aktiv)
if systemctl --user is-active --quiet ubuntu-maintenance-indicator.service 2>/dev/null; then
    echo -e "${YELLOW}Hinweis: Bisheriger AppIndicator-Service (Systemd) wird gestoppt und deaktiviert, um doppelte Icons zu vermeiden...${NC}"
    systemctl --user stop ubuntu-maintenance-indicator.service || true
    systemctl --user disable ubuntu-maintenance-indicator.service || true
fi

# 5. Extension aktivieren
echo -e "${CYAN}Aktiviere Extension in GNOME Shell...${NC}"
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
fi

# 6. Optional: AM (AppImage-Manager) beiinstallieren
#    Nur interaktiv, nur wenn 'am' fehlt; eine Ablehnung wird gemerkt (kein Nachfragen bei jedem Update).
AM_INSTALLER_URL="https://raw.githubusercontent.com/ivan-hc/AM/main/AM-INSTALLER"
AM_DECLINED_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/ubuntu-maintenance-indicator/am-declined"

install_am_optional() {
    if command -v am >/dev/null 2>&1; then
        echo -e "${CYAN}AM (AppImage-Manager) ist bereits installiert.${NC}"
        return 0
    fi
    [ -f "$AM_DECLINED_FILE" ] && return 0
    [ -t 0 ] && [ -t 1 ] || return 0

    # 'dpkg -s' meldet Erfolg auch für entfernte Pakete mit Konfigurationsrest (Status 'rc'); nur 'ii' zählt.
    if [ "$(dpkg-query -W -f='${db:Status-Abbrev}' appimagelauncher 2>/dev/null | cut -c1-2)" = "ii" ]; then
        echo -e "${YELLOW}Hinweis: AppImageLauncher (DEB) ist installiert. AM arbeitet damit nicht zusammen;"
        echo -e "bitte zuerst 'sudo apt remove appimagelauncher' ausführen und neu starten. AM wird übersprungen.${NC}"
        return 0
    fi

    echo -e "${CYAN}Optional: AM (AppImage-Manager) ermöglicht die AppImage-Update-Prüfung der Extension.${NC}"
    echo -e "Quelle: $AM_INSTALLER_URL (Drittprojekt, Installer läuft mit sudo)."
    read -r -p "AM jetzt installieren? [j/N] " answer
    case "$answer" in
        j|J|y|Y)
            local tmp
            tmp="$(mktemp)"
            if command -v wget >/dev/null 2>&1; then
                wget -q "$AM_INSTALLER_URL" -O "$tmp"
            else
                curl -fsSL "$AM_INSTALLER_URL" -o "$tmp"
            fi
            chmod +x "$tmp"
            "$tmp" || echo -e "${YELLOW}AM-Installation wurde nicht abgeschlossen.${NC}"
            rm -f "$tmp"
            ;;
        *)
            mkdir -p "$(dirname "$AM_DECLINED_FILE")"
            : > "$AM_DECLINED_FILE"
            echo -e "AM wird übersprungen. Später nachholen: Datei '$AM_DECLINED_FILE' löschen und install.sh erneut starten."
            ;;
    esac
}
install_am_optional || true

echo -e "${GREEN}✅ Installation erfolgreich abgeschlossen!${NC}"
echo -e "Die Extension '${UUID}' ist nun in GNOME aktiv."
echo -e "${YELLOW}Hinweis:${NC} Die laufende GNOME Shell nutzt noch den alten Code. Bitte melde dich bald ab und wieder an (unter X11: Alt+F2 -> r), bis dahin nicht im Extension-Menue klicken."
