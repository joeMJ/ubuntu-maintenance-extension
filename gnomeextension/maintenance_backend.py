#!/usr/bin/env python3
"""
Maintenance and Security Backend for Ubuntu GNOME Extension
Provides passive, non-blocking system health checks (APT, Snap, Flatpak, AppImages via AM, GNOME-Extensions via gext, Log-Auffälligkeiten, UFW, Ports, RKHunter, Lynis).
Outputs clean JSON for extension.js.
"""

import sys
import os
import re
import json
import glob
import shutil
import subprocess
import time
from datetime import datetime

DEFAULT_CONFIG_PATHS = [
    os.path.expanduser("~/.config/ubuntu-maintenance-indicator/maintenance.json"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "maintenance.json"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "maintenance.json"),
]

def load_config():
    for p in DEFAULT_CONFIG_PATHS:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f), os.path.abspath(p)
            except Exception as e:
                sys.stderr.write(f"Warning: Failed to load config {p}: {e}\n")
    return {}, None

def get_state_dir():
    state_dir = os.path.expanduser("~/.local/state/ubuntu-maintenance-indicator")
    os.makedirs(state_dir, exist_ok=True)
    return state_dir

def check_apt():
    result = {
        "normal": 0,
        "security": 0,
        "total": 0,
        "packages": [],
        "phased_count": 0,
        "phased_packages": [],
        "held_count": 0,
        "held_packages": []
    }

    try:
        res = subprocess.run(
            ["apt-get", "-s", "-o", "Debug::NoLocking=true", "dist-upgrade"],
            capture_output=True,
            text=True,
            timeout=10,
            env=dict(os.environ, LANG="C.UTF-8")
        )
        section = None
        for line in res.stdout.splitlines():
            line_s = line.strip()
            if "The following upgrades have been deferred due to phasing:" in line:
                section = "phased"
                continue
            elif "The following packages have been kept back:" in line:
                section = "held"
                continue
            elif "The following packages will be upgraded:" in line:
                section = "upgraded"
                continue
            elif line_s.endswith("not upgraded.") or " upgraded," in line_s or line_s.startswith("Conf ") or line_s.startswith("Inst "):
                section = None
                continue
            elif section and line.startswith("  "):
                pkgs = line.split()
                if section == "phased":
                    result["phased_packages"].extend(pkgs)
                elif section == "held":
                    result["held_packages"].extend(pkgs)
                elif section == "upgraded":
                    result["packages"].extend(pkgs)

        result["phased_count"] = len(result["phased_packages"])
        result["held_count"] = len(result["held_packages"])
        result["total"] = len(result["packages"])
        result["normal"] = result["total"]
    except Exception:
        pass

    # Quick security check via update-notifier if available
    apt_check_bin = "/usr/lib/update-notifier/apt-check"
    if os.path.isfile(apt_check_bin) and os.access(apt_check_bin, os.X_OK):
        try:
            res = subprocess.run([apt_check_bin], capture_output=True, text=True, timeout=4)
            raw = (res.stderr or res.stdout).strip()
            if ";" in raw:
                parts = raw.split(";")
                result["security"] = int(parts[1])
        except Exception:
            pass

    # Paket-Beschreibungen und Kernel-Erkennung
    all_pkgs = list(dict.fromkeys(result["packages"] + result["phased_packages"] + result["held_packages"]))
    desc_map = {}
    if all_pkgs:
        try:
            # Batch apt-cache show für maximale Geschwindigkeit
            c_res = subprocess.run(
                ["apt-cache", "show"] + all_pkgs[:40],
                capture_output=True,
                text=True,
                timeout=4,
                env=dict(os.environ, LANG="de_DE.UTF-8")
            )
            cur_pkg = None
            for cline in c_res.stdout.splitlines():
                if cline.startswith("Package: "):
                    cur_pkg = cline.split(":", 1)[1].strip()
                elif cline.startswith("Description-de: ") and cur_pkg:
                    if cur_pkg not in desc_map:
                        desc_map[cur_pkg] = cline.split(":", 1)[1].strip()
                elif cline.startswith("Description: ") and cur_pkg:
                    if cur_pkg not in desc_map:
                        desc_map[cur_pkg] = cline.split(":", 1)[1].strip()
        except Exception:
            pass

    def build_details(pkg_list):
        items = []
        for p in pkg_list:
            is_kernel = any(p.startswith(k) for k in ["linux-image", "linux-headers", "linux-modules", "linux-generic"])
            desc = desc_map.get(p, "")
            if is_kernel and not desc:
                desc = "Linux-Kernel Systemabbild / Treiber"
            items.append({
                "name": p,
                "desc": desc,
                "is_kernel": is_kernel
            })
        items.sort(key=lambda x: (not x["is_kernel"], x["name"]))
        return items

    result["package_details"] = build_details(result["packages"])
    result["phased_details"] = build_details(result["phased_packages"])
    result["held_details"] = build_details(result["held_packages"])

    return result

def check_snap():
    result = {"count": 0, "packages": [], "details": []}
    try:
        res = subprocess.run(
            ["snap", "refresh", "--list"],
            capture_output=True,
            text=True,
            timeout=8,
            env=dict(os.environ, LANG="C.UTF-8")
        )
        lines = [l.strip() for l in res.stdout.splitlines() if l.strip() and not l.startswith("Name")]
        pkgs = [l.split()[0] for l in lines]
        result["count"] = len(pkgs)
        result["packages"] = pkgs

        for pkg in pkgs:
            is_running = False
            try:
                r = subprocess.run(["pgrep", "-f", pkg], capture_output=True)
                if r.returncode == 0:
                    is_running = True
            except Exception:
                pass
            result["details"].append({
                "name": pkg,
                "running": is_running
            })
    except Exception:
        pass
    return result

