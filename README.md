# Ubuntu Maintenance Indicator - GNOME Shell Extension

> [!WARNING]
> **Privates Hobbyprojekt – nicht gepflegt / unmaintained.**
> Dieses Repository ist für meinen eigenen Gebrauch gedacht und wird nur aus Bequemlichkeit öffentlich bereitgestellt.
>
> * **Keine Unterstützung:** Issues und Pull Requests werden nicht bearbeitet, Feature-Wünsche nicht umgesetzt. Bitte keine Issues eröffnen.
> * **Keine Garantie:** Bereitstellung „wie besehen“, ohne jede Gewährleistung und Haftung. Nutzung auf eigenes Risiko.
> * **Eigene Umgebung:** Entwickelt und getestet nur auf meinen eigenen Ubuntu-Rechnern (24.04 / 26.04). Auf anderen Systemen kann es fehlschlagen.
> * **Erhöhte Rechte:** Die Extension läuft mit den Rechten deiner GNOME-Sitzung und startet auf Knopfdruck Befehle mit `pkexec`/`sudo` (z. B. UFW, `rkhunter --propupd`) und optional den Installer eines Drittprojekts (AM). **Lies den Code, bevor du ihn installierst.**
> * **Keine Updates zugesichert:** Es kann jederzeit ohne Ankündigung Änderungen, Brüche oder die Löschung des Repos geben. Gern selbst forken und anpassen.
>
> *Private hobby project, unmaintained, provided as-is. No support, no issues, no warranty. Fork it if you like.*

Native GNOME Shell Extension für Ubuntu 24.04+ (kompatibel mit GNOME 45, 46, 47, 48, 49, 50).

Überwacht den System- und Sicherheitszustand direkt in der GNOME Top-Bar und bietet eine moderne, modulare Kachel-Ansicht (Card-Look) nach dem Vorbild des *snmpbar* Design-Templates.

---

## 🌟 Features

* **GNOME Top-Bar Integration (Zero-Jitter)**:
  * Minimalistisches, monochromes Vektor-Symbolic-Icon (`security-high-symbolic`).
  * Tabular Numbers (`font-feature-settings: "tnum"`) verhindern jedes Wackeln der Leiste bei Zahlenwechseln.
  * Status-Badges: `{OK}` (Grün), `{3 Updates}` (Orange), `{ALARM}` (Rot).
