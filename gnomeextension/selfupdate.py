#!/usr/bin/env python3
"""
Selbst-Update der Extension aus den GitHub-Releases (nur Standardbibliothek).

Ablauf: neuestes Release ermitteln -> Tarball + SHA256-Datei von github.com laden
-> Prüfsumme prüfen -> sicher entpacken -> nach Rückfrage gnomeextension/install.sh ausführen.

Sicherheitsregeln:
  * nur HTTPS, nur github.com/<REPO>/releases/download/<Tag>/ (URLs werden selbst gebaut,
    nicht aus der API-Antwort übernommen)
  * Tag muss dem Muster vN[.N...] entsprechen
  * Tarball wird ohne absolute Pfade, '..' und Links entpackt
  * nichts wird ohne ausdrückliche Bestätigung installiert (--yes überspringt sie)
Die Prüfsumme liegt im selben Release; sie erkennt Übertragungsfehler, schützt aber nicht
vor einem kompromittierten GitHub-Konto. Vertrauensanker bleibt das Repository.

Aufruf: selfupdate.py [--check] [--yes]
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request

REPO = "joeMJ/ubuntu-maintenance-extension"
TAG_RE = re.compile(r"^v\d+(\.\d+){0,2}$")
MAX_BYTES = 20 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))


def _get(url, limit=MAX_BYTES):
    if not url.startswith("https://"):
        raise RuntimeError(f"Nur HTTPS erlaubt: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "ubuntu-maintenance-selfupdate"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read(limit + 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError(f"Nicht gefunden (404): {url} - gibt es schon ein Release?")
        raise
    if len(data) > limit:
        raise RuntimeError("Download zu groß, abgebrochen.")
    return data


def _ver(tag):
    return tuple(int(x) for x in tag.lstrip("v").split("."))


def local_version():
    with open(os.path.join(HERE, "metadata.json"), encoding="utf-8") as f:
        return (int(json.load(f).get("version", 0)),)


def latest_tag():
    info = json.loads(_get(f"https://api.github.com/repos/{REPO}/releases/latest", 1024 * 1024))
    tag = str(info.get("tag_name", ""))
    if not TAG_RE.match(tag):
        raise RuntimeError(f"Unerwarteter Release-Tag: {tag!r}")
    return tag


def safe_extract(tar_path, dest):
    with tarfile.open(tar_path, "r:gz") as tar:
        for m in tar.getmembers():
            name = os.path.normpath(m.name)
            if name.startswith(("/", "..")) or os.path.isabs(m.name) or ".." in m.name.split("/"):
                raise RuntimeError(f"Unsicherer Pfad im Archiv: {m.name}")
            if not (m.isfile() or m.isdir()):
                raise RuntimeError(f"Nicht erlaubter Eintragstyp im Archiv: {m.name}")
        tar.extractall(dest, filter="data")


def main():
    check_only = "--check" in sys.argv
    assume_yes = "--yes" in sys.argv

    tag = latest_tag()
    local, remote = local_version(), _ver(tag)
    print(f"Installiert: v{'.'.join(map(str, local))}   Neueste Version: {tag}")
    if remote <= local:
        print("Die Extension ist aktuell.")
        return 0
    if check_only:
        print("Update verfügbar.")
        return 10

    base = f"https://github.com/{REPO}/releases/download/{tag}"
    asset = f"ubuntu-maintenance-extension-{tag}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="ubuntu-maintenance-update-") as tmp:
        tar_path = os.path.join(tmp, asset)
        print(f"Lade {base}/{asset} ...")
        blob = _get(f"{base}/{asset}")
        sums = _get(f"{base}/{asset}.sha256", 4096).decode("utf-8", "replace").split()
        expected = sums[0].lower() if sums else ""
        actual = hashlib.sha256(blob).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", expected) or expected != actual:
            print(f"FEHLER: SHA256 stimmt nicht überein (erwartet {expected or '?'}, erhalten {actual}). Abbruch.")
            return 2
        print(f"SHA256 ok: {actual}")
        with open(tar_path, "wb") as f:
            f.write(blob)

        safe_extract(tar_path, tmp)
        roots = [d for d in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, d))]
        installer = os.path.join(tmp, roots[0], "gnomeextension", "install.sh") if len(roots) == 1 else ""
        if not os.path.isfile(installer):
            print("FEHLER: install.sh im Archiv nicht gefunden. Abbruch.")
            return 3

        if not assume_yes:
            print(f"\nDas Archiv enthält {installer.replace(tmp + '/', '')}. Es wird jetzt mit deinen Benutzerrechten ausgeführt.")
            if input("Update auf " + tag + " installieren? [j/N] ").strip().lower() not in ("j", "y", "ja", "yes"):
                print("Abgebrochen, nichts geändert.")
                return 1
        rc = subprocess.call(["bash", installer])
        if rc == 0:
            print("\nFertig. Melde dich einmal ab und wieder an (Wayland), damit GNOME die neue Version lädt.")
        return rc


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"FEHLER: {e}")
        sys.exit(4)