def check_flatpak():
    result = {"count": 0, "packages": []}
    try:
        res = subprocess.run(
            ["flatpak", "remote-ls", "--updates"],
            capture_output=True,
            text=True,
            timeout=8,
            env=dict(os.environ, LANG="C.UTF-8")
        )
        lines = [l.strip() for l in res.stdout.splitlines() if l.strip()]
        result["count"] = len(lines)
        result["packages"] = lines
    except Exception:
        pass
    return result

APPIMAGE_CACHE_FILE = os.path.expanduser("~/.local/state/ubuntu-maintenance-indicator/appimage_cache.json")
APPIMAGE_RETRY_SECONDS = 3600  # nicht prüfbare Apps (z. B. API-Limit) werden frühestens nach 1 h erneut abgefragt


def _appimage_interval_seconds():
    """Prüfintervall der AppImage-Abfrage (Umgebungsvariable der Extension, Standard 24 h)."""
    try:
        hours = int(os.environ.get("UM_APPIMAGE_INTERVAL_HOURS", "24"))
    except ValueError:
        hours = 24
    return max(1, min(hours, 24 * 30)) * 3600


def _load_appimage_cache():
    try:
        with open(APPIMAGE_CACHE_FILE) as f:
            data = json.load(f)
        return data.get("apps", {}) if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_appimage_cache(apps):
    try:
        os.makedirs(os.path.dirname(APPIMAGE_CACHE_FILE), exist_ok=True)
        tmp = APPIMAGE_CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"apps": apps}, f)
        os.replace(tmp, APPIMAGE_CACHE_FILE)
    except Exception:
        pass


def check_appimages(force=None):
    """AM-verwaltete AppImages (/opt/<app>): installierte vs. aktuelle Quelle. Installiert nichts.

    Nutzt die Zeile 'version=...' aus dem AM-Updater der jeweiligen App (ermittelt die aktuelle
    Download-URL, bei GitHub-Quellen per api.github.com) und vergleicht sie mit /opt/<app>/version.
    Das GitHub-Limit ohne Token liegt bei 60 Anfragen/Stunde je IP, daher wird je App zwischengespeichert:
    Ein Ergebnis gilt, bis das Prüfintervall (UM_APPIMAGE_INTERVAL_HOURS, Standard 24 h) abgelaufen ist
    oder sich die installierte Version ändert. Nicht prüfbare Apps werden nach 1 h erneut versucht.
    force=True (oder UM_APPIMAGE_FORCE=1) ignoriert den Cache.
    """
    result = {"available": False, "count": 0, "apps": []}
    if not shutil.which("am"):
        return result
    result["available"] = True
    if force is None:
        force = os.environ.get("UM_APPIMAGE_FORCE") == "1"
    interval = _appimage_interval_seconds()
    now = int(time.time())
    cache = _load_appimage_cache()
    new_cache = {}
    oldest = now
    for updater in sorted(glob.glob("/opt/*/AM-updater")):
        base = os.path.dirname(updater)
        name = os.path.basename(base)
        entry = {"name": name, "state": "error", "installed": "", "latest": ""}
        try:
            with open(os.path.join(base, "version")) as f:
                installed = f.read().strip()
            with open(updater) as f:
                lines = f.read().splitlines()
            line = next((l for l in lines[:12] if l.startswith("version=")), None)
            hit = cache.get(name)
            if (not force and isinstance(hit, dict) and hit.get("installed") == installed
                    and isinstance(hit.get("entry"), dict)):
                age = now - int(hit.get("checked", 0))
                ttl = interval if hit["entry"].get("state") in ("ok", "update") else min(interval, APPIMAGE_RETRY_SECONDS)
                if 0 <= age < ttl:
                    entry = hit["entry"]
                    new_cache[name] = hit
                    oldest = min(oldest, int(hit.get("checked", now)))
                    result["apps"].append(entry)
                    continue
            if line:
                res = subprocess.run(
                    ["sh", "-c", line + '; printf "%s" "$version"'],
                    capture_output=True, text=True, timeout=30,
                    env=dict(os.environ, LANG="C.UTF-8")
                )
                latest = res.stdout.strip()
                entry["installed"] = installed.rsplit("/", 1)[-1]
                entry["latest"] = latest.rsplit("/", 1)[-1]
                if latest:
                    entry["state"] = "update" if latest != installed else "ok"
                elif "api.github.com" in line:
                    # Leere Antwort bei GitHub-Quellen: meist das Anfragelimit der anonymen API (60/h), kein Defekt.
                    entry["hint"] = "github-api"
                new_cache[name] = {"checked": now, "installed": installed, "entry": entry}
        except Exception:
            pass
        result["apps"].append(entry)
    _save_appimage_cache(new_cache)
    result["count"] = sum(1 for a in result["apps"] if a["state"] == "update")
    result["unknown"] = sum(1 for a in result["apps"] if a["state"] not in ("update", "ok"))
    result["checked_at"] = oldest
    result["interval_hours"] = interval // 3600
    return result