* **Modulare Dropdown-Kacheln (Card-Look)**:
  * **Sicherheitswächter**:
    * UFW Firewall Status mit 1-Klick-Aktivierung (`pkexec ufw enable`).
    * Offene Netzwerk-Ports (autorisiert vs. unbekannt) mit detaillierter Protokoll-/Dienstauflistung.
    * Rootkit-Hunter (RKHunter) Status mit 1-Klick "Warnungen für KI in Zwischenablage kopieren" und `rkhunter --propupd` im Terminal.
    * Lynis System-Audit Timer.
    * System-Logs (Journal des aktuellen Boots, rein lesend): Kategorien USB, Datenträger, Speicher/OOM, Hardware/Thermik, Abstürze, fehlgeschlagene Dienste sowie AppArmor-`DENIED` und Prio-err-Meldungen (gruppiert). Prinzip: **bekannt von neu unterscheiden, nicht wegfiltern.**
      * Ignore-Einträge tragen eine Begründung und optional eine Obergrenze pro Boot (`max_per_boot`); überschreitet ein bekannter Eintrag sie, wird er wieder auffällig.
      * Unterdrücktes bleibt sichtbar: je Kategorie steht „unterdrückt (bekannt): 20× Grund“.
      * Neue Meldungstypen werden 3 Tage lang als **NEU** markiert (Basislinie beim ersten Lauf; `log_new_days` in `maintenance.json` ändert das Fenster).
      * Pflege per CLI (immer mit Vorschau): `maintenance_backend.py --ignore-preview MUSTER`, `--ignore-add MUSTER --reason TEXT [--max N]`, `--ignore-list`, `--ignore-remove NR|MUSTER`, `--seen-reset`. Dateien pro Rechner: `~/.config/ubuntu-maintenance-indicator/log_ignore.json`, `~/.local/state/ubuntu-maintenance-indicator/log_seen.json`.
      * Eingebautes Grundrauschen steht mit Begründung in `LOG_BUILTIN_IGNORE` im Backend. Hauptmenü: „Diagnose für KI kopieren“ und „Bekannte Log-Meldungen (Ignoreliste)“.
  * **System-Updates**:
    * APT-Updates (Aufschlüsselung nach Sicherheits- und regulären Updates).
    * Erkennung von Phased / Holdback-Updates.
    * Snap-Updates mit Konflikterkennung (z. B. laufendes Spotify/CUPS mit Beenden-Button).
    * Flatpak-Updates.
    * GNOME-Extensions-Updates über `gext` (Dry-Run `gext update -n`, nur sichtbar wenn `gext` vorhanden ist); bei defektem `gext` (z. B. pipx nach Python-Sprung) Hinweis mit Reparatur-Button (`pipx reinstall gnome-extensions-cli`).
    * AppImage-Updates über AM (nur sichtbar, wenn `am` installiert ist): Versionsvergleich `/opt/<app>/version` gegen die aktuelle Quelle, rein lesend; Aktualisierung per Button im Terminal (`am -u`).
    * Hinweis auf anstehenden Kernel-/Systemneustart (`/var/run/reboot-required`).
  * **Wartungsaktionen**:
    * 🚀 Starten des interaktiven Wartungsskripts `ubuntumaintenance.sh` im konfigurierten Terminal.
    * 📂 Direktzugriff auf den Protokollordner (`~/.local/state/ubuntu-maintenance-indicator/logs`).
    * 🔄 Sofortige Neuprüfung im Hintergrund (asynchron).
* **Native Libadwaita Preferences (`prefs.js`)**:
  * Konfigurierbares Prüfintervall, Terminal-Befehl und Panel-Position (Rechts, Mitte, Links).
  * Benachrichtigungs-Schalter für Updates und Sicherheitsalarme.
  * Integrierter Git-Versionsabgleich (GitHub / Gitea) mit Update-Prüfung per Klick.
* **Integrierter Updater (`updater.js` & `update.sh`)**:
  * Asynchrone Versionsprüfung via Soup 3.0 gegen die Remote-`metadata.json`.
  * Update-Banner bei neueren Releases.

---

## 🚀 Installation & Update

### Installation
```bash
cd gnomeextension
./install.sh
```
Das Installationsskript kompiliert die GSettings-Schemas, kopiert alle Dateien nach `~/.local/share/gnome-shell/extensions/ubuntu-maintenance@johnlose.de` und aktiviert die Extension.

### Aktualisierung
```bash
cd gnomeextension
./update.sh
```

---

### Optional: AM (AppImage-Manager)

`install.sh` (und damit auch `update.sh`) bietet am Ende an, [AM](https://github.com/ivan-hc/AM) zu installieren. AM verwaltet AppImages unter `/opt` und ist Grundlage für die AppImage-Aktualisierung.

* Die Frage erscheint nur interaktiv und nur, wenn `am` fehlt. Eine Ablehnung wird in `~/.local/state/ubuntu-maintenance-indicator/am-declined` gemerkt; Datei löschen, um erneut gefragt zu werden.
* AM ist ein Drittprojekt. Der Installer wird von GitHub geladen und läuft mit `sudo`.
* AM arbeitet **nicht** mit dem AppImageLauncher-DEB zusammen. Ist es installiert, warnt `install.sh` und überspringt AM (`sudo apt remove appimagelauncher`, danach neu starten).

---

## ⚙️ Technische Details & UUID

* **UUID**: `ubuntu-maintenance@johnlose.de`
* **Shell-Versionen**: `45`, `46`, `47`, `48`, `49`, `50`
* **GSettings-Schema**: `org.gnome.shell.extensions.ubuntu-maintenance`
* **Backend**: `maintenance_backend.py` (passives Python 3 Modul, greift auf `maintenance.json` zu)
