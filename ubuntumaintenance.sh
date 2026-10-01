#!/usr/bin/env bash

set -u

# ==============================================================================
# 0. GLOBALE EINSTELLUNGEN & FARBEN
# ==============================================================================
CYAN='\033[1;36m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # Keine Farbe (Reset)

# Variablen für die Zusammenfassung
UPDATES_APT=0
UPDATES_FLATPAK=0
UPDATES_APPIMAGE=0
UPDATES_SNAP=0
SB_STATUS_SUMMARY="Unbekannt"
BAT_SOH_SUMMARY="Kein Akku vorhanden"
REBOOT_REQUIRED="Nein"
REBOOT_REASON=""
CLEVIS_WARNING="Nein"
LUKS_DEV=""
SEC_STATUS_SUMMARY="OK"

# ==============================================================================
# PARAMETER AUSWERTEN
# ==============================================================================
ASK_UPDATES=false
ENABLE_LOG=true

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --ask) ASK_UPDATES=true; shift ;;
        --nolog) ENABLE_LOG=false; shift ;;
        *) echo -e "${RED}Unbekannter Parameter: $1${NC}"; echo "Erlaubt sind: --ask, --nolog"; exit 1 ;;
    esac
done

# ==============================================================================
# LOGGING EINRICHTEN (30 Tage Limit)
# ==============================================================================
if [ "$ENABLE_LOG" = true ]; then
    LOG_DIR="$(dirname "$0")/maintenance_logs"
    mkdir -p "$LOG_DIR"
    
    find "$LOG_DIR" -name "maintenance_*.log" -type f -mtime +30 -exec rm -f {} \;
    LOG_FILE="$LOG_DIR/maintenance_$(date '+%Y-%m-%d_%H-%M-%S').log"
    
    exec 3>&1
    exec > >(tee -a "$LOG_FILE") 2>&1
else
    exec 3>&1
fi

# ==============================================================================
# SYSTEM- & UPGRADE-INFORMATIONEN FÜR HEADER ERMITTELN
# ==============================================================================
KERNEL_VER="$(uname -r)"

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-Ubuntu}"
    OS_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
else
    OS_NAME="$(lsb_release -ds 2>/dev/null || echo "Ubuntu")"
    OS_CODENAME="$(lsb_release -cs 2>/dev/null || echo "")"
fi

if command -v do-release-upgrade >/dev/null 2>&1; then
    RELEASE_CHECK_OUT=$(LC_ALL=C do-release-upgrade -c 2>&1)
    RELEASE_CHECK_EXIT=$?
    if [ $RELEASE_CHECK_EXIT -eq 0 ]; then
        NEW_VER=$(echo "$RELEASE_CHECK_OUT" | grep -i "New release" | sed -E "s/.*New release '([^']+)'.*/\1/")
        DO_RELEASE_STATUS="${GREEN}Verfügbar (${NEW_VER:-Neu})${NC}"
    else
        DO_RELEASE_STATUS="${YELLOW}Kein Upgrade verfügbar${NC}"
    fi
else
    DO_RELEASE_STATUS="${YELLOW}do-release-upgrade nicht vorhanden${NC}"
fi

META_CONTENT=$(wget -qO- --timeout=5 https://changelogs.ubuntu.com/meta-release-lts 2>/dev/null || true)
if [ -n "$META_CONTENT" ]; then
    META_INFO=$(echo "$META_CONTENT" | awk -v RS= -v current="$OS_CODENAME" '
    {
        dist=""; name=""; ver=""; supp=""
        n = split($0, lines, "\n")
        for (i = 1; i <= n; i++) {
            if (lines[i] ~ /^Dist: /) dist = substr(lines[i], 7)
            if (lines[i] ~ /^Name: /) name = substr(lines[i], 7)
            if (lines[i] ~ /^Version: /) ver = substr(lines[i], 10)
            if (lines[i] ~ /^Supported: /) supp = substr(lines[i], 12)
        }
        last_dist = dist; last_name = name; last_ver = ver; last_supp = supp
        if (found_current) {
            print dist "|" name "|" ver "|" supp
            found = 1
            exit
        }
        if (dist == current) {
            found_current = 1
        }
    }
    END {
        if (!found && !found_current && last_dist != "") {
            print last_dist "|" last_name "|" last_ver "|" last_supp
        }
    }')
else
    META_INFO=""
fi

if [ -n "$META_INFO" ]; then
    IFS="|" read -r NEXT_DIST NEXT_NAME NEXT_VER NEXT_SUPP <<< "$META_INFO"
    if [ "$NEXT_SUPP" = "1" ]; then
        NEXT_LTS_STATUS="${GREEN}${NEXT_VER} (${NEXT_DIST}) - Freigegeben (Supported: 1)${NC}"
    elif [ "$NEXT_SUPP" = "0" ]; then
        NEXT_LTS_STATUS="${YELLOW}${NEXT_VER} (${NEXT_DIST}) - Noch nicht freigegeben (Supported: 0)${NC}"
    else
        NEXT_LTS_STATUS="${NEXT_VER} (${NEXT_DIST})"
    fi
else
    if [ -z "$META_CONTENT" ]; then
        NEXT_LTS_STATUS="${RED}Prüfung nicht möglich (Offline / Timeout)${NC}"
    else
        NEXT_LTS_STATUS="${GREEN}Aktuellste LTS-Version installiert${NC}"
    fi
fi

# Lenovo-5G-Modem (Quectel RM520N-GL, 1eac:1007): FCC-Unlock/SAR nur über lenovo-wwan-unlock
# aus dem Lenovo-OEM-Repo. Upgrade erst sinnvoll, wenn es das Paket für das nächste LTS gibt.
WWAN_STATUS=""
if [ -n "${NEXT_DIST:-}" ] && lspci -d 1eac:1007 2>/dev/null | grep -q .; then
    LENOVO_ARCHIVE="http://lenovo.archive.canonical.com"
    WWAN_FOUND=""
    for d in $(wget -qO- --timeout=5 "$LENOVO_ARCHIVE/dists/" 2>/dev/null | grep -oE "${NEXT_DIST}-sutton[^/\"]*" | sort -u); do
        if wget -qO- --timeout=5 "$LENOVO_ARCHIVE/dists/${NEXT_DIST}/${d#${NEXT_DIST}-}/binary-amd64/Packages.gz" 2>/dev/null | zcat 2>/dev/null | grep -qx "Package: lenovo-wwan-unlock"; then
            WWAN_FOUND="$d"
            break
        fi
    done
    if [ -n "$WWAN_FOUND" ]; then
        WWAN_STATUS="${GREEN}lenovo-wwan-unlock für ${NEXT_DIST} verfügbar (${WWAN_FOUND})${NC}"
    else
        WWAN_STATUS="\033[1;41;97m lenovo-wwan-unlock für ${NEXT_DIST} fehlt – KEIN Upgrade (5G-Modem) ${NC}"
    fi
fi

echo -e "\n${CYAN}================================================================${NC}"
echo -e "${CYAN}                 UBUNTU MAINTENANCE SCRIPT                      ${NC}"
echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}Script-Version:${NC}       1.0.7"
echo -e "${CYAN}Kernel:${NC}               ${KERNEL_VER}"
echo -e "${CYAN}Ubuntu-Version:${NC}       ${OS_NAME} (${OS_CODENAME})"
echo -e "${CYAN}LTS-Upgrade Check:${NC}    ${DO_RELEASE_STATUS}"
echo -e "${CYAN}Nächster LTS-Pfad:${NC}    ${NEXT_LTS_STATUS}"
[ -n "$WWAN_STATUS" ] && echo -e "${CYAN}Lenovo-WWAN:${NC}          ${WWAN_STATUS}"
echo ""
echo -e "${CYAN}Start:${NC}                $(date '+%d.%m.%Y %H:%M:%S')\n"

ask_yes_no() {
    local prompt="$1"
    local answer
    while true; do
        echo -n -e "${YELLOW}${prompt} (y/n): ${NC}" >&3
        read -r answer </dev/tty
        case "$answer" in
            [Yy]* ) return 0 ;;
            [Nn]* ) return 1 ;;
            * ) echo -e "Bitte mit y oder n antworten." >&3 ;;
        esac
    done
}