def check_gext():
    """GNOME-Extensions-Updates via 'gext update -n' (Dry-Run, installiert nichts).

    gext liefert im Dry-Run den Rückgabecode 17, wenn Updates verfügbar sind. Extensions, die es auf
    extensions.gnome.org nicht gibt (z. B. eigene), werden ignoriert. Ein defektes gext (z. B. pipx-Umgebung
    nach Python-Sprung von Ubuntu 24.04 auf 26.04) wird als 'broken' gemeldet.
    """
    result = {"available": False, "count": 0, "extensions": [], "broken": False, "error": ""}
    gext = shutil.which("gext") or os.path.expanduser("~/.local/bin/gext")
    if not os.path.isfile(gext) or not os.access(gext, os.X_OK):
        return result
    result["available"] = True
    try:
        res = subprocess.run(
            [gext, "update", "-n"],
            capture_output=True, text=True, timeout=45,
            env=dict(os.environ, LANG="C.UTF-8", TERM="dumb")
        )
    except Exception as e:
        result["error"] = str(e)
        return result

    out = (res.stdout or "") + "\n" + (res.stderr or "")
    if res.returncode not in (0, 17):
        result["broken"] = True
        result["error"] = "ModuleNotFoundError" if "ModuleNotFoundError" in out else f"Rückgabecode {res.returncode}"
        return result

    for line in out.splitlines():
        m = re.search(r"Found extension (.+?) \(([^)]+)\)(.*?):\s*(.+?)\s*$", line)
        if not m:
            continue
        name, uuid, ver, state = m.group(1), m.group(2), m.group(3).strip(), m.group(4)
        result["extensions"].append({
            "name": name, "uuid": uuid, "version": ver,
            "state": "ok" if state == "up-to-date" else "update", "detail": state,
        })
    result["count"] = sum(1 for e in result["extensions"] if e["state"] == "update")
    # Rückgabecode 17 ohne erkannte Zeile: trotzdem als Update werten
    if res.returncode == 17 and result["count"] == 0:
        result["count"] = 1
    return result

# ------------------------------------------------------------------------------
# Log-Auffälligkeiten (journalctl, rein lesend)
#
# Prinzip: Nicht wegfiltern, sondern "bekannt" von "neu" unterscheiden.
#  1. Ignore-Einträge tragen eine Begründung (und optional eine Obergrenze pro Boot).
#  2. Unterdrücktes bleibt sichtbar: je Kategorie wird die Zahl der unterdrückten Zeilen samt Grund ausgewiesen.
#  3. Überschreitet ein bekannter Eintrag seine Obergrenze (max_per_boot), wird er wieder auffällig.
#  4. Meldungstypen, die noch nie gesehen wurden, werden einige Tage lang als NEU markiert (Basislinie beim ersten Lauf).
#
# Dateien (pro Rechner):
#   ~/.config/ubuntu-maintenance-indicator/log_ignore.json   Ignore-Einträge (pattern, reason, added, max_per_boot)
#   ~/.local/state/ubuntu-maintenance-indicator/log_seen.json  bereits gesehene Meldungstypen
# ------------------------------------------------------------------------------
LOG_CATEGORIES = [
    ("usb", "USB", "warn",
     r"usb \d[\d.-]*: (device descriptor read/\w+, error|unable to enumerate|device not accepting address|Cannot enable|over-current)"
     r"|xhci_hcd.*(died|Host halt|Host System Error|Transfer error)"
     r"|reset (low|full|high|super)(-| )speed USB device"
     r"|error -71|disabled by hub"),
    ("storage", "Datenträger", "warn",
     r"I/O error|blk_update_request|Buffer I/O error|EXT4-fs (error|warning)|BTRFS (error|warning)|XFS .*(error|corruption)"
     r"|nvme\d.*(timeout|reset|I/O Cmd|controller is down)|ata\d+(\.\d+)?: .*(failed|error|exception|hard resetting)|critical medium error"),
    ("memory", "Speicher (OOM)", "warn",
     r"Out of memory|oom-kill|oom_reaper|invoked oom-killer|Killed process"),
    ("hardware", "Hardware/Thermik", "warn",
     r"Hardware Error|mce: |Machine check|PCIe Bus Error|AER: (Corrected|Uncorrected|Multiple)|pcieport.*(Uncorrected|Corrected error)"
     r"|temperature above threshold|cpu clock throttled|critical temperature|thermal.*throttl"),
    ("crash", "Abstürze", "warn",
     r"segfault at|general protection fault|traps: .*(trap|general protection)|dumped core|kernel BUG|Oops:"),
    ("apparmor", "AppArmor", "info", r'apparmor="DENIED"'),
]

# Eingebautes Grundrauschen (Regex, Begründung). Wird nicht versteckt, sondern je Kategorie als "unterdrückt" ausgewiesen.
LOG_BUILTIN_IGNORE = [
    (r"kvm_amd: CPU \d+ isn't AMD", "kvm_amd auf Intel-CPU (harmlos)"),
    (r"Unable to locate IOAPIC", "Firmware-Eigenheit (IOAPIC/GSI)"),
    (r"integrity: Problem loading X\.509", "Kernel-Zertifikat (integrity)"),
    (r"KHO: Failed to reserve", "kexec-Handover (lowmem)"),
    (r"libsane_rules_end", "udev-Regel libsane (Syntaxfehler, kosmetisch)"),
    (r"75-davincipanel\.rules", "udev-Regel davincipanel (kosmetisch)"),
    (r"uvcvideo.*Failed to query \(GET_(DEF|CUR)\)", "Webcam-Steuerabfragen (UVC)"),
]

LOG_NEW_DAYS_DEFAULT = 3   # so viele Tage gilt ein erstmals gesehener Meldungstyp als NEU
LOG_SEEN_MAX = 5000        # Obergrenze der gemerkten Meldungstypen


def log_ignore_path():
    return os.path.expanduser("~/.config/ubuntu-maintenance-indicator/log_ignore.json")


def log_seen_path():
    return os.path.join(get_state_dir(), "log_seen.json")


