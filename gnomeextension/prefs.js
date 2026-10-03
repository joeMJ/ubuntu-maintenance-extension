/**
 * prefs.js - Libadwaita / GTK4 Einstellungsdialog für Ubuntu Maintenance Indicator
 * Kompatibel mit GNOME 45, 46, 47, 48, 49, 50
 */

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UpdateChecker } from './updater.js';

export default class UbuntuMaintenancePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const currentVersion = this.metadata.version || 1;
        const updateChecker = new UpdateChecker(currentVersion);

        // ==========================================
        // Seite 1: Wartung & Anzeige
        // ==========================================
        const pageDisplay = new Adw.PreferencesPage({
            title: 'Wartung & Anzeige',
            icon_name: 'security-high-symbolic',
        });
        window.add(pageDisplay);

        // Gruppe 1: Panel-Leiste
        const groupPanel = new Adw.PreferencesGroup({
            title: 'GNOME Top-Bar Integration',
            description: 'Erscheinungsbild und Positionierung des Status-Indicators in der Leiste',
        });
        pageDisplay.add(groupPanel);

        // Position Dropdown
        const positionRow = new Adw.ComboRow({
            title: 'Position im Panel',
            subtitle: 'Wähle die Platzierung in der oberen GNOME-Leiste',
            model: new Gtk.StringList({
                strings: ['Rechts (neben Quick Settings)', 'Mitte (neben Datum/Uhrzeit)', 'Links'],
            }),
        });
        const currentPos = settings.get_string('panel-position');
        if (currentPos === 'center') {
            positionRow.selected = 1;
        } else if (currentPos === 'left') {
            positionRow.selected = 2;
        } else {
            positionRow.selected = 0; // right
        }

        positionRow.connect('notify::selected', () => {
            let val = 'right';
            if (positionRow.selected === 1) val = 'center';
            else if (positionRow.selected === 2) val = 'left';
            settings.set_string('panel-position', val);
        });
        groupPanel.add(positionRow);

        // Aktualisierungsintervall
        const intervalRow = new Adw.SpinRow({
            title: 'Prüfintervall (Minuten)',
            subtitle: 'Häufigkeit der automatischen Hintergrund-Systemprüfung',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 1440,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('refresh-interval-minutes'),
            }),
        });
        settings.bind('refresh-interval-minutes', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        groupPanel.add(intervalRow);

        // Terminal-Befehl
        const terminalRow = new Adw.EntryRow({
            title: 'Terminal-Befehl für Wartungsläufe',
            text: settings.get_string('terminal-command'),
        });
        settings.bind('terminal-command', terminalRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupPanel.add(terminalRow);

        // Gruppe 2: Benachrichtigungen
        const groupNotify = new Adw.PreferencesGroup({
            title: 'Desktop-Benachrichtigungen',
            description: 'Konfiguriere, wann GNOME-Benachrichtigungen eingeblendet werden',
        });
        pageDisplay.add(groupNotify);

        const notifyUpdatesRow = new Adw.SwitchRow({
            title: 'Bei anstehenden Updates benachrichtigen',
            subtitle: 'Benachrichtigung anzeigen, wenn APT, Snap oder Flatpak Updates bereitstehen',
        });
        settings.bind('notify-on-updates', notifyUpdatesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupNotify.add(notifyUpdatesRow);

        const notifyAlertRow = new Adw.SwitchRow({
            title: 'Bei Sicherheitswarnungen benachrichtigen',
            subtitle: 'Wichtige Benachrichtigung bei inaktiver Firewall, unbekannten Ports oder RKHunter-Funden',
        });
        settings.bind('notify-on-alert', notifyAlertRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupNotify.add(notifyAlertRow);

        // Gruppe 3: AppImages (AM) und GitHub-Anfragelimit
        const groupAppImage = new Adw.PreferencesGroup({
            title: 'AppImages (AM) & GitHub-Anfragelimit',
            description: 'Die AppImage-Prüfung fragt bei Apps mit GitHub-Quelle die GitHub-API ab. Ohne Anmeldung erlaubt GitHub nur ' +
                '60 Anfragen pro Stunde und IP-Adresse; alle Rechner und Container hinter derselben IP teilen sich dieses Limit.',
        });
        pageDisplay.add(groupAppImage);

        const aiIntervals = [1, 6, 24, 168];
        const aiIntervalRow = new Adw.ComboRow({
            title: 'Prüfintervall für AppImages',
            subtitle: 'Empfohlen: täglich. Neu prüfen: Menü „AppImages jetzt prüfen“.',
            model: new Gtk.StringList({
                strings: ['Stündlich', '6 Stunden', 'Täglich', 'Wöchentlich'],
            }),
        });
        const curAi = settings.get_int('appimage-check-interval-hours');
        let aiIdx = aiIntervals.findIndex(h => h >= curAi);
        aiIntervalRow.selected = aiIdx < 0 ? aiIntervals.length - 1 : aiIdx;
        aiIntervalRow.connect('notify::selected', () => {
            settings.set_int('appimage-check-interval-hours', aiIntervals[aiIntervalRow.selected]);
        });
        groupAppImage.add(aiIntervalRow);

        const tokenTitleRow = new Adw.ActionRow({
            title: 'GitHub-Token für AM (optional)',
            subtitle: 'Erhöht das Limit von 60 auf 5000 Anfragen pro Stunde',
        });
        tokenTitleRow.add_suffix(new Gtk.LinkButton({
            label: 'Token erzeugen',
            uri: 'https://github.com/settings/personal-access-tokens/new',
            valign: Gtk.Align.CENTER,
        }));
        groupAppImage.add(tokenTitleRow);

        // Anleitung als eigene Zeile über die volle Breite, normaler Textkontrast (Untertitel sind klein und gedimmt)
        const tokenHelp = new Gtk.Label({
            use_markup: true,
            wrap: true,
            xalign: 0,
            hexpand: true,
            selectable: true,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 14,
            margin_end: 14,
            label:
                '<b>So geht es:</b>\n' +
                '1. Auf GitHub einen <i>Fine-grained personal access token</i> erzeugen: Ablaufdatum wählen (je kürzer, desto sicherer), ' +
                '„Repository access“ = „Public repositories (read-only)“, keine weiteren Berechtigungen.\n' +
                '2. Im Terminal eintragen:  <tt>am apikey github_pat_…</tt>\n' +
                '3. Einmal <tt>am -u</tt> ausführen, damit AM den Token in die Updater übernimmt.\n\n' +
                '<b>Wichtig:</b> Den Token speichert AM selbst im Klartext (<tt>~/.local/share/AM/ghapikey.txt</tt> und in den ' +
                'AM-Updater-Dateien unter <tt>/opt</tt>); diese Extension speichert ihn nicht. Er läuft ab und muss dann erneuert ' +
                'werden (<tt>am apikey del</tt>, danach neu eintragen). Den Token nie weitergeben oder in ein Repository legen.',
        });
        groupAppImage.add(new Adw.PreferencesRow({ child: tokenHelp, activatable: false, focusable: false }));

        // ==========================================
        // Seite 2: Git-Updates & Repository
        // ==========================================
        const pageUpdate = new Adw.PreferencesPage({
            title: 'Git & Updates',
            icon_name: 'software-update-available-symbolic',
        });
        window.add(pageUpdate);

        const groupUpdate = new Adw.PreferencesGroup({
            title: 'Extension Versionsprüfung & Quelle',
            description: 'Automatische Aktualitätsprüfung über das Git-Repository (GitHub / Gitea)',
        });
        pageUpdate.add(groupUpdate);

        const updateEnableRow = new Adw.SwitchRow({
            title: 'Automatische Versionsprüfung aktiv',
            subtitle: 'Prüft regelmäßig im Hintergrund auf neuere Versionen der Extension',
        });
        settings.bind('update-check-enabled', updateEnableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(updateEnableRow);

        const gitUrlRow = new Adw.EntryRow({
            title: 'Git Repository URL (Quellcode)',
        });
        settings.bind('git-update-url', gitUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(gitUrlRow);

        const gitRawUrlRow = new Adw.EntryRow({
            title: 'Raw Metadata URL (Versionsabgleich)',
        });
        settings.bind('git-raw-metadata-url', gitRawUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        groupUpdate.add(gitRawUrlRow);

        // Versions-Status und Manueller Prüf-Button
        const infoRow = new Adw.ActionRow({
            title: `Installierte Version: v${currentVersion}`,
            subtitle: 'Aktualisierung über den Update-Eintrag im Menü (selfupdate.py) oder per install-remote.sh',
        });

        const checkBtn = new Gtk.Button({
            label: 'Jetzt prüfen',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });

        checkBtn.connect('clicked', async () => {
            checkBtn.sensitive = false;
            infoRow.subtitle = 'Prüfe Version auf Remote-Server...';
            try {
                const rawUrl = settings.get_string('git-raw-metadata-url');
                const res = await updateChecker.checkForUpdates(rawUrl);
                if (res.updateAvailable) {
                    infoRow.subtitle = `Update verfügbar: v${res.remoteVersion} (Aktuell: v${currentVersion})! Nutze den Update-Eintrag im Menü oder starte selfupdate.py.`;
                } else if (res.error) {
                    infoRow.subtitle = `Prüfung fehlgeschlagen: ${res.error}`;
                } else {
                    infoRow.subtitle = `Die Extension ist auf dem neuesten Stand (v${currentVersion}).`;
                }
            } catch (err) {
                infoRow.subtitle = `Fehler: ${err.message}`;
            } finally {
                checkBtn.sensitive = true;
            }
        });

        infoRow.add_suffix(checkBtn);
        groupUpdate.add(infoRow);
    }
}