echo -e "${YELLOW}Authentifizierung erforderlich${NC}"
sudo -v
echo -e "${GREEN}Authentifizierung abgeschlossen${NC}"

while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

echo ""

# ==============================================================================
# 1. ANWENDUNGS- & REPO-CHECK
# ==============================================================================
echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}                 1. ANWENDUNGS- & REPO-CHECK                    ${NC}"
echo -e "${CYAN}================================================================${NC}\n"

apt_installed_version() { dpkg-query -W -f='${Version}\n' "$1" 2>/dev/null; }
apt_candidate_version() { apt-cache policy "$1" 2>/dev/null | awk '/Installationskandidat:|Candidate:/{print $2; exit}'; }
apt_install_date() {
  local file="/var/lib/dpkg/info/${1}.list"
  if [[ -f "$file" ]]; then date -r "$file" +"%d.%m.%Y" 2>/dev/null; fi
}
apt_has_update() {
  local installed="$(apt_installed_version "$1")"
  local candidate="$(apt_candidate_version "$1")"
  [[ -n "$installed" && -n "$candidate" && "$candidate" != "(none)" && "$installed" != "$candidate" ]]
}
shorten_version() { echo "$1" | sed -E 's/^[0-9]+://; s/[+~-].*//'; }
print_row() { printf '%-12s %-5s %-16s %-16s %-14s %-8s %-22s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7"; }

check_app() {
  local name="$1" pkg="$2" repo_kw="$3" is_snap_target="$4"
  if dpkg-query -W "$pkg" >/dev/null 2>&1; then
    local ver cand idate status pin short_ver short_cand
    ver="$(apt_installed_version "$pkg")"
    cand="$(apt_candidate_version "$pkg")"
    [[ -z "$cand" || "$cand" == "(none)" ]] && cand="-"
    idate="$(apt_install_date "$pkg")"
    [[ -z "$idate" ]] && idate="-"

    if apt_has_update "$pkg"; then status="Nein"; else status="Ja"; fi

    short_ver="$(shorten_version "$ver")"
    [[ "$cand" == "-" ]] && short_cand="-" || short_cand="$(shorten_version "$cand")"

    local policy="$(apt-cache policy "$pkg" 2>/dev/null)"
    if echo "$policy" | grep -A 2 '\*\*\*' | grep -qiE "$repo_kw"; then
      if [[ "$is_snap_target" == "true" ]]; then
        if echo "$policy" | grep -qE ' (-1|100[0-9]+)$'; then pin="OK (Gepinnt)"; else pin="Warnung (Offen)"; fi
      else
        pin="OK (Offiziell)"
      fi
    else
      pin="Falsches Repo"
    fi
    print_row "$name" "APT" "$short_ver" "$short_cand" "$idate" "$status" "$pin"
  else
    print_row "$name" "-" "-" "-" "-" "Fehlt" "-"
  fi
}


print_row "Programm" "Typ" "Version" "Verfuegbar" "Installiert" "Aktuell " "Repo/Pinning"
print_row "------------" "-----" "----------------" "----------------" "--------------" "--------" "----------------------"

CONFIG_FILE="$(dirname "$0")/maintenance.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo -e "${RED}Fehler: Konfigurationsdatei '$CONFIG_FILE' nicht gefunden.${NC}"
elif ! command -v jq >/dev/null 2>&1; then
    echo -e "${RED}Fehler: Das Tool 'jq' fehlt. Bitte mit 'sudo apt install jq' installieren.${NC}"
else
    APP_ISSUES=0
    while read -r app; do
        app_name=$(echo "$app" | jq -r '.name')
        app_pkg=$(echo "$app" | jq -r '.pkg')
        app_repo_kw=$(echo "$app" | jq -r '.repo_kw')
        app_is_snap=$(echo "$app" | jq -r '.is_snap_target')
        
        RESULT=$(check_app "$app_name" "$app_pkg" "$app_repo_kw" "$app_is_snap")
        echo "$RESULT"
        if echo "$RESULT" | grep -qE "Fehlt|Falsches Repo|Warnung|Nein"; then
            APP_ISSUES=$((APP_ISSUES + 1))
        fi
    done < <(jq -c '.apps[]' "$CONFIG_FILE")
fi

if [ "${APP_ISSUES:-0}" -eq 0 ]; then
    STEP1_SUMMARY="${GREEN}✅ OK${NC}"
else
    STEP1_SUMMARY="${YELLOW}⚠️ Warnung ($APP_ISSUES Auffälligkeiten)${NC}"
fi
echo -e "\n${CYAN}Zusammenfassung Abschnitt 1:${NC} $STEP1_SUMMARY"

echo

# ==============================================================================
# 2. AKKU-STATUS
# ==============================================================================
echo -e "\n${CYAN}================================================================${NC}"
echo -e "${CYAN}                       2. AKKU-STATUS                           ${NC}"
echo -e "${CYAN}================================================================${NC}\n"

if [ -f /sys/class/power_supply/BAT0/uevent ]; then
  BAT_OUTPUT=$(awk -F= '
  /POWER_SUPPLY_STATUS=/ {status=$2}
  /POWER_SUPPLY_CAPACITY=/ {soc=$2}
  /POWER_SUPPLY_POWER_NOW=/ {power=$2/1000000}
  /POWER_SUPPLY_ENERGY_NOW=/ {enow=$2/1000000}
  /POWER_SUPPLY_ENERGY_FULL=/ {efull=$2/1000000}
  /POWER_SUPPLY_ENERGY_FULL_DESIGN=/ {edesign=$2/1000000}
  /POWER_SUPPLY_CYCLE_COUNT=/ {cycles=$2}
  END {
    soh=(efull/edesign)*100
    printf "Status : %s\n", status
    printf "SoC    : %s%%\n", soc
    printf "Power  : %.2f W\n", power
    printf "Now    : %.2f Wh\n", enow
    printf "Full   : %.2f Wh\n", efull
    printf "Design : %.2f Wh\n", edesign
    printf "SoH    : %.1f%%\n", soh
    printf "Cycles : %s\n", cycles
  }' /sys/class/power_supply/BAT0/uevent)
  
  echo "$BAT_OUTPUT"
  BAT_SOH_SUMMARY=$(echo "$BAT_OUTPUT" | awk '/SoH/ {print $3}' | tr -d '%')
else
  echo -e "${YELLOW}Kein Akku unter /sys/class/power_supply/BAT0/ gefunden.${NC}"
  BAT_SOH_SUMMARY="Kein Akku vorhanden"
fi

if [ "$BAT_SOH_SUMMARY" == "Kein Akku vorhanden" ]; then
    STEP2_SUMMARY="${GREEN}✅ OK${NC} (Kein Akku)"
else
    BAT_INT=$(echo "$BAT_SOH_SUMMARY" | sed 's/[,.]/ /' | awk '{print $1}')
    if [ -z "$BAT_INT" ]; then
        STEP2_SUMMARY="${YELLOW}⚠️ Unbekannt${NC}"
    elif [ "$BAT_INT" -ge 90 ]; then
        STEP2_SUMMARY="${GREEN}✅ OK${NC} ($BAT_SOH_SUMMARY%)"
    else
        STEP2_SUMMARY="${YELLOW}⚠️ Warnung${NC} (Unter 90%: $BAT_SOH_SUMMARY%)"
    fi
fi
echo -e "\n${CYAN}Zusammenfassung Abschnitt 2:${NC} $STEP2_SUMMARY"
echo

# ==============================================================================
# 3. SYSTEM-UPDATE
# ==============================================================================
echo -e "\n${CYAN}================================================================${NC}"
echo -e "${CYAN}                       3. SYSTEM-UPDATE                         ${NC}"
echo -e "${CYAN}================================================================${NC}\n"

spinner() {
    local pid=$! delay=0.1
    local states=(" [=.......] " " [.=......] " " [..=.....] " " [...=....] " " [....=...] " " [.....=..] " " [......=.] " " [.......=] " " [......=.] " " [.....=..] " " [....=...] " " [...=....] " " [..=.....] " " [.=......] ")
    while kill -0 "$pid" 2>/dev/null; do
        for state in "${states[@]}"; do
            if ! kill -0 "$pid" 2>/dev/null; then break; fi
            printf "%s" "$state" >&3; sleep $delay; printf "\b\b\b\b\b\b\b\b\b\b\b\b" >&3
        done
    done
    printf "            \b\b\b\b\b\b\b\b\b\b\b\b" >&3
}

echo -e "${BLUE}[1/9] Aktualisiere Desktop-Datenbank...${NC}"
update-desktop-database ~/.local/share/applications/

echo -n -e "${BLUE}[2/9] Suche nach Paket-Updates (APT)...${NC}"
sudo apt-get update > /tmp/apt-update.log 2>&1 &
spinner
if [ $? -ne 0 ]; then
    echo -e "\n${RED}Es gab einen Fehler beim APT Update:${NC}"; cat /tmp/apt-update.log
else
    echo -e " ${GREEN}✅ OK${NC}"
fi

# ------------------------------------------------------------------------------
# Kernel-Schutz (Schicht 1: APT-Sperre für Cloud-/Spezial-Kernel, Schicht 2: Trockenlauf)
# Hintergrund: Ein dist-upgrade hat einmal ungesehen den Google-Cloud-Kernel (-gke) installiert;
# GRUB bootet die höchste Versionsnummer, ohne passende Header/NVIDIA-Module.
# ------------------------------------------------------------------------------
KERNEL_PIN_FILE="/etc/apt/preferences.d/no-cloud-kernels"
KERNEL_USER_CFG="$HOME/.config/ubuntu-maintenance-indicator/maintenance.json"
ALLOWED_KERNEL_FLAVOURS="generic"
if [ -f "$KERNEL_USER_CFG" ] && command -v jq >/dev/null 2>&1; then
    _fl=$(jq -r '(.allowed_kernel_flavours // []) | join(" ")' "$KERNEL_USER_CFG" 2>/dev/null)
    [ -n "$_fl" ] && ALLOWED_KERNEL_FLAVOURS="$_fl"
fi
KERNEL_GUARD_BLOCKED=false

# Liefert Paketnamen aus einer apt-Simulation, deren Kernel-Typ nicht erlaubt ist (z. B. linux-image-7.0.0-1008-gke).
foreign_kernel_pkgs() {
    local sim="$1" p fl
    while read -r p; do
        fl=$(echo "$p" | sed -nE 's/.*-[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-([a-z][a-z0-9-]*)$/\1/p')
        [ -z "$fl" ] && continue
        echo " $ALLOWED_KERNEL_FLAVOURS " | grep -q " $fl " || echo "$p"
    done < <(echo "$sim" | awk '/^Inst linux-/ {print $2}')
}

ensure_kernel_pin() {
    [ -f "$KERNEL_PIN_FILE" ] && return 0
    if [ ! -t 0 ] || [ ! -r /dev/tty ]; then
        echo -e "\n${YELLOW}Kernel-Schutz: APT-Sperre $KERNEL_PIN_FILE fehlt (keine Rückfrage möglich, nicht interaktiv).${NC}"
        return 0
    fi
    echo -e "\n${YELLOW}Kernel-Schutz: Die APT-Sperre für Cloud-Kernel fehlt ($KERNEL_PIN_FILE).${NC}"
    echo "Sie verhindert, dass apt Kernel wie -gke, -gcp, -aws, -azure, -oracle, -ibm oder -kvm installiert."
    if ask_yes_no "Sperre jetzt anlegen (sudo, schreibt $KERNEL_PIN_FILE)?"; then
        printf '%s\n' \
            '# Angelegt von ubuntumaintenance.sh: Cloud-/Spezial-Kernel auf diesem Rechner nie installieren.' \
            'Package: linux-*-gke* linux-*-gcp* linux-*-aws* linux-*-azure* linux-*-oracle* linux-*-ibm* linux-*-kvm*' \
            'Pin: release *' \
            'Pin-Priority: -1' | sudo tee "$KERNEL_PIN_FILE" > /dev/null \
            && echo -e "${GREEN}✅ Sperre angelegt.${NC}" \
            || echo -e "${RED}Sperre konnte nicht angelegt werden.${NC}"
    else
        echo -e "${YELLOW}Ohne Sperre bleibt nur der Trockenlauf als Schutz.${NC}"
    fi
}

# Ermittelt, welche Pakete ein Kernel-Paket verlangen: nur Pakete, die installiert sind oder im selben
# (simulierten) Upgrade installiert werden. Nutzt nur Abhängigkeiten (kein Recommends/Suggests).
kernel_pull_reason() {
    local sim="$1" pkg="$2" names rd hit
    names=$( { dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1=="ii"{print $2}'
               echo "$sim" | awk '/^Inst /{print $2}'; } | LC_ALL=C sort -u)
    rd=$(LANG=C apt-cache rdepends --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances "$pkg" 2>/dev/null \
         | sed -n '3,$p' | sed 's/^[ |]*//' | grep -vx "$pkg" | LC_ALL=C sort -u)
    hit=$(LC_ALL=C comm -12 <(echo "$rd") <(echo "$names") | tr '\n' ' ' | sed 's/ $//; s/ /, /g')
    if [ -n "$hit" ]; then
        echo "verlangt von: $hit"
    else
        echo "kein installiertes/mitinstalliertes Paket verlangt ihn direkt (Auswahl durch den apt-Solver, z. B. als Alternative)"
    fi
}

show_kernel_guard_warning() {
    local pkgs="$1"
    echo -e "\n${RED}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  ⛔  ACHTUNG: FREMD-KERNEL ERKANNT - dist-upgrade ist BLOCKIERT          ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
    echo -e "${RED}Das Upgrade würde folgende Kernel-Pakete installieren, die NICHT zu diesem System passen:${NC}"
    local p
    while read -r p; do
        [ -z "$p" ] && continue
        echo -e "${YELLOW}   • $p${NC}"
        echo -e "${CYAN}       ↳ $(kernel_pull_reason "$DIST_SIM_OUTPUT" "$p")${NC}"
    done <<< "$pkgs"
    echo -e "${CYAN}   (Weiterforschen: apt-cache rdepends <Paket>  bzw.  apt-get -s dist-upgrade | grep '^Inst linux-')${NC}"
    echo -e "${RED}Erlaubte Kernel-Typen: $ALLOWED_KERNEL_FLAVOURS${NC}"
    echo -e "${RED}Folgen, falls so ein Kernel installiert wird: GRUB bootet ihn wegen der höheren Versionsnummer${NC}"
    echo -e "${RED}als Standard - ohne passende Header (VirtualBox/DKMS) und ohne NVIDIA-Modul (kein Grafiktreiber).${NC}"
    echo -e "${CYAN}Was jetzt zu tun ist:${NC}"
    echo -e "   1. Ursache klären:  ${GREEN}apt-get -s dist-upgrade | grep -E '^Inst linux-'${NC}"
    echo -e "   2. Bei Cloud-Kerneln die Sperre prüfen:  ${GREEN}cat $KERNEL_PIN_FILE${NC}"
    echo -e "   3. Nur wenn der Kernel wirklich gewollt ist, Typ erlauben: \"allowed_kernel_flavours\" in"
    echo -e "      ${GREEN}$KERNEL_USER_CFG${NC}"
    echo -e "${YELLOW}Normale Paket-Updates (apt-get upgrade) werden trotzdem eingespielt; nur dist-upgrade wird übersprungen.${NC}\n"
}

ensure_kernel_pin

echo -e "\n${BLUE}[3/9] Prüfe auf APT-Upgrades...${NC}"

SIM_OUTPUT=$(LANG=C apt-get upgrade -s 2>/dev/null)
ACTUAL_UPGRADES=$(echo "$SIM_OUTPUT" | awk '/^Inst / {print $2}')
PHASED_UPDATES=$(echo "$SIM_OUTPUT" | awk '/The following upgrades have been deferred due to phasing:/{flag=1; next} /^([0-9]+ upgraded|The following)/{flag=0} flag {print}' | xargs)
KEPT_BACK=$(echo "$SIM_OUTPUT" | awk '/The following packages have been kept back:/{flag=1; next} /^([0-9]+ upgraded|The following)/{flag=0} flag {print}' | xargs)

if [ -z "$ACTUAL_UPGRADES" ] && [ -z "$PHASED_UPDATES" ] && [ -z "$KEPT_BACK" ]; then
    echo "Keine APT-Updates verfügbar."
    UPDATES_APT=0
else
    if [ -n "$ACTUAL_UPGRADES" ]; then
        echo -e "Folgende Pakete werden aktualisiert:\n$(echo "$ACTUAL_UPGRADES" | fmt -w 80)\n"
        
        DO_APT_UPDATE=true
        if [ "$ASK_UPDATES" = true ]; then
            ask_yes_no "APT-Updates jetzt installieren?" || DO_APT_UPDATE=false
        fi
        
        if [ "$DO_APT_UPDATE" = true ]; then
            echo -n "Installiere APT-Updates..."
            
            # Kernel-Schutz (Schicht 2): Trockenlauf des dist-upgrade. Der Vorab-Check oben (apt-get upgrade -s)
            # zeigt keine NEU hinzukommenden Pakete - genau die kann dist-upgrade aber installieren.
            DIST_SIM_OUTPUT=$(LANG=C apt-get dist-upgrade -s 2>/dev/null)
            FOREIGN_KERNELS=$(foreign_kernel_pkgs "$DIST_SIM_OUTPUT")
            RUN_DIST_UPGRADE=true
            if [ -n "$FOREIGN_KERNELS" ]; then
                show_kernel_guard_warning "$FOREIGN_KERNELS"
                RUN_DIST_UPGRADE=false
                KERNEL_GUARD_BLOCKED=true
                SEC_STATUS_SUMMARY="FREMD-KERNEL im Upgrade (dist-upgrade blockiert)"
                if [ "$ASK_UPDATES" = true ]; then
                    echo -e "${RED}Trotzdem dist-upgrade ausführen? Das installiert den Fremd-Kernel!${NC}"
                    if ask_yes_no "dist-upgrade TROTZ Fremd-Kernel ausführen (nicht empfohlen)?"; then
                        RUN_DIST_UPGRADE=true
                        KERNEL_GUARD_BLOCKED=false
                        SEC_STATUS_SUMMARY="OK"
                        echo -e "${YELLOW}Auf deinen ausdrücklichen Wunsch fortgesetzt.${NC}"
                    fi
                fi
                echo -n "Installiere APT-Updates (ohne dist-upgrade)..."
            fi

            # Bugfix: apt-get upgrade & dist-upgrade in einem gemeinsamen Subshell-Block mit korrekter Fehlerbehandlung
            (
                sudo env DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -q -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" > /tmp/apt-upgrade.log 2>&1 &&
                { [ "$RUN_DIST_UPGRADE" = true ] || exit 0; } &&
                sudo env DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -q -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" >> /tmp/apt-upgrade.log 2>&1
            ) &
            
            APT_PID=$!
            spinner
            wait $APT_PID
            
            if [ $? -ne 0 ]; then
                echo -e " ${RED}Fehler während der Installation!${NC}\n"
                echo -e "${YELLOW}Das System konnte die Updates nicht herunterladen oder installieren.${NC}"
                echo -e "${YELLOW}Details zum Fehler (letzte Zeilen des Logs):${NC}"
                tail -n 15 /tmp/apt-upgrade.log
                UPDATES_APT=0
            else
                echo -e " ${GREEN}✅ OK${NC}"
                UPDATES_APT=$(echo "$ACTUAL_UPGRADES" | wc -w)
            fi
        else
            echo -e " ${YELLOW}APT-Updates übersprungen.${NC}"
            UPDATES_APT=0
        fi
    else
        UPDATES_APT=0
        echo -e "Keine sofort installierbaren APT-Updates."
    fi
    
    if [ -n "$PHASED_UPDATES" ]; then
        echo -e "\n${YELLOW}Wegen Phasenstufung (Phased Updates) zurückgestellt:${NC}"
        echo -e "$(echo "$PHASED_UPDATES" | fmt -w 80)"
        echo -e "\n${CYAN}💡 Um diese sofort zu installieren, nutze folgenden Befehl:${NC}"
        echo -e "👉 ${GREEN}sudo apt-get install $PHASED_UPDATES${NC}"
    fi
    
    if [ -n "$KEPT_BACK" ]; then
        echo -e "\n${YELLOW}Zurückgehalten (Kept back):${NC}"
        echo -e "$(echo "$KEPT_BACK" | fmt -w 80)"
        echo -e "\n${CYAN}💡 Um diese sofort zu installieren, nutze folgenden Befehl:${NC}"
        echo -e "👉 ${GREEN}sudo apt-get install $KEPT_BACK${NC}"
    fi
fi

echo -n -e "\n${BLUE}[4/9] Räume alte Pakete auf (APT Clean/Autoremove)...${NC}"
sudo apt-get autoremove --purge -y > /dev/null 2>&1
sudo apt-get clean > /dev/null 2>&1
sudo apt-get autoclean > /dev/null 2>&1
echo -e " ${GREEN}✅ OK${NC}"

echo -e "\n${BLUE}[5/9] Prüfe auf Flatpak-Updates...${NC}"
FLATPAK_UPDATES=$(flatpak remote-ls --updates 2>/dev/null)
if [ -z "$FLATPAK_UPDATES" ]; then
    echo "Keine Flatpak-Updates verfügbar."
else
    echo -e "Folgende Flatpaks werden aktualisiert:\n$FLATPAK_UPDATES\n"
    
    DO_FLATPAK_UPDATE=true
    if [ "$ASK_UPDATES" = true ]; then
        ask_yes_no "Flatpak-Updates jetzt installieren?" || DO_FLATPAK_UPDATE=false
    fi
    
    if [ "$DO_FLATPAK_UPDATE" = true ]; then
        echo -n "Installiere Flatpak-Updates..."
        flatpak update -y > /dev/null 2>&1 &
        spinner
        echo -e " ${GREEN}✅ OK${NC}"
        UPDATES_FLATPAK=$(echo "$FLATPAK_UPDATES" | grep -c '^')
    else
        echo -e " ${YELLOW}Flatpak-Updates übersprungen.${NC}"
        UPDATES_FLATPAK=0
    fi
fi

echo -e "\n${BLUE}[5b/9] Prüfe auf AppImage-Updates (AM)...${NC}"
if command -v am >/dev/null 2>&1; then
    APPIMAGE_PENDING=()
    for updater in /opt/*/AM-updater; do
        [ -f "$updater" ] || continue
        app_dir=$(dirname "$updater")
        app_name=$(basename "$app_dir")
        # Zeile 'version=...' des AM-Updaters ermittelt die aktuelle Download-URL (rein lesend)
        ver_line=$(head -n 12 "$updater" | grep -m1 '^version=')
        installed=$(cat "$app_dir/version" 2>/dev/null)
        latest=""
        [ -n "$ver_line" ] && latest=$(timeout 30 sh -c "$ver_line; printf '%s' \"\$version\"" 2>/dev/null)
        if [ -z "$latest" ] || [ -z "$installed" ]; then
            echo -e "  ${YELLOW}?${NC} $app_name: Prüfung fehlgeschlagen"
        elif [ "$latest" != "$installed" ]; then
            echo -e "  ${YELLOW}↑${NC} $app_name: ${installed##*/} → ${latest##*/}"
            APPIMAGE_PENDING+=("$app_name")
        else
            echo -e "  ${GREEN}✓${NC} $app_name: ${installed##*/}"
        fi
    done

    if [ ${#APPIMAGE_PENDING[@]} -eq 0 ]; then
        echo "Keine AppImage-Updates verfügbar."
    else
        DO_APPIMAGE_UPDATE=true
        if [ "$ASK_UPDATES" = true ]; then
            ask_yes_no "AppImage-Updates jetzt installieren (${APPIMAGE_PENDING[*]})?" || DO_APPIMAGE_UPDATE=false
        fi

        if [ "$DO_APPIMAGE_UPDATE" = true ]; then
            for app_name in "${APPIMAGE_PENDING[@]}"; do
                echo "Aktualisiere $app_name..."
                if am -u "$app_name"; then
                    UPDATES_APPIMAGE=$((UPDATES_APPIMAGE + 1))
                else
                    echo -e "  ${RED}Update von $app_name fehlgeschlagen.${NC}"
                fi
            done
            echo -e " ${GREEN}✅ OK${NC}"
        else
            echo -e " ${YELLOW}AppImage-Updates übersprungen.${NC}"
        fi
    fi
else
    echo "AM (AppImage-Manager) nicht installiert - übersprungen."
fi

echo -e "\n${BLUE}[6/9] Prüfe auf Snap-Updates...${NC}"
SNAP_UPDATES=$(snap refresh --list 2>/dev/null)
if [ -z "$SNAP_UPDATES" ] || echo "$SNAP_UPDATES" | grep -q "All snaps up to date\|No updates available"; then
    echo "Keine Snap-Updates verfügbar."
else
    echo -e "Folgende Snaps werden aktualisiert:\n$SNAP_UPDATES\n"
    
    DO_SNAP_UPDATE=true
    if [ "$ASK_UPDATES" = true ]; then
        ask_yes_no "Snap-Updates jetzt installieren?" || DO_SNAP_UPDATE=false
    fi
    
    if [ "$DO_SNAP_UPDATE" = true ]; then
        echo -n "Installiere Snap-Updates..."
        sudo snap refresh > /dev/null 2>&1 &
        spinner
        echo -e " ${GREEN}✅ OK${NC}"
        UPDATES_SNAP=$(($(echo "$SNAP_UPDATES" | grep -c '^') - 1))
    else
        echo -e " ${YELLOW}Snap-Updates übersprungen.${NC}"
        UPDATES_SNAP=0
    fi
fi

echo -e "\n${BLUE}[7/9] Prüfe auf Firmware-Updates (fwupd)...${NC}"
echo -n "Aktualisiere LVFS-Metadaten..."
fwupdmgr refresh > /dev/null 2>&1 &
spinner
echo -e " ${GREEN}✅ OK${NC}"

if fwupdmgr get-updates > /dev/null 2>&1; then
    echo -e "Folgende Firmware-Updates sind verfügbar:\n"
    fwupdmgr get-updates 2>/dev/null
    echo ""
    
    if ask_yes_no "Firmware-Updates jetzt installieren?"; then
        echo -n "Installiere Firmware-Updates..."
        fwupdmgr update -y > /dev/null 2>&1 &
        spinner
        echo -e " ${GREEN}✅ OK (Update wird beim nächsten Booten geflasht)${NC}"
        REBOOT_REQUIRED="Ja"
        REBOOT_REASON+="Firmware. "
    else
        echo -e " ${YELLOW}Firmware-Updates übersprungen.${NC}"
    fi
else
    echo "Keine Firmware-Updates verfügbar."
fi

# ==============================================================================
# PAKET-LEICHEN BESEITIGEN (rc)
# ==============================================================================
echo -n -e "
${BLUE}[8/9] Prüfe auf GNOME-Extensions-Updates (gext)...${NC}"
if ! command -v gext >/dev/null 2>&1 && [ ! -f "$HOME/.local/bin/gext" ]; then
    echo -e "\n   ${YELLOW}ℹ️ 'gext' fehlt. Wird automatisch installiert...${NC}"
    if ! command -v pipx >/dev/null 2>&1; then
        echo -n "   Installiere pipx..."
        sudo apt-get update -q >/dev/null 2>&1
        sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q pipx >/dev/null 2>&1 &
        spinner
        echo -e " ${GREEN}✅ OK${NC}"
    fi
    echo -n "   Installiere gnome-extensions-cli..."
    pipx install gnome-extensions-cli >/dev/null 2>&1 &
    spinner
    echo -e " ${GREEN}✅ OK${NC}"
    echo -n "   Führe Update aus..."
else
    echo -n " "
fi

GEXT_CMD="gext"
[ -f "$HOME/.local/bin/gext" ] && GEXT_CMD="$HOME/.local/bin/gext"

# Selbstheilung: Nach einem Python-Sprung (z. B. Ubuntu 24.04 -> 26.04) findet die pipx-Umgebung
# ihre Pakete nicht mehr (ModuleNotFoundError). Dann wird gext neu aufgebaut.
if ! $GEXT_CMD --version >/dev/null 2>&1 && command -v pipx >/dev/null 2>&1; then
    echo -e "\n   ${YELLOW}ℹ️ 'gext' ist defekt (vermutlich nach Python-Update). Baue es neu auf...${NC}"
    echo -n "   pipx reinstall gnome-extensions-cli..."
    pipx reinstall gnome-extensions-cli >/dev/null 2>&1 &
    spinner
    echo -e " ${GREEN}✅ OK${NC}"
    echo -n "   Führe Update aus..."
fi

yes | $GEXT_CMD update > /tmp/gext-update.log 2>&1 &
spinner

GEXT_OUT=$(cat /tmp/gext-update.log)
if echo "$GEXT_OUT" | grep -qi "updated\|installed\|success"; then
    echo -e " ${GREEN}✅ OK (Updates installiert)${NC}"
    UPDATES_GEXT=1
elif echo "$GEXT_OUT" | grep -qi "error\|failed"; then
    echo -e " ${YELLOW}⚠️ Warnung (Fehler beim gext Update)${NC}"
else
    echo -e " ${GREEN}✅ OK${NC}"
fi

echo -e "\n${BLUE}[9/9] Alte Paket-Konfigurationen (rc) bereinigen...${NC}" 
RC_PKGS=$(dpkg -l | awk '/^rc/ {print $2}')
if [ -n "$RC_PKGS" ]; then
    echo -n "Entferne Konfigurations-Reste..."
    echo "$RC_PKGS" | sudo xargs -r apt-get purge -y > /dev/null 2>&1 &
    spinner
    RC_COUNT=$(echo "$RC_PKGS" | wc -w)
    echo -e " ${GREEN}✅ OK ($RC_COUNT Paket(e) restlos entfernt)${NC}"
else
    echo -e " ${GREEN}✅ OK (System ist sauber).${NC}"
fi

TOTAL_UPDATES=$((UPDATES_APT + UPDATES_FLATPAK + UPDATES_APPIMAGE + UPDATES_SNAP + ${UPDATES_GEXT:-0}))
if [[ "$REBOOT_REASON" == *"Firmware"* ]]; then
    STEP3_SUMMARY="${YELLOW}⚠️ Warnung${NC} ($TOTAL_UPDATES Updates, Firmware aktualisiert - Clevis/LUKS prüfen!)"
elif [ "$TOTAL_UPDATES" -eq 0 ]; then
    STEP3_SUMMARY="${GREEN}✅ OK${NC} (0 Updates)"
else
    STEP3_SUMMARY="${GREEN}✅ OK${NC} ($TOTAL_UPDATES Updates installiert)"
fi
if [ "$KERNEL_GUARD_BLOCKED" = true ]; then
    STEP3_SUMMARY="${RED}⛔ FREMD-KERNEL erkannt - dist-upgrade blockiert!${NC}"
fi
echo -e "\n${CYAN}Zusammenfassung Abschnitt 3:${NC} $STEP3_SUMMARY"

# ==============================================================================
# 4. SICHERHEIT
# ==============================================================================
echo -e "\n${CYAN}================================================================${NC}"
echo -e "${CYAN}                        4. SICHERHEIT                           ${NC}"
echo -e "${CYAN}================================================================${NC}\n"

echo -e "${BLUE}Prüfe System-Sicherheit & Anomalien...${NC}"

RK_OK=false
LYNIS_OK=false

if ! command -v rkhunter >/dev/null 2>&1; then
    echo -e "   ${RED}❌ RKHunter: NICHT installiert.${NC}"
    if ask_yes_no "   Möchtest du RKHunter installieren und als Cronjob einrichten?"; then
        echo -n "   Installiere RKHunter..."
        sudo apt-get update -q >/dev/null 2>&1
        sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q rkhunter >/dev/null 2>&1 &
        spinner
        sudo sed -i 's/^CRON_DAILY_RUN=.*/CRON_DAILY_RUN="yes"/' /etc/default/rkhunter 2>/dev/null || echo 'CRON_DAILY_RUN="yes"' | sudo tee -a /etc/default/rkhunter >/dev/null
        sudo sed -i 's/^APT_AUTOGEN=.*/APT_AUTOGEN="yes"/' /etc/default/rkhunter 2>/dev/null || echo 'APT_AUTOGEN="yes"' | sudo tee -a /etc/default/rkhunter >/dev/null
        
        echo -n -e "\n   Erstelle initiale RKHunter-Datenbank..."
        sudo rkhunter --propupd >/dev/null 2>&1 &
        spinner
        echo -e " ${GREEN}Aktiviert!${NC}"
        RK_OK=true
    else
        echo -e "   ${YELLOW}⏭️ RKHunter übersprungen.${NC}"
    fi
else
    if grep -q 'CRON_DAILY_RUN="yes"' /etc/default/rkhunter 2>/dev/null; then
        RK_OK=true
    else
        echo -e "   ${YELLOW}⚠️ RKHunter: Cronjob ist INAKTIV!${NC}"
        if ask_yes_no "   Möchtest du den täglichen Scan jetzt aktivieren?"; then
            sudo sed -i 's/^CRON_DAILY_RUN=.*/CRON_DAILY_RUN="yes"/' /etc/default/rkhunter
            sudo sed -i 's/^APT_AUTOGEN=.*/APT_AUTOGEN="yes"/' /etc/default/rkhunter
            echo -e "   ${GREEN}RKHunter Hintergrund-Job aktiviert.${NC}"
            RK_OK=true
        else
            echo -e "   ${YELLOW}⏭️ RKHunter übersprungen.${NC}"
        fi
    fi
fi

if ! command -v lynis >/dev/null 2>&1; then
    echo -e "   ${RED}❌ Lynis: NICHT installiert.${NC}"
    if ask_yes_no "   Möchtest du Lynis installieren und den Timer aktivieren?"; then
        echo -n "   Installiere Lynis..."
        sudo apt-get update -q >/dev/null 2>&1
        sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q lynis >/dev/null 2>&1 &
        spinner
        sudo systemctl enable --now lynis.timer >/dev/null 2>&1
        echo -e " ${GREEN}Aktiviert!${NC}"
        LYNIS_OK=true
    else
        echo -e "   ${YELLOW}⏭️ Lynis übersprungen.${NC}"
    fi
else
    if sudo test -x /etc/cron.daily/lynis || systemctl is-enabled lynis.timer >/dev/null 2>&1 || systemctl is-active lynis.timer >/dev/null 2>&1; then
        LYNIS_OK=true
    else
        echo -e "   ${YELLOW}⚠️ Lynis: Hintergrund-Job ist INAKTIV!${NC}"
        if ask_yes_no "   Möchtest du den Hintergrund-Timer jetzt aktivieren?"; then
            sudo systemctl enable --now lynis.timer >/dev/null 2>&1
            echo -e "   ${GREEN}Lynis Hintergrund-Job aktiviert.${NC}"
            LYNIS_OK=true
        else
            echo -e "   ${YELLOW}⏭️ Lynis übersprungen.${NC}"
        fi
    fi
fi

echo ""
echo -n "Prüfe Firewall... "
if ! sudo ufw status | grep -qiwE "active|aktiv"; then
    echo -e "${RED}❌ INAKTIV${NC} (Bitte mit 'sudo ufw enable' einschalten)"
    SEC_STATUS_SUMMARY="Warnung (Firewall inaktiv)"
else
    echo -e "${GREEN}✅ OK${NC}"
fi

echo -n "Prüfe RKHunter Hintergrund-Ergebnisse... "
if [ "$RK_OK" = true ]; then
    if sudo test -f /var/log/rkhunter.log; then
        RK_WARNINGS=$(sudo grep -i "warning" /var/log/rkhunter.log | grep -viE 'changed|replaced by a script|hidden directory|Checking for hidden files and directories|suspicious files and directories|suspicious file types|Checking /dev for suspicious|Info:|lwp-request|\.resolv\.conf\.systemd-resolved\.bak|\.updated')
        if [ -n "$RK_WARNINGS" ]; then
            echo -e "\n${YELLOW}⚠️ WARNUNGEN im Log gefunden:${NC}\n$RK_WARNINGS"
            echo -e "\n${CYAN}💡 Info & Lösung für RKHunter:${NC}"
            echo -e "Warnungen bzgl. 'passwd' oder 'group' (z.B. neue User/Gruppen)"
            echo -e "sind nach System-Updates oder Software-Installationen normal."
            echo -e "Um den neuen Zustand als 'sicher' zu übernehmen, führe aus:"
            echo -e "👉 ${GREEN}sudo rkhunter --propupd${NC}\n"
            [[ "$SEC_STATUS_SUMMARY" == "OK" ]] && SEC_STATUS_SUMMARY="Warnungen (RKHunter Log)"
        else
            echo -e "${GREEN}✅ OK${NC} (Keine kritischen Warnungen)"
        fi
    else
        echo -e "${YELLOW}⏳ Logdatei fehlt noch${NC} (Scan läuft erst diese Nacht)"
    fi
else
    echo -e "${YELLOW}⏭️ ÜBERSPRUNGEN${NC}"
fi

echo -n "Prüfe Lynis Hintergrund-Audit... "
if [ "$LYNIS_OK" = true ]; then
    if sudo test -f /var/log/lynis-report.dat; then
        LYNIS_WARNINGS=$(sudo grep -E "^warning=" /var/log/lynis-report.dat | cut -d= -f2)
        if [ -n "$LYNIS_WARNINGS" ] && [ "$LYNIS_WARNINGS" -gt 0 ] 2>/dev/null; then
            echo -e "${YELLOW}⚠️ $LYNIS_WARNINGS Warnung(en) im letzten Audit gefunden.${NC}"
            [[ "$SEC_STATUS_SUMMARY" == "OK" ]] && SEC_STATUS_SUMMARY="Warnungen (Lynis Audit)"
        else
            echo -e "${GREEN}✅ OK${NC} (0 kritische Warnungen)"
        fi
    else
        echo -e "${YELLOW}⏳ Report fehlt noch${NC} (Audit läuft erst diese Nacht)"
    fi
else
    echo -e "${YELLOW}⏭️ ÜBERSPRUNGEN${NC}"
fi

echo -n "Prüfe auf riskante offene Ports... "
ALL_EXTERNAL=$(sudo ss -tulpen | grep LISTEN | grep -vE '127\.0\.0\.[0-9]+|::1' || true)

ALLOWED_PROCS=""
if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
    ALLOWED_PROCS=$(jq -r '.security.allowed_processes // [] | join("|")' "$CONFIG_FILE" 2>/dev/null)
fi
if [ -z "$ALLOWED_PROCS" ]; then
    ALLOWED_PROCS="syncthing|postfix|anydesk|nginx|smbd|nmbd|steam|wineserver64|avahi-daemon|cupsd|sshd|spotify"
fi

RISKY_PORTS=$(echo "$ALL_EXTERNAL" | grep -viE "$ALLOWED_PROCS" | grep LISTEN)
KNOWN_PORTS=$(echo "$ALL_EXTERNAL" | grep -iE "$ALLOWED_PROCS" | grep LISTEN)

if [ -n "$RISKY_PORTS" ]; then
    RISKY_PORTS=$(echo "$RISKY_PORTS" | awk '{
    proto = $1
    port = $5
    sub(/.*:/, "", port)
    pid = "-"
    match_start = match($0, /pid=[0-9]+/)
    if (match_start > 0) { pid = substr($0, match_start + 4, RLENGTH - 4) }
    svc = "-"
    match_start = match($0, /users:\(\("[^"]+"/)
    if (match_start > 0) {
        svc = substr($0, match_start + 9, RLENGTH - 9)
        sub(/".*/, "", svc)
    } else {
        match_start = match($0, /cgroup:\/[^ ]+\.service/)
        if (match_start > 0) {
            svc = substr($0, match_start + 7, RLENGTH - 7)
            sub(/.*\//, "", svc)
        }
    }
    printf "   Port: %-6s (%s) | PID: %-6s | Dienst: %s\n", port, proto, pid, svc
}')
fi
if [ -n "$KNOWN_PORTS" ]; then
    KNOWN_PORTS=$(echo "$KNOWN_PORTS" | awk '{
    proto = $1
    port = $5
    sub(/.*:/, "", port)
    pid = "-"
    match_start = match($0, /pid=[0-9]+/)
    if (match_start > 0) { pid = substr($0, match_start + 4, RLENGTH - 4) }
    svc = "-"
    match_start = match($0, /users:\(\("[^"]+"/)
    if (match_start > 0) {
        svc = substr($0, match_start + 9, RLENGTH - 9)
        sub(/".*/, "", svc)
    } else {
        match_start = match($0, /cgroup:\/[^ ]+\.service/)
        if (match_start > 0) {
            svc = substr($0, match_start + 7, RLENGTH - 7)
            sub(/.*\//, "", svc)
        }
    }
    printf "   Port: %-6s (%s) | PID: %-6s | Dienst: %s\n", port, proto, pid, svc
}')
fi

if [ -n "$RISKY_PORTS" ]; then
    echo -e "\n${RED}⚠️ UNBEKANNTE Dienste lauschen im Netzwerk:${NC}\n$RISKY_PORTS"
    [[ "$SEC_STATUS_SUMMARY" == "OK" ]] && SEC_STATUS_SUMMARY="Unbekannte offene Ports"
else
    echo -e "${GREEN}✅ OK${NC} (Keine unbekannten Dienste)"
    if [ -n "$KNOWN_PORTS" ]; then
        echo -e "${CYAN}ℹ️ Info - diese erwarteten Dienste laufen aktuell:${NC}"
        echo "$KNOWN_PORTS"
    fi
fi

# Log-Auffälligkeiten (journalctl, rein lesend). Die Muster liegen zentral im Backend der GNOME-Extension.
echo ""
echo -n "Prüfe Log-Auffälligkeiten (aktueller Boot)... "
LOG_BACKEND=""
for cand in "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/gnomeextension/maintenance_backend.py" \
            "$HOME/.local/share/gnome-shell/extensions/ubuntu-maintenance@johnlose.de/maintenance_backend.py"; do
    [ -f "$cand" ] && { LOG_BACKEND="$cand"; break; }
done
if [ -z "$LOG_BACKEND" ] || ! command -v python3 >/dev/null 2>&1; then
    echo -e "${YELLOW}übersprungen${NC} (Backend der GNOME-Extension nicht gefunden)"
else
    LOG_REPORT=$(python3 "$LOG_BACKEND" --logs-text 2>/dev/null)
    if [ -z "$LOG_REPORT" ]; then
        echo -e "${YELLOW}übersprungen${NC} (keine Ausgabe)"
    elif echo "$LOG_REPORT" | grep -q "^Journal nicht lesbar"; then
        echo -e "${YELLOW}übersprungen${NC} ($LOG_REPORT)"
    elif ! echo "$LOG_REPORT" | grep -q -E "^\[(OK|!|i)\] "; then
        echo -e "${YELLOW}übersprungen${NC} (Backend zu alt - GNOME-Extension mit update.sh aktualisieren)"
    else
        if echo "$LOG_REPORT" | grep -q "^\[!\]"; then
            echo -e "${YELLOW}⚠️ Auffälligkeiten${NC}"
            [[ "$SEC_STATUS_SUMMARY" == "OK" ]] && SEC_STATUS_SUMMARY="Log-Auffälligkeiten"
        else
            echo -e "${GREEN}✅ OK${NC} (keine kritischen Muster)"
        fi
        echo -e "${CYAN}ℹ️ Log-Übersicht (nur [!] ist auffällig, [i] dient der Information):${NC}"
        echo "$LOG_REPORT" | sed 's/^/   /'
    fi
fi

# Kernel-Wächter (laufender Kernel, Fremd-Kernel installiert, NVIDIA-Modul) - rein lesend, nutzt das Backend
echo ""
echo -n "Prüfe Kernel-Typ und NVIDIA-Modul... "
if [ -z "$LOG_BACKEND" ] || ! command -v python3 >/dev/null 2>&1; then
    echo -e "${YELLOW}übersprungen${NC} (Backend der GNOME-Extension nicht gefunden)"
else
    KERNEL_REPORT=$(python3 "$LOG_BACKEND" --kernel-text 2>/dev/null)
    if ! echo "$KERNEL_REPORT" | grep -q -E "^\[(OK|!)\] "; then
        echo -e "${YELLOW}übersprungen${NC} (Backend zu alt - GNOME-Extension aktualisieren)"
    else
        if echo "$KERNEL_REPORT" | grep -q "^\[!\]"; then
            echo -e "${RED}⛔ Auffälligkeiten${NC}"
            [[ "$SEC_STATUS_SUMMARY" == "OK" ]] && SEC_STATUS_SUMMARY="Kernel-Auffälligkeiten"
            echo -e "${RED}$(echo "$KERNEL_REPORT" | sed 's/^/   /')${NC}"
        else
            echo -e "${GREEN}✅ OK${NC}"
            echo "$KERNEL_REPORT" | sed 's/^/   /'
        fi
    fi
fi

if [ "$SEC_STATUS_SUMMARY" == "OK" ]; then
    STEP4_SUMMARY="${GREEN}✅ OK${NC}"
else
    STEP4_SUMMARY="${YELLOW}⚠️ Warnung${NC} ($SEC_STATUS_SUMMARY)"
fi
echo -e "\n${CYAN}Zusammenfassung Abschnitt 4:${NC} $STEP4_SUMMARY"

# ==============================================================================
# REBOOT & CLEVIS CHECK
# ==============================================================================
if [ -f /var/run/reboot-required ]; then
    REBOOT_REQUIRED="Ja"
    REBOOT_REASON+="System-Pakete/Kernel. "
fi

if [[ "$REBOOT_REASON" == *"Firmware"* ]]; then
    if mokutil --sb-state 2>/dev/null | grep -qi 'SecureBoot enabled'; then
        if command -v clevis >/dev/null 2>&1; then
            LUKS_DEV=$(lsblk -r -p -o NAME,FSTYPE | awk '$2=="crypto_LUKS" {print $1}' | head -n 1)
            
            if [ -n "$LUKS_DEV" ]; then
                CLEVIS_WARNING="Ja"
            elif lsblk -f | grep -qi "crypto_luks"; then
                CLEVIS_WARNING="Ja"
            fi
        fi
    fi
fi

# ==============================================================================
# ZUSAMMENFASSUNG
# ==============================================================================
echo -e "
${CYAN}================================================================${NC}"
echo -e "${CYAN}                       ZUSAMMENFASSUNG                          ${NC}"
echo -e "${CYAN}================================================================${NC}\n"

echo -e "${BLUE}[1] Anwendungs- & Repo-Check:${NC} $STEP1_SUMMARY"
echo -e "${BLUE}[2] Akku-Status:             ${NC} $STEP2_SUMMARY"
echo -e "${BLUE}[3] System-Update:           ${NC} $STEP3_SUMMARY"
echo -e "${BLUE}[4] Sicherheit:              ${NC} $STEP4_SUMMARY"

echo -e "\n${BLUE}Neustart erforderlich?${NC}"
if [ "$REBOOT_REQUIRED" == "Ja" ]; then
    echo -e "   - ${RED}JA${NC} (Grund: ${REBOOT_REASON})"
else
    echo -e "   - ${GREEN}Nein${NC}"
fi

if [ "$CLEVIS_WARNING" == "Ja" ]; then
    echo -e "\n${RED}================================================================${NC}"
    echo -e "${RED}   ACHTUNG: FIRMWARE-UPDATE BEI SECURE BOOT & CLEVIS (TPM2)     ${NC}"
    echo -e "${RED}================================================================${NC}"
    echo -e "${YELLOW}Durch das Firmware-Update verändern sich voraussichtlich die${NC}"
    echo -e "${YELLOW}TPM-PCR-Werte. Clevis wird dein LUKS-Laufwerk beim nächsten${NC}"
    echo -e "${YELLOW}Booten NICHT automatisch entsperren können!${NC}\n"
    echo -e "1. Halte dein normales ${YELLOW}LUKS-Passwort${NC} für den Neustart bereit."
    
    if [ -n "$LUKS_DEV" ]; then
        echo -e "2. Sobald du im System bist, finde den TPM-Slot heraus:\n"
        echo -e "   ${CYAN}sudo clevis luks list -d ${LUKS_DEV}${NC}\n"
        echo -e "3. Erneuere das Binding mit der passenden Slot-Nummer (meistens 1):\n"
        echo -e "   ${CYAN}sudo clevis luks regen -d ${LUKS_DEV} -s <Slot-Nummer>${NC}\n"
    else
        echo -e "2. Sobald du im System bist, finde dein Laufwerk und Slot:\n"
        echo -e "   Laufwerk finden: ${CYAN}lsblk -f${NC} (Suche nach crypto_LUKS)"
        echo -e "   Slot finden:     ${CYAN}sudo clevis luks list -d <Dein-LUKS-Laufwerk>${NC}\n"
        echo -e "3. Erneuere das Binding mit der passenden Slot-Nummer:\n"
        echo -e "   ${CYAN}sudo clevis luks regen -d <Dein-LUKS-Laufwerk> -s <Slot-Nummer>${NC}\n"
    fi
fi

echo -e "\n${GREEN}================================================================${NC}"
echo -e "${GREEN}            WARTUNGSLAUF ERFOLGREICH ABGESCHLOSSEN              ${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}Ende: $(date '+%d.%m.%Y %H:%M:%S')${NC}\n"