def _atomic_write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def load_user_ignore():
    """Benutzer-Einträge aus log_ignore.json (Liste von Dicts, ungeprüft auf Regex)."""
    try:
        with open(log_ignore_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return [e for e in data.get("entries", []) if isinstance(e, dict) and isinstance(e.get("pattern"), str)]
    except Exception:
        return []


def save_user_ignore(entries):
    _atomic_write_json(log_ignore_path(), {"entries": entries})


def load_ignore_entries(cfg=None):
    """Alle aktiven Ignore-Einträge (eingebaut, Benutzerdatei, Legacy 'log_ignore' aus maintenance.json), Regex kompiliert."""
    raw = [{"pattern": p, "reason": r, "builtin": True} for p, r in LOG_BUILTIN_IGNORE]
    for e in load_user_ignore():
        raw.append({
            "pattern": e["pattern"], "reason": e.get("reason") or "(ohne Begründung)",
            "added": e.get("added", ""), "max_per_boot": e.get("max_per_boot"), "builtin": False,
        })
    for p in (cfg or {}).get("log_ignore", []):
        if isinstance(p, str):
            raw.append({"pattern": p, "reason": "maintenance.json (log_ignore)", "builtin": False})
    entries = []
    for e in raw:
        try:
            e["rx"] = re.compile(e["pattern"], re.IGNORECASE)
        except re.error:
            continue
        entries.append(e)
    return entries


def load_seen():
    """None = noch keine Basislinie vorhanden."""
    try:
        with open(log_seen_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d.get("seen"), dict) else None
    except Exception:
        return None


def _days_since(iso_date):
    try:
        return (datetime.now() - datetime.strptime(iso_date, "%Y-%m-%d")).days
    except Exception:
        return 9999


def _log_normalize(line):
    """Zeile für die Gruppierung vereinheitlichen (Zahlen/Hex/PIDs raus, AppArmor auf Profil|Operation|Ziel)."""
    if 'apparmor="DENIED"' in line:
        g = {k: re.search(k + r'="([^"]*)"', line) for k in ("profile", "operation", "name", "capname", "requested_mask")}
        target = next((g[k].group(1) for k in ("name", "capname", "requested_mask") if g[k]), "")
        prof = g["profile"].group(1) if g["profile"] else "?"
        op = g["operation"].group(1) if g["operation"] else "?"
        return f"{prof} | {op} | {target}"
    line = re.sub(r"0x[0-9a-fA-F]+|\b[0-9a-f]{8,}\b|\d+", "N", line)
    return line.strip()[:160]


def _journal_lines(args, timeout=25):
    try:
        res = subprocess.run(
            ["journalctl", "-b", "--no-pager", "-q", "-o", "cat"] + args,
            capture_output=True, text=True, timeout=timeout,
            env=dict(os.environ, LANG="C.UTF-8")
        )
        return res.stdout.splitlines()
    except Exception:
        return None


def _log_scan(lines, entries):
    """Zeilen gruppieren. Rückgabe: (groups, suppressed), suppressed = {Index des Ignore-Eintrags: Anzahl}."""
    groups, supp = {}, {}
    for l in lines:
        if not l.strip():
            continue
        hit = next((i for i, e in enumerate(entries) if e["rx"].search(l)), None)
        if hit is not None:
            supp[hit] = supp.get(hit, 0) + 1
            continue
        key = _log_normalize(l)
        g = groups.get(key)
        if g:
            g["count"] += 1
        else:
            groups[key] = {"count": 1, "example": l.strip()[:200]}
    return groups, supp


def _build_category(cid, label, level, lines, entries, seen, baseline_run, today, new_days):
    """Eine Kategorie auswerten. Rückgabe: (Kategorie-Dict, seen_geändert)."""
    groups, supp = _log_scan(lines, entries)
    changed = False

    top, new_groups = [], 0
    for key, g in groups.items():
        if baseline_run:
            seen[key] = "baseline"
            is_new = False
            changed = True
        else:
            first = seen.get(key)
            if first is None:
                seen[key] = first = today
                changed = True
            is_new = first != "baseline" and _days_since(first) <= new_days
        if is_new:
            new_groups += 1
        top.append({"text": key, "count": g["count"], "example": g["example"], "new": is_new})
    top.sort(key=lambda t: (not t["new"], -t["count"]))
    total = sum(t["count"] for t in top)

    supp_items, exceeded_any, supp_total = [], False, 0
    for idx, n in sorted(supp.items(), key=lambda kv: -kv[1]):
        e = entries[idx]
        mx = e.get("max_per_boot")
        exceeded = isinstance(mx, int) and mx > 0 and n > mx
        supp_items.append({"reason": e["reason"], "count": n, "max": mx if isinstance(mx, int) else None,
                           "exceeded": exceeded, "builtin": bool(e.get("builtin"))})
        if exceeded:
            exceeded_any = True
            total += n
            top.insert(0, {"text": f"bekannt, aber ungewöhnlich oft: {e['reason']} ({n} > max {mx})",
                           "count": n, "example": f"bekannt, aber ungewöhnlich oft: {e['reason']} ({n} > max {mx})",
                           "new": False, "exceeded": True})
        else:
            supp_total += n

    if level == "warn":
        alert = total > 0
    else:
        alert = new_groups > 0 or exceeded_any

    cat = {
        "id": cid, "label": label, "level": level, "count": total, "top": top[:5],
        "new": new_groups, "exceeded": exceeded_any, "alert": alert,
        "suppressed": {"count": supp_total, "items": supp_items},
    }
    return cat, changed


def check_logs(cfg=None):
    """Auffälligkeiten im Journal des aktuellen Boots, gruppiert nach Kategorie.

    Ändert nichts am System; schreibt lediglich den Merkzettel der gesehenen Meldungstypen (log_seen.json).
    """
    result = {"available": False, "flagged": 0, "new_count": 0, "baseline": False, "categories": []}
    cfg = cfg or {}
    lines = _journal_lines([])
    if lines is None:
        return result
    result["available"] = True

    entries = load_ignore_entries(cfg)
    state = load_seen()
    baseline_run = state is None
    seen = {} if baseline_run else state["seen"]
    result["baseline"] = baseline_run
    today = datetime.now().strftime("%Y-%m-%d")
    new_days = cfg.get("log_new_days", LOG_NEW_DAYS_DEFAULT)
    if not isinstance(new_days, int):
        new_days = LOG_NEW_DAYS_DEFAULT
    seen_changed = False

    for cid, label, level, pattern in LOG_CATEGORIES:
        rx = re.compile(pattern, re.IGNORECASE)
        cat, ch = _build_category(cid, label, level, [l for l in lines if rx.search(l)],
                                  entries, seen, baseline_run, today, new_days)
        seen_changed = seen_changed or ch
        result["categories"].append(cat)

    err_lines = _journal_lines(["-p", "err"]) or []
    cat, ch = _build_category("errors", "Fehlermeldungen (Prio err)", "info", err_lines,
                              entries, seen, baseline_run, today, new_days)
    seen_changed = seen_changed or ch
    result["categories"].append(cat)

    # Fehlgeschlagene systemd-Dienste
    failed = []
    try:
        r = subprocess.run(["systemctl", "--failed", "--no-legend", "--plain"], capture_output=True, text=True, timeout=8)
        failed = [l.split()[0] for l in r.stdout.splitlines() if l.strip()]
    except Exception:
        pass
    result["categories"].append({
        "id": "services", "label": "Fehlgeschlagene Dienste", "level": "warn", "count": len(failed),
        "top": [{"text": u, "count": 1, "example": u, "new": False} for u in failed[:5]],
        "new": 0, "exceeded": False, "alert": len(failed) > 0,
        "suppressed": {"count": 0, "items": []},
    })

    if seen_changed:
        if len(seen) > LOG_SEEN_MAX:
            seen = dict(list(seen.items())[-LOG_SEEN_MAX:])
        try:
            _atomic_write_json(log_seen_path(), {
                "baseline": (today if baseline_run else (state or {}).get("baseline", today)),
                "seen": seen,
            })
        except Exception:
            pass

    result["flagged"] = sum(1 for c in result["categories"] if c["alert"])
    result["new_count"] = sum(c["new"] for c in result["categories"])
    return result


def format_logs(data, detail=False):
    """Textausgabe: kompakt für das Wartungsskript, ausführlich (detail=True) für die KI-Übergabe."""
    out = []
    if detail:
        out.append("=== SYSTEM LOG DIAGNOSTIC FOR AI (journalctl, aktueller Boot) ===")
    if not data.get("available"):
        out.append("Journal nicht lesbar (Rechte: Gruppe systemd-journal oder adm nötig).")
        return "\n".join(out)
    if data.get("baseline"):
        out.append("(Erster Lauf: Basislinie angelegt, alle aktuellen Meldungstypen gelten als bekannt.)")
    for c in data["categories"]:
        mark = "!" if c.get("alert") else ("OK" if c["count"] == 0 else "i")
        suffix = f" (NEU: {c['new']})" if c.get("new") else ""
        out.append(f"[{mark}] {c['label']}: {c['count']}{suffix}")
        for t in c["top"][: (5 if detail else 2)]:
            text = t["example"] if detail else t["text"]
            tag = "NEU " if t.get("new") else ""
            out.append(f"      {t['count']}x {tag}{text}"[:220])
        sup = c.get("suppressed", {})
        shown = [s for s in sup.get("items", []) if not s.get("exceeded")]
        if shown:
            parts = "; ".join(f"{s['count']}x {s['reason']}" for s in shown)
            out.append(f"      unterdrückt (bekannt): {parts}"[:220])
    if detail:
        out.append("")
        out.append(_format_ignore_list())
    return "\n".join(out)


def _format_ignore_list():
    lines = ["Aktive Ignore-Einträge (Benutzerdatei " + log_ignore_path() + "):"]
    user = load_user_ignore()
    if not user:
        lines.append("  (keine Benutzer-Einträge)")
    for i, e in enumerate(user, 1):
        mx = e.get("max_per_boot")
        lines.append(f"  {i}. {e['pattern']}  | Grund: {e.get('reason', '-')} | seit {e.get('added', '?')}"
                     + (f" | max {mx}/Boot" if mx else ""))
    lines.append(f"  + {len(LOG_BUILTIN_IGNORE)} eingebaute Einträge (Grundrauschen, siehe LOG_BUILTIN_IGNORE im Backend)")
    return "\n".join(lines)


# --- CLI zur Pflege der Ignore-Liste (immer mit Vorschau, nie stilles Wegfiltern) -------------------------------
def cli_ignore_preview(pattern):
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        print(f"FEHLER: ungültiges Muster: {e}")
        return 2
    lines = _journal_lines([])
    if lines is None:
        print("Journal nicht lesbar.")
        return 1
    hits = [l for l in lines if rx.search(l)]
    print(f"Muster: {pattern}")
    print(f"Würde im aktuellen Boot {len(hits)} Zeile(n) unterdrücken.")
    groups, _ = _log_scan(hits, [])
    for key, g in sorted(groups.items(), key=lambda kv: -kv[1]["count"])[:5]:
        print(f"  {g['count']}x {g['example']}"[:200])
    return 0


def cli_ignore_add(pattern, reason, max_per_boot):
    try:
        re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        print(f"FEHLER: ungültiges Muster: {e}")
        return 2
    if not reason or not reason.strip():
        print("FEHLER: --reason (Begründung) ist Pflicht.")
        return 2
    entries = load_user_ignore()
    entry = {"pattern": pattern, "reason": reason.strip(), "added": datetime.now().strftime("%Y-%m-%d")}
    if max_per_boot:
        entry["max_per_boot"] = max_per_boot
    entries = [e for e in entries if e["pattern"] != pattern] + [entry]
    save_user_ignore(entries)
    print(f"OK: Eintrag gespeichert in {log_ignore_path()}")
    return cli_ignore_preview(pattern)


def cli_ignore_remove(ref):
    entries = load_user_ignore()
    if ref.isdigit() and 1 <= int(ref) <= len(entries):
        removed = entries.pop(int(ref) - 1)
    else:
        match = [e for e in entries if e["pattern"] == ref]
        if not match:
            print("FEHLER: Eintrag nicht gefunden (Nummer aus --ignore-list oder exaktes Muster angeben).")
            return 2
        removed = match[0]
        entries = [e for e in entries if e is not removed]
    save_user_ignore(entries)
    print(f"OK: entfernt: {removed['pattern']} ({removed.get('reason', '-')})")
    return 0


def cli_seen_reset():
    try:
        os.remove(log_seen_path())
        print("OK: Merkzettel gelöscht. Beim nächsten Lauf wird eine neue Basislinie angelegt (alles Bestehende gilt als bekannt).")
    except FileNotFoundError:
        print("Kein Merkzettel vorhanden.")
    return 0


def check_firmware():
    result = {"count": 0, "devices": [], "details": []}
    try:
        res = subprocess.run(
            ["fwupdmgr", "get-updates", "--json"],
            capture_output=True,
            text=True,
            timeout=8,
            env=dict(os.environ, LANG="C.UTF-8")
        )
        if res.returncode == 0 and res.stdout.strip():
            data = json.loads(res.stdout)
            devs = data.get("Devices", [])
            result["count"] = len(devs)
            for d in devs:
                name = d.get("Name", "Unbekanntes Gerät")
                ver = d.get("Version", "")
                result["devices"].append(f"{name} ({ver})" if ver else name)
                result["details"].append(d)
        elif res.returncode == 2:
            result["count"] = 0
    except Exception:
        pass
    return result

def check_reboot():
    reboot_file = "/var/run/reboot-required"
    if os.path.isfile(reboot_file):
        pkgs = []
        pkgs_file = "/var/run/reboot-required.pkgs"
        if os.path.isfile(pkgs_file):
            try:
                with open(pkgs_file, "r") as f:
                    pkgs = [l.strip() for l in f if l.strip()]
            except Exception:
                pass
        return {"required": True, "packages": pkgs}
    return {"required": False, "packages": []}

def check_ufw():
    try:
        res = subprocess.run(
            ["systemctl", "is-active", "ufw"],
            capture_output=True,
            text=True,
            timeout=3
        )
        is_active = (res.stdout.strip() == "active")
        return {"active": is_active, "status": "active" if is_active else "inactive"}
    except Exception as e:
        return {"active": False, "status": f"error: {e}"}

def check_ports(cfg):
    sec_cfg = cfg.get("security", {})
    allowed_ports_list = sec_cfg.get("allowed_ports", [])
    allowed_ports_map = {item["port"]: item.get("service", "Allowed") for item in allowed_ports_list}
    allowed_procs = set(sec_cfg.get("allowed_processes", []))

    all_external = []
    risky_ports = []

    try:
        res = subprocess.run(
            ["ss", "-tlpn"],
            capture_output=True,
            text=True,
            timeout=5,
            env=dict(os.environ, LANG="C.UTF-8")
        )
        lines = res.stdout.strip().splitlines()[1:]
        seen_keys = set()

        for line in lines:
            if "LISTEN" not in line:
                continue
            parts = line.split()
            if len(parts) < 4:
                continue

            proto = "tcp"
            local_addr = parts[3]
            match = re.search(r"^(.*):(\d+)$", local_addr)
            if not match:
                continue
            ip = match.group(1)
            port = int(match.group(2))

            # Exclude localhost / loopback
            if ip.startswith("127.") or ip in ("[::1]", "::1", "localhost"):
                continue

            # Unique key to avoid duplicate proto/port entries
            ukey = f"{proto}:{port}"
            if ukey in seen_keys:
                continue
            seen_keys.add(ukey)

            # Process extraction: prefer users:(("process_name" before cgroups
            proc = ""
            p_match = re.search(r'users:\(\(\"([^\"]+)\"', line)
            if p_match:
                proc = p_match.group(1)
            else:
                m_gen = re.search(r'\"([^\"]+)\"', line)
                if m_gen:
                    proc = m_gen.group(1)

            service_name = allowed_ports_map.get(port, "")
            is_allowed = bool((port in allowed_ports_map) or (proc and proc in allowed_procs))

            entry = {
                "proto": proto,
                "ip": ip,
                "port": port,
                "process": proc,
                "service": service_name or proc or "Unknown",
                "allowed": is_allowed
            }
            all_external.append(entry)
            if not is_allowed:
                risky_ports.append(entry)
    except Exception as e:
        sys.stderr.write(f"Port check error: {e}\n")

    return {
        "status": "ok" if not risky_ports else "warning",
        "total_external": len(all_external),
        "unknown_count": len(risky_ports),
        "unknown_ports": risky_ports,
        "all_external": all_external
    }

def check_rkhunter(cfg):
    sec_cfg = cfg.get("security", {})
    log_path = sec_cfg.get("rkhunter_log_path", "/var/log/rkhunter.log")
    ignore_patterns = sec_cfg.get("rkhunter_ignore_regex", [])

    if not os.path.isfile(log_path):
        return {
            "status": "missing_log",
            "warnings_count": 0,
            "warnings": [],
            "message": "Logdatei nicht vorhanden (Scan läuft nachts)"
        }

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except PermissionError:
        return {
            "status": "permission_denied",
            "warnings_count": 0,
            "warnings": [],
            "message": "Kein Lesezugriff auf Logdatei"
        }
    except Exception as e:
        return {
            "status": "error",
            "warnings_count": 0,
            "warnings": [],
            "message": str(e)
        }

    ignore_re = None
    if ignore_patterns:
        pattern_str = "|".join(ignore_patterns)
        ignore_re = re.compile(pattern_str, re.IGNORECASE)

    raw_warnings = []
    for line in lines:
        if "warning" in line.lower():
            if ignore_re and ignore_re.search(line):
                continue
            cleaned = line.strip()
            if cleaned and cleaned not in raw_warnings:
                raw_warnings.append(cleaned)

    alert_log_path = os.path.join(get_state_dir(), "rkhunter_alert.log")
    if raw_warnings:
        try:
            with open(alert_log_path, "w", encoding="utf-8") as af:
                af.write(f"=== RKHunter Alert Log: {datetime.now().isoformat()} ===\n")
                af.write(f"Total Warnings: {len(raw_warnings)}\n\n")
                for w in raw_warnings:
                    af.write(f"{w}\n")
        except Exception:
            pass

    return {
        "status": "warning" if raw_warnings else "ok",
        "warnings_count": len(raw_warnings),
        "warnings": raw_warnings,
        "alert_log": alert_log_path if raw_warnings else None
    }

def check_lynis(cfg):
    sec_cfg = cfg.get("security", {})
    report_path = sec_cfg.get("lynis_report_path", "/var/log/lynis-report.dat")
    timer_active = False

    try:
        res = subprocess.run(["systemctl", "is-active", "lynis.timer"], capture_output=True, text=True, timeout=3)
        timer_active = (res.stdout.strip() == "active")
    except Exception:
        pass

    warnings_count = 0
    if os.path.isfile(report_path) and os.access(report_path, os.R_OK):
        try:
            with open(report_path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("warning="):
                        val = line.split("=", 1)[1].strip()
                        if val.isdigit():
                            warnings_count = int(val)
                            break
        except Exception:
            pass

    return {
        "timer_active": timer_active,
        "warnings_count": warnings_count,
        "status": "ok" if warnings_count == 0 else "warning"
    }

# ---------------------------------------------------------------------------
# Kernel-Wächter: laufender/installierter Kernel-Typ und NVIDIA-Modul (rein lesend)
# ---------------------------------------------------------------------------
KERNEL_FLAVOUR_RE = re.compile(r"(?:^|-)\d+\.\d+\.\d+-\d+-([a-z][a-z0-9-]*)$")
DEFAULT_KERNEL_FLAVOURS = ["generic"]


def kernel_flavour(name):
    """Kernel-Typ aus 'uname -r' oder einem Paketnamen (z. B. linux-image-7.0.0-38-generic -> generic)."""
    m = KERNEL_FLAVOUR_RE.search(name or "")
    return m.group(1) if m else None


def check_kernel(cfg=None):
    """Prüft Kernel-Typ (nur erlaubte Flavours) und ob für eine vorhandene NVIDIA-Karte das Modul geladen ist."""
    cfg = cfg or {}
    allowed = cfg.get("allowed_kernel_flavours") or DEFAULT_KERNEL_FLAVOURS
    running = os.uname().release
    flavour = kernel_flavour(running)
    warnings = []

    running_ok = flavour is None or flavour in allowed
    if not running_ok:
        warnings.append(f"Fremd-Kernel läuft: {running} (erlaubt: {', '.join(allowed)})")

    foreign = []
    try:
        out = subprocess.run(["dpkg-query", "-W", "-f", "${db:Status-Abbrev}\t${Package}\n"],
                             capture_output=True, text=True, timeout=15).stdout
        for line in out.splitlines():
            status, _, pkg = line.partition("\t")
            if status.strip() == "ii" and pkg.startswith("linux-"):
                fl = kernel_flavour(pkg)
                if fl and fl not in allowed:
                    foreign.append(pkg)
    except Exception:
        pass
    if foreign:
        warnings.append(f"Fremd-Kernel installiert: {', '.join(sorted(foreign)[:4])}{' ...' if len(foreign) > 4 else ''}")

    nv = {"hardware": False, "driver_installed": False, "module_loaded": False, "module_package": None}
    try:
        lspci = subprocess.run(["lspci", "-n", "-d", "10de:"], capture_output=True, text=True, timeout=10).stdout
        nv["hardware"] = any((" 0300:" in l or " 0302:" in l) for l in lspci.splitlines())
    except Exception:
        pass
    if nv["hardware"]:
        try:
            names = subprocess.run(["dpkg-query", "-W", "-f", "${db:Status-Abbrev}\t${Package}\n"],
                                   capture_output=True, text=True, timeout=15).stdout.splitlines()
            installed = [l.partition("\t")[2] for l in names if l.startswith("ii")]
            nv["driver_installed"] = any(n.startswith(("nvidia-kernel-source-", "nvidia-driver-", "libnvidia-gl-")) for n in installed)
            mods = [n for n in installed if n.startswith("linux-modules-nvidia-") and n.endswith("-" + running)]
            nv["module_package"] = mods[0] if mods else None
            with open("/proc/modules", encoding="utf-8") as f:
                nv["module_loaded"] = any(l.startswith("nvidia ") for l in f)
        except Exception:
            pass
        if nv["driver_installed"] and not nv["module_loaded"]:
            hint = "" if nv["module_package"] else f" (Modulpaket linux-modules-nvidia-*-{running} fehlt)"
            warnings.append(f"NVIDIA-Treiber installiert, aber Modul nicht geladen{hint}")

    return {
        "running": running,
        "flavour": flavour,
        "allowed": allowed,
        "running_ok": running_ok,
        "foreign_installed": sorted(foreign),
        "nvidia": nv,
        "warnings": warnings,
        "flagged": len(warnings),
    }


def format_kernel(res):
    lines = []
    mark = "OK" if res.get("running_ok") else "!"
    lines.append(f"[{mark}] Laufender Kernel: {res.get('running')} (Typ {res.get('flavour') or 'unbekannt'}, erlaubt: {', '.join(res.get('allowed', []))})")
    fi = res.get("foreign_installed", [])
    fi_txt = ', '.join(fi[:4]) + (f' ... (+{len(fi) - 4})' if len(fi) > 4 else '') if fi else 'keiner'
    lines.append(f"[{'!' if fi else 'OK'}] Fremd-Kernel installiert: {fi_txt}")
    nv = res.get("nvidia", {})
    if nv.get("hardware"):
        bad = nv.get("driver_installed") and not nv.get("module_loaded")
        state = "Modul geladen" if nv.get("module_loaded") else ("Treiber installiert, Modul NICHT geladen" if nv.get("driver_installed") else "kein Treiber installiert")
        lines.append(f"[{'!' if bad else 'OK'}] NVIDIA: {state}")
    return "\n".join(lines)


def run_full_check():
    cfg, cfg_path = load_config()

    apt_res = check_apt()
    snap_res = check_snap()
    flatpak_res = check_flatpak()
    appimage_res = check_appimages()
    gext_res = check_gext()
    firmware_res = check_firmware()
    reboot_res = check_reboot()

    ufw_res = check_ufw()
    ports_res = check_ports(cfg)
    rk_res = check_rkhunter(cfg)
    lynis_res = check_lynis(cfg)
    logs_res = check_logs(cfg)
    kernel_res = check_kernel(cfg)

    # Determine security alerts
    security_alerts = []
    if not ufw_res.get("active"):
        security_alerts.append("Firewall (UFW) ist inaktiv!")
    if ports_res.get("unknown_count", 0) > 0:
        security_alerts.append(f"{ports_res['unknown_count']} unbekannte Netzwerk-Ports offen!")
    if rk_res.get("warnings_count", 0) > 0:
        security_alerts.append(f"RKHunter meldet {rk_res['warnings_count']} Warnung(en)!")

    # Overall State: CRITICAL > UPDATES > OK
    total_updates = apt_res["total"] + snap_res["count"] + flatpak_res["count"] + appimage_res["count"] + gext_res["count"] + firmware_res["count"]
    if security_alerts:
        overall_state = "CRITICAL"
    elif total_updates > 0 or reboot_res["required"]:
        overall_state = "UPDATES"
    else:
        overall_state = "OK"

    # Find running apps blocking snap updates
    blocked_snaps = [item["name"] for item in snap_res.get("details", []) if item.get("running")]

    data = {
        "timestamp": datetime.now().isoformat(),
        "config_path": cfg_path,
        "overall_state": overall_state,
        "security_alerts": security_alerts,
        "updates": {
            "total": total_updates,
            "apt": apt_res,
            "snap": snap_res,
            "flatpak": flatpak_res,
            "appimages": appimage_res,
            "gext": gext_res,
            "firmware": firmware_res,
            "reboot": reboot_res,
        },
        "security": {
            "ufw": ufw_res,
            "ports": ports_res,
            "rkhunter": rk_res,
            "lynis": lynis_res,
            "logs": logs_res,
            "kernel": kernel_res,
        },
        "blocked_snaps": blocked_snaps
    }
    return data

def main():
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "--copy-rkhunter":
            cfg, _ = load_config()
            rk = check_rkhunter(cfg)
            print("=== RKHUNTER DIAGNOSTIC FOR AI ===")
            print(f"Status: {rk.get('status')}")
            print(f"Warnings Count: {rk.get('warnings_count')}")
            for w in rk.get("warnings", []):
                print(f"- {w}")
            return
        elif cmd == "--ignore-list":
            print(_format_ignore_list())
            return
        elif cmd == "--ignore-preview" and len(sys.argv) > 2:
            sys.exit(cli_ignore_preview(sys.argv[2]))
        elif cmd == "--ignore-add" and len(sys.argv) > 2:
            def _opt(name):
                return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else None
            mx = _opt("--max")
            sys.exit(cli_ignore_add(sys.argv[2], _opt("--reason"), int(mx) if mx and mx.isdigit() else None))
        elif cmd == "--ignore-remove" and len(sys.argv) > 2:
            sys.exit(cli_ignore_remove(sys.argv[2]))
        elif cmd == "--seen-reset":
            sys.exit(cli_seen_reset())
        elif cmd == "--logs-text":
            cfg, _ = load_config()
            print(format_logs(check_logs(cfg)))
            return
        elif cmd == "--kernel-text":
            cfg, _ = load_config()
            print(format_kernel(check_kernel(cfg)))
            return
        elif cmd == "--copy-logs":
            cfg, _ = load_config()
            print(format_logs(check_logs(cfg), detail=True))
            return
        elif cmd == "--kill-snap" and len(sys.argv) > 2:
            pkg = sys.argv[2]
            try:
                subprocess.run(["pkill", "-f", pkg], timeout=5)
                print(f"OK: pkill -f {pkg}")
            except Exception as e:
                print(f"ERROR: {e}")
            return

    data = run_full_check()
    print(json.dumps(data, indent=2))

if __name__ == "__main__":
    main()
