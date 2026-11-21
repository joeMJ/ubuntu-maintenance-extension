#!/usr/bin/env python3
"""
AM-Werkzeug (nur lesender Teil): Status, Verzeichnisprüfung und Umzugsplan für AppImages.

AM verwaltet AppImages entweder systemweit (/opt/<app>, braucht root zum Installieren/Entfernen)
oder lokal im Benutzerkontext ('am --user' bzw. 'appman', Ordner aus ~/.config/appman/appman-config).
Dieses Modul ändert NICHTS am System; es liefert JSON für die Einstellungen der Extension.

Aufruf (über maintenance_backend.py oder direkt):
  am_tool.py --am-status
  am_tool.py --am-check-dir <Pfad> [--need-bytes N]
  am_tool.py --am-migration-plan [--dir <Pfad>]
  am_tool.py --am-search <Begriff> [--all]       (rein lesend)
  am_tool.py --am-install-new <name> [<name>…]   (Benutzerordner, ohne root)
  am_tool.py --am-extra-hints                    (rein lesend)
  am_tool.py --am-install-extra <nutzer/projekt> <name> [<Schlüsselwort>]
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

SYSTEM_GLOB = "/opt/*/AM-updater"
APPMAN_CONFIG = os.path.expanduser("~/.config/appman/appman-config")
DEFAULT_USER_DIR = os.path.expanduser("~/Applications")
AM_SYSTEM_SCRIPT = os.environ.get("UM_AM_SCRIPT", "/opt/am/APP-MANAGER")
APPMAN_URL = "https://raw.githubusercontent.com/ivan-hc/AM/main/APP-MANAGER"

# Im ersten Wurf vom Umzug ausgeschlossen (Begründung wird angezeigt)
EXCLUDED = {
    "heroic-games-launcher": "AppArmor-Profil ist fest auf /opt/heroic-games-launcher/… eingestellt; nach dem Umzug würde der Start scheitern.",
    "heroic": "AppArmor-Profil ist fest auf /opt/heroic-games-launcher/… eingestellt; nach dem Umzug würde der Start scheitern.",
    "thorium": "Steht nicht in der AM-Datenbank (Installation über 'am -e', mit Variante AVX/AVX2). Bitte oben unter 'Externes GitHub-AppImage' installieren; der Vorschlag aus der Systeminstallation steht dort.",
    "thorium-browser": "Steht nicht in der AM-Datenbank (Installation über 'am -e', mit Variante AVX/AVX2). Bitte oben unter 'Externes GitHub-AppImage' installieren; der Vorschlag aus der Systeminstallation steht dort.",
}

# Dateisysteme, auf denen AppImages (Ausführrecht, Links) nicht zuverlässig laufen
BAD_FS = {"vfat", "msdos", "ntfs", "ntfs3", "fuseblk", "exfat"}
WARN_FS = {"nfs", "nfs4", "cifs", "smb3", "9p", "fuse", "fuse.sshfs"}
RESERVE = 1.2


def _run(args, timeout=10):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=dict(os.environ, LANG="C.UTF-8"))
        return r.returncode, r.stdout
    except Exception:
        return 1, ""


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path, followlinks=False):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def configured_user_dir():
    """Zielordner aus appman-config (einzige Quelle der Wahrheit), sonst Vorgabe."""
    try:
        with open(APPMAN_CONFIG, encoding="utf-8") as f:
            val = f.read().strip().splitlines()[0].strip()
        if val:
            return os.path.expanduser(val)
    except Exception:
        pass
    return DEFAULT_USER_DIR


def check_dir(path, need_bytes=0):
    """Prüft einen Zielordner. Rückgabe: {path, ok, checks:[{id,level,text}]}; level = ok|warn|fail."""
    checks = []

    def add(cid, level, text):
        checks.append({"id": cid, "level": level, "text": text})

    path = os.path.abspath(os.path.expanduser(path or ""))
    if not path or path == "/":
        add("path", "fail", "Kein gültiger Pfad.")
        return {"path": path, "ok": False, "checks": checks}

    # Existierenden Elternordner finden (Ordner kann noch nicht vorhanden sein)
    probe = path
    while probe and not os.path.exists(probe):
        probe = os.path.dirname(probe)
    exists = os.path.isdir(path)
    if os.path.exists(path) and not exists:
        add("exists", "fail", "Der Pfad ist vorhanden, aber kein Ordner.")
        return {"path": path, "ok": False, "checks": checks}
    if exists:
        add("exists", "ok", "Ordner ist vorhanden.")
    else:
        if os.access(probe, os.W_OK | os.X_OK):
            add("exists", "ok", f"Ordner wird angelegt (in {probe}).")
        else:
            add("exists", "fail", f"Ordner fehlt und kann nicht angelegt werden ({probe} ist nicht beschreibbar).")
            return {"path": path, "ok": False, "checks": checks}

    st = os.stat(probe)
    if exists:
        if os.access(path, os.W_OK | os.X_OK):
            add("write", "ok", "Schreib- und Zugriffsrecht für den aktuellen Benutzer vorhanden.")
        else:
            add("write", "fail", "Keine Schreibrechte im Ordner.")
        if st.st_uid == os.getuid():
            add("owner", "ok", "Der Ordner gehört dem aktuellen Benutzer.")
        else:
            add("owner", "warn", f"Der Ordner gehört einem anderen Benutzer (UID {st.st_uid}).")
        if path == "/tmp" or path.startswith("/tmp/") or path.startswith("/var/tmp"):
            add("tmp", "warn", "Temporärer Ordner: Inhalt kann beim Neustart verschwinden.")

    # Dateisystem und Mount-Optionen
    rc, out = _run(["findmnt", "-n", "-o", "FSTYPE,OPTIONS,TARGET", "-T", probe])
    if rc == 0 and out.strip():
        parts = out.split(None, 2)
        fstype = parts[0] if parts else ""
        opts = (parts[1] if len(parts) > 1 else "").split(",")
        target = parts[2].strip() if len(parts) > 2 else ""
        if "noexec" in opts:
            add("noexec", "fail", f"Der Datenträger ({target}) ist mit 'noexec' eingehängt: AppImages ließen sich nicht starten.")
        else:
            add("noexec", "ok", f"Programme dürfen ausgeführt werden (Datenträger {target}).")
        if "nosuid" in opts or "nodev" in opts:
            add("nosuid", "warn", "Der Datenträger hat 'nosuid' oder 'nodev'; manche AppImages brauchen das nicht, sie laufen meist trotzdem.")
        if fstype in BAD_FS:
            add("fs", "fail", f"Dateisystem '{fstype}' unterstützt Ausführrechte/Links nicht zuverlässig.")
        elif fstype in WARN_FS:
            add("fs", "warn", f"Dateisystem '{fstype}' (Netzwerk/FUSE): langsamer Start, Ausfall bei Verbindungsverlust möglich.")
        else:
            add("fs", "ok", f"Dateisystem '{fstype}' ist geeignet.")
    else:
        add("fs", "warn", "Dateisystem konnte nicht ermittelt werden.")

    # Freier Platz
    try:
        free = shutil.disk_usage(probe).free
        if need_bytes:
            need = int(need_bytes * RESERVE)
            if free >= need:
                add("space", "ok", f"Genug Platz: {free // 2**20} MB frei, benötigt ca. {need // 2**20} MB (inkl. 20 % Reserve).")
            else:
                add("space", "fail", f"Zu wenig Platz: {free // 2**20} MB frei, benötigt ca. {need // 2**20} MB (inkl. 20 % Reserve).")
        else:
            add("space", "ok", f"{free // 2**20} MB frei.")
    except Exception:
        add("space", "warn", "Freier Platz konnte nicht ermittelt werden.")

    # FUSE (AppImages hängen sich per FUSE ein)
    has_lib = bool(glob.glob("/usr/lib/*/libfuse.so.2") or glob.glob("/lib/*/libfuse.so.2") or glob.glob("/usr/lib/libfuse.so.2"))
    has_fm = bool(shutil.which("fusermount") or shutil.which("fusermount3"))
    if has_lib and has_fm:
        add("fuse", "ok", "FUSE ist vorhanden (libfuse2, fusermount).")
    else:
        add("fuse", "warn", "FUSE 2 fehlt (Paket libfuse2t64); viele AppImages starten dann nicht ohne --appimage-extract-and-run.")

    ok = not any(c["level"] == "fail" for c in checks)
    return {"path": path, "ok": ok, "checks": checks}


def am_status():
    """Welche AM-Programme sind vorhanden, welcher Modus ist eingerichtet."""
    am = shutil.which("am")
    appman = shutil.which("appman")
    user_dir = configured_user_dir()
    cfg_exists = os.path.isfile(APPMAN_CONFIG)
    sys_apps = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(SYSTEM_GLOB))
    user_apps = []
    if os.path.isdir(user_dir):
        user_apps = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(user_dir, "*", "AM-updater")))
    return {
        "am": am,
        "am_script": AM_SYSTEM_SCRIPT if os.path.isfile(AM_SYSTEM_SCRIPT) else None,
        "appman": appman,
        "user_dir": user_dir,
        "user_dir_configured": cfg_exists,
        "system_apps": sys_apps,
        "user_apps": user_apps,
        "can_run_user_mode": bool(am or appman),
    }


def migration_plan(target_dir=None):
    """Umzugsplan System (/opt) -> Benutzerordner. Rein lesend."""
    target = os.path.abspath(os.path.expanduser(target_dir)) if target_dir else configured_user_dir()
    apps = []
    for updater in sorted(glob.glob(SYSTEM_GLOB)):
        base = os.path.dirname(updater)
        name = os.path.basename(base)
        if name == "am":
            continue
        entry = {
            "name": name,
            "size": _dir_size(base),
            "version": "",
            "owned_by_user": False,
            "writable": os.access(base, os.W_OK),
            "excluded": name in EXCLUDED,
            "reason": EXCLUDED.get(name, ""),
            "already_in_user_dir": os.path.isdir(os.path.join(target, name)),
            "has_remove": os.path.isfile(os.path.join(base, "remove")),
        }
        try:
            entry["owned_by_user"] = os.stat(base).st_uid == os.getuid()
            with open(os.path.join(base, "version"), encoding="utf-8") as f:
                entry["version"] = f.read().strip().rsplit("/", 1)[-1]
        except Exception:
            pass
        # Entfernen-Skript der Systeminstallation: darf nur die drei bekannten Pfade löschen
        entry["remove_matches"] = _remove_script_matches(base, name)
        apps.append(entry)
    selectable = [a for a in apps if not a["excluded"] and not a["already_in_user_dir"]]
    need = sum(a["size"] for a in selectable)
    return {
        "target": target,
        "dir_check": check_dir(target, need),
        "apps": apps,
        "selectable_count": len(selectable),
        "need_bytes": need,
        "status": am_status(),
    }


def _remove_script_matches(base, name):
    """True, wenn /opt/<app>/remove nur die drei erwarteten Systempfade löscht (Abgleich vor dem Entfernen)."""
    path = os.path.join(base, "remove")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except Exception:
        return False
    expected = [f"/usr/local/bin/{name}", f"/opt/{name}", f"/usr/local/share/applications/{name}-AM.desktop"]
    if not all(e in text for e in expected):
        return False
    # Erlaubt sind nur diese Pfade und weitere Starter '<name>-<n>-AM.desktop' (AM legt bei Varianten mehrere an)
    extra = re.compile(r"^/usr/local/share/applications/" + re.escape(name) + r"(-\d+)?-AM\.desktop$")
    for m in re.finditer(r"\brm\b[^\n]*", text):
        for tok in re.findall(r"(/[\w./+@-]+)", m.group(0)):
            t = tok.rstrip("/")
            if t not in expected and not extra.match(t):
                return False
    return True


def _am_cmd():
    """Programm für den Benutzermodus: 'appman' bevorzugt, sonst 'am --user'."""
    # Hinweis: '--user' muss bei 'am' HINTER '-i' stehen (davor gibt AM nur einen Hinweis aus und installiert nichts)
    if shutil.which("appman"):
        return [shutil.which("appman")], []
    if shutil.which("am"):
        return [shutil.which("am")], ["--user"]
    return None


def _emit(kind, **kw):
    print(json.dumps(dict(kind=kind, **kw), ensure_ascii=False), flush=True)


def _write_appman_config(target):
    os.makedirs(os.path.dirname(APPMAN_CONFIG), exist_ok=True)
    if os.path.isfile(APPMAN_CONFIG):
        bak = APPMAN_CONFIG + ".bak-" + time.strftime("%Y-%m-%d")
        if not os.path.exists(bak):
            shutil.copy2(APPMAN_CONFIG, bak)
    with open(APPMAN_CONFIG, "w", encoding="utf-8") as f:
        f.write(target + "\n")


def verify_user_app(target, name):
    """Prüft eine im Benutzerordner installierte App. Rückgabe (ok, [Meldungen])."""
    msgs, ok = [], True
    base = os.path.join(target, name)
    exe = os.path.join(base, name)
    if not (os.path.isfile(exe) and os.access(exe, os.X_OK)):
        return False, [f"Programmdatei {exe} fehlt oder ist nicht ausführbar"]
    for f in ("AM-updater", "version", "remove"):
        if not os.path.isfile(os.path.join(base, f)):
            ok = False
            msgs.append(f"{f} fehlt")
    link = os.path.expanduser(f"~/.local/bin/{name}")
    if not os.path.lexists(link):
        ok = False
        msgs.append("Link in ~/.local/bin fehlt")
    desk = os.path.expanduser(f"~/.local/share/applications/{name}-AM.desktop")
    if not os.path.isfile(desk):
        msgs.append("Starter (.desktop) fehlt")
    try:
        r = subprocess.run([exe, "--appimage-version"], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            msgs.append("--appimage-version meldet Fehler (evtl. kein AppImage-Format, Start trotzdem möglich)")
    except Exception as e:
        msgs.append(f"--appimage-version nicht ausführbar: {e}")
    return ok, msgs


def install_user(target, names):
    """Installiert die Apps im Benutzerkontext (kein root). Streamt JSON-Zeilen; /opt bleibt unberührt."""
    am = _am_cmd()
    if not am:
        _emit("fatal", text="Weder AM noch AppMan gefunden.")
        return 2
    plan = migration_plan(target)
    allowed = {a["name"]: a for a in plan["apps"] if not a["excluded"] and not a["already_in_user_dir"]}
    bad = [n for n in names if n not in allowed]
    if bad:
        _emit("fatal", text="Nicht zulässig oder schon vorhanden: " + ", ".join(bad))
        return 2
    need = sum(allowed[n]["size"] for n in names)
    chk = check_dir(target, need)
    if not chk["ok"]:
        _emit("fatal", text="Zielordner ungeeignet: " + "; ".join(c["text"] for c in chk["checks"] if c["level"] == "fail"))
        return 2
    os.makedirs(target, exist_ok=True)
    _write_appman_config(target)
    state = os.path.expanduser("~/.local/state/ubuntu-maintenance-indicator")
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "am_migration_backup.json"), "w", encoding="utf-8") as f:
        json.dump({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "target": target, "apps": names,
                   "versions": {n: allowed[n]["version"] for n in names}}, f, ensure_ascii=False, indent=2)
    results = {}
    total = len(names)
    env = dict(os.environ, LANG="C.UTF-8", TERM="dumb")
    for i, n in enumerate(names, 1):
        _emit("step", index=i, total=total, app=n, text=f"Installiere {n} im Benutzerordner …")
        try:
            r = subprocess.run(am[0] + ["-y", "-i"] + am[1] + [n], capture_output=True, text=True, timeout=1800, env=env, stdin=subprocess.DEVNULL)
            tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
            tail = [l for l in (r.stdout + r.stderr).strip().splitlines()
                    if l.strip() and not re.search(r"\d+%|^[\s-]+$|^\s*\d+K ", l)][-3:]
            for line in tail:
                _emit("log", app=n, text=re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line))
            if r.returncode != 0:
                results[n] = {"ok": False, "msgs": [f"Installation Rückgabecode {r.returncode}"]}
                _emit("app", app=n, ok=False, msgs=results[n]["msgs"])
                continue
        except Exception as e:
            results[n] = {"ok": False, "msgs": [str(e)]}
            _emit("app", app=n, ok=False, msgs=results[n]["msgs"])
            continue
        ok, msgs = verify_user_app(target, n)
        results[n] = {"ok": ok, "msgs": msgs}
        _emit("app", app=n, ok=ok, msgs=msgs)
    _emit("result", target=target, results=results, verified=[n for n, v in results.items() if v["ok"]])
    return 0


def remove_system_script(names):
    """Erzeugt das root-Skript zum Entfernen der Systemversionen (ruft die von AM erzeugten remove-Skripte auf).

    Nur Apps, deren /opt/<app>/remove dem Erwarteten entspricht. Rückgabe {ok, problems, script, apps}."""
    problems, apps = [], []
    for n in names:
        if not re.fullmatch(r"[a-z0-9][a-z0-9._+-]*", n):
            problems.append(f"Ungültiger Name: {n}")
            continue
        base = f"/opt/{n}"
        if not os.path.isfile(base + "/remove") or not _remove_script_matches(base, n):
            problems.append(f"{n}: Entfernen-Skript fehlt oder weicht ab")
            continue
        apps.append(n)
    lines = ["#!/bin/sh", "[ \"$(id -u)\" -eq 0 ] || { echo 'Nur mit root-Rechten'; exit 1; }", "rc=0"]
    for n in apps:
        lines.append(f"echo 'Entferne Systemversion von {n} …'")
        lines.append(f"/opt/{n}/remove && echo 'OK {n}' || {{ echo 'FEHLER {n}'; rc=1; }}")
    lines.append("exit $rc")
    return {"ok": not problems and bool(apps), "problems": problems, "apps": apps, "script": "\n".join(lines) + "\n"}


def appman_install(download=False):
    """Legt AppMan (= das AM-Skript unter dem Namen 'appman') nach ~/.local/bin. Ohne root.

    Bevorzugt die lokale Kopie /opt/am/APP-MANAGER. Download nur mit download=True (Quelle: Zweig main, ohne Prüfsumme)."""
    import hashlib
    import urllib.request
    dest_dir = os.path.expanduser("~/.local/bin")
    dest = os.path.join(dest_dir, "appman")
    if os.path.exists(dest):
        return {"ok": False, "text": f"{dest} ist schon vorhanden; nichts geändert."}
    if os.path.isfile(AM_SYSTEM_SCRIPT):
        with open(AM_SYSTEM_SCRIPT, "rb") as f:
            data = f.read()
        source = f"lokale Kopie {AM_SYSTEM_SCRIPT}"
    elif download:
        try:
            with urllib.request.urlopen(APPMAN_URL, timeout=30) as r:
                data = r.read(5_000_000)
        except Exception as e:
            return {"ok": False, "text": f"Download fehlgeschlagen: {e}"}
        source = APPMAN_URL
    else:
        return {"ok": False, "need_download": True, "url": APPMAN_URL,
                "text": "Keine lokale Kopie vorhanden; ein Download von " + APPMAN_URL + " wäre nötig (nur nach Bestätigung)."}
    first = data.split(b"\n", 1)[0]
    if not (first.startswith(b"#!") and (b"sh" in first)) or not (20_000 < len(data) < 5_000_000) or b"AMCLI" not in data:
        return {"ok": False, "text": "Die Datei sieht nicht wie das AM-Skript aus; nichts installiert."}
    os.makedirs(dest_dir, exist_ok=True)
    tmp = dest + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o755)
    os.replace(tmp, dest)
    return {"ok": True, "path": dest, "source": source, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "text": f"AppMan installiert nach {dest} (Quelle: {source}). ~/.local/bin muss im PATH stehen."}


# ---------------------------------------------------------------------------
# Suche und Installation beliebiger AM-Programme im Benutzerordner (kein root)
# ---------------------------------------------------------------------------
APP_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._+-]{0,63}$")
SEARCH_TERM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$")
SEARCH_MAX = 60
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _am_binary():
    return shutil.which("am") or shutil.which("appman")


def _parse_am_list(text):
    """Zerlegt die Ausgabe von 'am -q': Einträge beginnen mit '◆ name : Beschreibung', Folgezeilen sind eingerückt."""
    entries, cur = [], None
    for raw in ANSI_RE.sub("", text).splitlines():
        m = re.match(r"^\s*◆\s+(\S+)\s*:\s*(.*)$", raw)
        if m:
            cur = {"name": m.group(1), "desc": m.group(2).strip()}
            entries.append(cur)
        elif cur is not None and raw.startswith("   ") and raw.strip():
            cur["desc"] = (cur["desc"] + " " + raw.strip()).strip()
        elif not raw.strip():
            cur = None if not entries else cur
    return entries


def _installed_where(name):
    user_dir = configured_user_dir()
    if os.path.isfile(os.path.join(user_dir, name, "AM-updater")):
        return "user"
    if os.path.isfile(f"/opt/{name}/AM-updater"):
        return "system"
    return None


def search_apps(term, appimages_only=True):
    """Sucht in der AM-Datenbank (rein lesend). Rückgabe {ok, term, results[], truncated, error}."""
    term = (term or "").strip()
    if not SEARCH_TERM_RE.match(term):
        return {"ok": False, "term": term, "results": [], "truncated": False,
                "error": "Suchbegriff leer oder ungültig (erlaubt: Buchstaben, Ziffern, Leerzeichen, . _ + -; höchstens 40 Zeichen)."}
    am = _am_binary()
    if not am:
        return {"ok": False, "term": term, "results": [], "truncated": False, "error": "Weder AM noch AppMan gefunden."}
    args = [am, "-q"] + (["--appimages"] if appimages_only else []) + [term]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                           env=dict(os.environ, LANG="C.UTF-8", TERM="dumb"))
    except Exception as e:
        return {"ok": False, "term": term, "results": [], "truncated": False, "error": f"Suche fehlgeschlagen: {e}"}
    entries = [e for e in _parse_am_list(r.stdout) if APP_NAME_RE.match(e["name"])]
    truncated = len(entries) > SEARCH_MAX
    for e in entries[:SEARCH_MAX]:
        e["installed"] = _installed_where(e["name"])
        e["variants_note"] = e["name"] in EXCLUDED
    return {"ok": True, "term": term, "results": entries[:SEARCH_MAX], "truncated": truncated, "error": ""}


def _am_knows(name):
    """Prüft über 'am -q --pkg', ob AM das Programm kennt (exakter Name)."""
    am = _am_binary()
    if not am or not APP_NAME_RE.match(name):
        return False
    try:
        r = subprocess.run([am, "-q", "--pkg", name], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                           env=dict(os.environ, LANG="C.UTF-8", TERM="dumb"))
    except Exception:
        return False
    return any(e["name"] == name for e in _parse_am_list(r.stdout))


def install_new(names):
    """Installiert beliebige AM-Programme im Benutzerordner (kein root). Streamt JSON-Zeilen wie install_user."""
    am = _am_cmd()
    if not am:
        _emit("fatal", text="Weder AM noch AppMan gefunden.")
        return 2
    target = configured_user_dir()
    bad = [n for n in names if not APP_NAME_RE.match(n)]
    if bad:
        _emit("fatal", text="Ungültiger Name: " + ", ".join(bad))
        return 2
    unknown = [n for n in names if not _am_knows(n)]
    if unknown:
        _emit("fatal", text="AM kennt dieses Programm nicht: " + ", ".join(unknown))
        return 2
    chk = check_dir(target, 300 * 2 ** 20 * len(names))
    if not chk["ok"]:
        _emit("fatal", text="Zielordner ungeeignet: " + "; ".join(c["text"] for c in chk["checks"] if c["level"] == "fail"))
        return 2
    os.makedirs(target, exist_ok=True)
    if not os.path.isfile(APPMAN_CONFIG):
        _write_appman_config(target)
    results, total = {}, len(names)
    env = dict(os.environ, LANG="C.UTF-8", TERM="dumb")
    for i, n in enumerate(names, 1):
        if _installed_where(n) == "user":
            results[n] = {"ok": True, "msgs": ["schon im Benutzerordner vorhanden"]}
            _emit("app", app=n, ok=True, msgs=results[n]["msgs"])
            continue
        _emit("step", index=i, total=total, app=n, text=f"Installiere {n} im Benutzerordner …")
        try:
            r = subprocess.run(am[0] + ["-y", "-i"] + am[1] + [n], capture_output=True, text=True, timeout=1800, env=env,
                               stdin=subprocess.DEVNULL)
            lines = [l for l in ANSI_RE.sub("", r.stdout + r.stderr).strip().splitlines()
                     if l.strip() and not re.search(r"\d+%|^[\s-]+$|^\s*\d+K ", l)][-3:]
            for line in lines:
                _emit("log", app=n, text=line)
            if r.returncode != 0:
                results[n] = {"ok": False, "msgs": [f"Installation Rückgabecode {r.returncode} (braucht das Programm eine Auswahl, z. B. eine Variante? Dann im Terminal installieren)"]}
                _emit("app", app=n, ok=False, msgs=results[n]["msgs"])
                continue
        except Exception as e:
            results[n] = {"ok": False, "msgs": [str(e)]}
            _emit("app", app=n, ok=False, msgs=results[n]["msgs"])
            continue
        ok, msgs = verify_user_app(target, n)
        results[n] = {"ok": ok, "msgs": msgs}
        _emit("app", app=n, ok=ok, msgs=msgs)
    _emit("result", target=target, results=results, verified=[n for n, v in results.items() if v["ok"]])
    return 0



# --- Externe GitHub-AppImages ('am -e'), z. B. Thorium mit Variante AVX2 ---
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$")
KEYWORD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$")
_SKIP_KEYWORDS = {"appimage", "x86_64", "amd64", "linux", "zsync", "sha256"}


def _normalize_repo(repo):
    repo = (repo or "").strip()
    m = re.match(r"^https?://github\.com/([^/\s]+/[^/\s#?]+?)(?:\.git)?/?$", repo)
    return m.group(1) if m else repo


def extra_hints():
    """Systeminstallationen, die mit 'am -e' (außerhalb der AM-Datenbank) installiert wurden: Repo und Schlüsselwort
    stehen im AM-updater. Rein lesend. Rückgabe [{name, repo, keyword}]."""
    names = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(SYSTEM_GLOB))
    am = _am_binary()
    known = set()
    if am and names:
        try:
            r = subprocess.run([am, "-q", "--pkg"] + names, capture_output=True, text=True, timeout=60,
                               stdin=subprocess.DEVNULL, env=dict(os.environ, LANG="C.UTF-8", TERM="dumb"))
            known = {e["name"] for e in _parse_am_list(r.stdout)}
        except Exception:
            known = set(names)  # im Zweifel nichts vorschlagen
    hints = []
    for n in names:
        if n in known or not APP_NAME_RE.match(n):
            continue
        try:
            with open(f"/opt/{n}/AM-updater", encoding="utf-8", errors="replace") as f:
                txt = f.read(20000)
        except OSError:
            continue
        m = re.search(r'^SITE="([^"/\s]+/[^"\s]+)"', txt, re.M) or re.search(r"api\.github\.com/repos/([^/\s]+/[^/\s]+)/releases", txt)
        if not m or not REPO_RE.match(m.group(1)):
            continue
        kws = [k for k in re.findall(r'grep -i "([A-Za-z0-9._+-]+)"', txt) if k.lower() not in _SKIP_KEYWORDS and KEYWORD_RE.match(k)]
        hints.append({"name": n, "repo": m.group(1), "keyword": kws[0] if kws else ""})
    return hints


def install_extra(repo, name, keyword=""):
    """Installiert ein GitHub-AppImage außerhalb der AM-Datenbank im Benutzerordner ('am -e --user'). Streamt JSON-Zeilen."""
    am = _am_cmd()
    repo = _normalize_repo(repo)
    if not am:
        _emit("fatal", text="Weder AM noch AppMan gefunden.")
        return 2
    if not REPO_RE.match(repo):
        _emit("fatal", text="Ungültiges Repository (erwartet: nutzer/projekt oder die GitHub-Adresse).")
        return 2
    if not APP_NAME_RE.match(name or ""):
        _emit("fatal", text="Ungültiger Programmname (erlaubt: Kleinbuchstaben, Ziffern, . _ + -).")
        return 2
    if keyword and not KEYWORD_RE.match(keyword):
        _emit("fatal", text="Ungültiges Schlüsselwort.")
        return 2
    target = configured_user_dir()
    chk = check_dir(target, 300 * 2 ** 20)
    if not chk["ok"]:
        _emit("fatal", text="Zielordner ungeeignet: " + "; ".join(c["text"] for c in chk["checks"] if c["level"] == "fail"))
        return 2
    if _installed_where(name) == "user":
        _emit("fatal", text=f"{name} ist im Benutzerordner schon vorhanden.")
        return 2
    os.makedirs(target, exist_ok=True)
    if not os.path.isfile(APPMAN_CONFIG):
        _write_appman_config(target)
    _emit("step", index=1, total=1, app=name, text=f"Installiere {name} von github.com/{repo}" + (f" (Variante {keyword})" if keyword else "") + " …")
    env = dict(os.environ, LANG="C.UTF-8", TERM="dumb")
    try:
        r = subprocess.run(am[0] + ["-y", "-e"] + am[1] + [repo, name] + ([keyword] if keyword else []),
                           capture_output=True, text=True, timeout=1800, env=env, stdin=subprocess.DEVNULL)
        for line in [l for l in ANSI_RE.sub("", r.stdout + r.stderr).strip().splitlines()
                     if l.strip() and not re.search(r"\d+%|^[\s-]+$|^\s*\d+K ", l)][-3:]:
            _emit("log", app=name, text=line)
        if r.returncode != 0:
            _emit("app", app=name, ok=False, msgs=[f"Installation Rückgabecode {r.returncode}"])
            _emit("result", target=target, results={name: {"ok": False, "msgs": []}}, verified=[])
            return 0
    except Exception as e:
        _emit("app", app=name, ok=False, msgs=[str(e)])
        _emit("result", target=target, results={name: {"ok": False, "msgs": [str(e)]}}, verified=[])
        return 0
    ok, msgs = verify_user_app(target, name)
    _emit("app", app=name, ok=ok, msgs=msgs)
    _emit("result", target=target, results={name: {"ok": ok, "msgs": msgs}}, verified=[name] if ok else [])
    return 0



def main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd = argv[0]

    def opt(name):
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None

    if cmd == "--am-status":
        print(json.dumps(am_status(), ensure_ascii=False, indent=2))
    elif cmd == "--am-check-dir" and len(argv) > 1:
        nb = opt("--need-bytes")
        print(json.dumps(check_dir(argv[1], int(nb) if nb and nb.isdigit() else 0), ensure_ascii=False, indent=2))
    elif cmd == "--am-migration-plan":
        print(json.dumps(migration_plan(opt("--dir")), ensure_ascii=False, indent=2))
    elif cmd == "--am-install" and len(argv) > 2:
        return install_user(os.path.abspath(os.path.expanduser(argv[1])), argv[2:])
    elif cmd == "--am-remove-script" and len(argv) > 1:
        print(json.dumps(remove_system_script(argv[1:]), ensure_ascii=False))
    elif cmd == "--appman-install":
        print(json.dumps(appman_install("--download" in argv), ensure_ascii=False))
    elif cmd == "--am-search" and len(argv) > 1:
        print(json.dumps(search_apps(argv[1], appimages_only="--all" not in argv), ensure_ascii=False))
    elif cmd == "--am-install-new" and len(argv) > 1:
        return install_new(argv[1:])
    elif cmd == "--am-extra-hints":
        print(json.dumps(extra_hints(), ensure_ascii=False))
    elif cmd == "--am-install-extra" and len(argv) > 2:
        return install_extra(argv[1], argv[2], argv[3] if len(argv) > 3 else "")
    elif cmd == "--am-verify" and len(argv) > 2:
        ok, msgs = verify_user_app(os.path.abspath(os.path.expanduser(argv[1])), argv[2])
        print(json.dumps({"ok": ok, "msgs": msgs}, ensure_ascii=False))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
