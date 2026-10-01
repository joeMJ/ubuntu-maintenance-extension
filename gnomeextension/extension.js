/**
 * extension.js - Ubuntu Maintenance Indicator GNOME Shell Extension
 * Kompatibel mit GNOME Shell 45, 46, 47, 48, 49, 50
 * Exakte Umsetzung des snmpbar Design-Templates mit 3 Kacheln & Flyover-Sidecar
 */

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { UpdateChecker } from './updater.js';

// ==============================================================================
// Indicator Button Klasse (Zero-Jitter Top-Bar)
// ==============================================================================
const MaintenanceButton = GObject.registerClass(
class MaintenanceButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Ubuntu Maintenance Indicator', false);
        this._ext = extension;

        this._panelBox = new St.BoxLayout({
            style_class: 'maint-panel-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({
            icon_name: 'security-high-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelBox.add_child(this._icon);

        this._label = new St.Label({
            text: '',
            style_class: 'maint-bar-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._label);

        this.add_child(this._panelBox);

        if (this.menu && this.menu.box) {
            this.menu.box.add_style_class_name('maint-menu-box');
        }
    }

    updatePanel(state, updatesCount, alertCount, isChecking = false) {
        if (isChecking) {
            this._icon.icon_name = 'view-refresh-symbolic';
            this._label.text = '';
            return;
        }

        if (state === 'CRITICAL') {
            this._icon.icon_name = 'dialog-warning-symbolic';
            this._label.text = alertCount > 0 ? ` ${alertCount}` : ' !';
            this._label.set_style('color: #e01b24; font-weight: 700;');
        } else if (state === 'UPDATES') {
            this._icon.icon_name = 'software-update-available-symbolic';
            this._label.text = updatesCount > 0 ? ` ${updatesCount}` : '';
            this._label.set_style('color: #f57900; font-weight: 600;');
        } else {
            // Im Normalzustand (OK): Dezent & minimalistisch nur das Icon
            this._icon.icon_name = 'security-high-symbolic';
            this._label.text = '';
            this._label.set_style('');
        }
    }
});

// ==============================================================================
// Haupt-Extension Klasse
// ==============================================================================
export default class UbuntuMaintenanceExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._currentVersion = this.metadata.version || 1;
        this._updateChecker = new UpdateChecker(this._currentVersion);
        this._backendScript = GLib.build_filenamev([this.path, 'maintenance_backend.py']);

        this._timeoutId = null;
        this._gitUpdateTimeoutId = null;
        this._sidecarHideTimeout = null;
        this._hoverSidecar = null;
        this._isChecking = false;
        this._lastData = null;
        this._lastState = null;
        this._remoteUpdateInfo = null;

        // Dark-Mode Überwachung
        try {
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._interfaceChangedId = this._interfaceSettings.connect('changed::color-scheme', () => {
                if (this._lastData) this._rebuildMenu(this._lastData);
            });
        } catch (e) {
            this._interfaceSettings = null;
            this._interfaceChangedId = null;
        }

        // Indicator instanziieren und zum Panel hinzufügen
        this._buildIndicator();

        // Einstellungen überwachen
        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            if (key === 'panel-position') {
                this._repositionIndicator();
            } else if (key === 'refresh-interval-minutes') {
                this._rescheduleTimer();
            }
        });

        // Erste Prüfung starten
        this._triggerCheck();
        this._rescheduleTimer();

        // Git-Update Check starten falls aktiv
        if (this._settings.get_boolean('update-check-enabled')) {
            this._checkExtensionUpdate();
            this._gitUpdateTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 21600, () => {
                this._checkExtensionUpdate();
                return GLib.SOURCE_CONTINUE;
            });
        }

        console.log(`[ubuntu-maintenance] Extension ${this.uuid} aktiviert (v${this._currentVersion}).`);
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._gitUpdateTimeoutId) {
            GLib.source_remove(this._gitUpdateTimeoutId);
            this._gitUpdateTimeoutId = null;
        }
        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }
        if (this._hoverSidecar) {
            if (this._hoverSidecar.get_parent()) {
                this._hoverSidecar.get_parent().remove_child(this._hoverSidecar);
            }
            this._hoverSidecar.destroy();
            this._hoverSidecar = null;
        }
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._interfaceSettings && this._interfaceChangedId) {
            this._interfaceSettings.disconnect(this._interfaceChangedId);
            this._interfaceChangedId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
        this._interfaceSettings = null;
        console.log(`[ubuntu-maintenance] Extension ${this.uuid} deaktiviert.`);
    }

    _buildIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._indicator = new MaintenanceButton(this);
        const pos = this._settings ? this._settings.get_string('panel-position') : 'right';

        if (pos === 'center') {
            Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'center');
        } else if (pos === 'left') {
            Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');
        } else {
            Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
        }

        this._indicator.menu.connect('open-state-changed', (m, isOpen) => {
            if (!isOpen) {
                this._hideHoverSidecar(true);
            }
        });

        if (this._lastData) {
            const state = this._lastData.overall_state || 'OK';
            const totalUpdates = this._lastData.updates?.total || 0;
            const alertsCount = this._lastData.security_alerts ? this._lastData.security_alerts.length : 0;
            this._indicator.updatePanel(state, totalUpdates, alertsCount, false);
            this._rebuildMenu(this._lastData);
        } else {
            this._initPlaceholderMenu();
        }
    }

    _repositionIndicator() {
        this._buildIndicator();
    }

    _rescheduleTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const mins = this._settings ? this._settings.get_int('refresh-interval-minutes') : 30;
        const secs = Math.max(300, mins * 60);

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._triggerCheck();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _initPlaceholderMenu() {
        const item = new PopupMenu.PopupMenuItem('Initialisiere Systemprüfung …');
        item.reactive = false;
        this._indicator.menu.addMenuItem(item);
    }

    async _checkExtensionUpdate() {
        try {
            const rawUrl = this._settings.get_string('git-raw-metadata-url');
            const res = await this._updateChecker.checkForUpdates(rawUrl);
            const was = !!(this._remoteUpdateInfo && this._remoteUpdateInfo.updateAvailable);
            this._remoteUpdateInfo = (res && res.updateAvailable) ? res : null;
            if (was !== !!this._remoteUpdateInfo && this._lastData) this._rebuildMenu(this._lastData);
        } catch (e) {
            console.warn(`[ubuntu-maintenance] Git update check failed: ${e.message}`);
        }
    }

    _triggerCheck() {
        if (this._isChecking) return;
        this._isChecking = true;

        if (this._indicator) {
            this._indicator.updatePanel('OK', 0, 0, true);
        }

        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/python3', this._backendScript],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (source, res) => {
                this._isChecking = false;
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(res);
                    if (stdout) {
                        const data = JSON.parse(stdout);
                        this._applyCheckResults(data);
                    } else {
                        console.error(`[ubuntu-maintenance] Backend error: ${stderr}`);
                        this._applyCheckResults({
                            overall_state: 'CRITICAL',
                            security_alerts: ['Hintergrundprüfung fehlgeschlagen'],
                            updates: { total: 0, apt: {}, snap: {}, flatpak: {}, appimages: {}, gext: {}, firmware: {}, reboot: {} },
                            security: { ufw: {}, ports: {}, rkhunter: {}, lynis: {} },
                        });
                    }
                } catch (e) {
                    console.error(`[ubuntu-maintenance] Parse error: ${e.message}`);
                }
            });
        } catch (e) {
            this._isChecking = false;
            console.error(`[ubuntu-maintenance] Subprocess launch error: ${e.message}`);
        }
    }

    _applyCheckResults(data) {
        this._lastData = data;
        const state = data.overall_state || 'OK';
        const totalUpdates = data.updates?.total || 0;
        const alertsCount = data.security_alerts ? data.security_alerts.length : 0;

        if (this._indicator) {
            this._indicator.updatePanel(state, totalUpdates, alertsCount, false);
        }

        if (this._settings) {
            if (state === 'CRITICAL' && this._settings.get_boolean('notify-on-alert') && this._lastState !== 'CRITICAL') {
                const msg = data.security_alerts ? data.security_alerts.join('\n') : 'Sicherheitsproblem erkannt!';
                Main.notify('Sicherheitswarnung', msg);
            } else if (state === 'UPDATES' && this._settings.get_boolean('notify-on-updates') && this._lastState !== 'UPDATES' && totalUpdates > 0) {
                Main.notify('System-Updates verfügbar', `${totalUpdates} Aktualisierung(en) stehen bereit.`);
            }
        }
        this._lastState = state;

        this._rebuildMenu(data);
    }

    _isDarkMode() {
        if (!this._interfaceSettings) return true;
        const scheme = this._interfaceSettings.get_string('color-scheme');
        return scheme === 'prefer-dark';
    }

    // ==============================================================================
    // Flyover-Sidecar (Popout Fenster rechts neben dem Hauptdropdown)
    // ==============================================================================
    _getHoverSidecar() {
        if (!this._hoverSidecar) {
            this._hoverSidecar = new St.BoxLayout({
                vertical: true,
                style_class: 'maint-sidecar',
                reactive: false,
                can_focus: false,
            });
            Main.uiGroup.add_child(this._hoverSidecar);
            this._hoverSidecar.hide();
        }
        return this._hoverSidecar;
    }

    _hideHoverSidecar(immediate = false) {
        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }

        if (immediate) {
            if (this._hoverSidecar) {
                this._hoverSidecar.hide();
            }
            return;
        }

        this._sidecarHideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (this._hoverSidecar) {
                this._hoverSidecar.hide();
            }
            this._sidecarHideTimeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _showHoverSidecar(type, targetActor, isDark) {
        if (!this._indicator || !this._indicator.menu || !this._indicator.menu.isOpen) return;

        if (this._sidecarHideTimeout) {
            GLib.source_remove(this._sidecarHideTimeout);
            this._sidecarHideTimeout = null;
        }

        const sidecar = this._getHoverSidecar();
        sidecar.destroy_all_children();

        this._populateSidecar(sidecar, type, isDark);
        sidecar.show();

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._hoverSidecar || !this._indicator || !this._indicator.menu || !this._indicator.menu.isOpen) {
                return GLib.SOURCE_REMOVE;
            }

            try {
                if (!targetActor || !targetActor.get_stage || !targetActor.get_stage()) {
                    return GLib.SOURCE_REMOVE;
                }
                const [menuX, menuY] = this._indicator.menu.actor.get_transformed_position();
                const [menuW, menuH] = this._indicator.menu.actor.get_transformed_size();
                const [targetX, targetY] = targetActor.get_transformed_position();

                const monitor = Main.layoutManager.findMonitorForActor(this._indicator.menu.actor) || Main.layoutManager.primaryMonitor;
                const monitorRight = monitor.x + monitor.width;
                const monitorBottom = monitor.y + monitor.height;

                const sidecarW = sidecar.width > 0 ? sidecar.width : 420;
                const sidecarH = sidecar.height > 0 ? sidecar.height : 240;

                let posX = menuX + menuW + 8;
                if (posX + sidecarW > monitorRight - 10) {
                    posX = menuX - sidecarW - 8;
                }
                if (posX < monitor.x + 8) {
                    posX = monitor.x + 8;
                }

                const panelH = Main.panel ? Main.panel.height : 32;
                const minY = monitor.y + panelH + 8;
                const maxY = monitorBottom - sidecarH - 12;

                let posY = targetY - 14;
                if (posY < minY) posY = minY;
                if (posY > maxY) posY = Math.max(minY, maxY);

                sidecar.set_position(Math.round(posX), Math.round(posY));
                Main.uiGroup.set_child_above_sibling(sidecar, null);
            } catch (e) {
                console.error(`[ubuntu-maintenance] Fehler bei Sidecar-Positionierung: ${e}`);
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _populateSidecar(sidecar, type, isDark) {
        const sidecarBg = isDark ? '#242424' : '#ffffff';
        const sidecarBorder = isDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)';
        const textColor = isDark ? '#f6f6f6' : '#1a1a1a';
        const dimmedColor = isDark ? '#9a9a9a' : '#666666';
        const statusGreen = isDark ? '#33d17a' : '#26a269';
        const statusOrange = isDark ? '#ff7800' : '#e66100';
        const statusRed = isDark ? '#f66151' : '#c01c28';

        sidecar.style = `background-color: ${sidecarBg}; border: 1px solid ${sidecarBorder}; border-radius: 12px; padding: 14px 16px; min-width: 400px; max-width: 460px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);`;

        const data = this._lastData || {};
        const sec = data.security || {};
        const up = data.updates || {};
        const reboot = up.reboot || {};

        if (type === 'ports') {
            const ports = sec.ports || {};
            const all = ports.all_external || [];

            this._addSidecarHeader(sidecar, 'network-wired-symbolic', 'Offene Netzwerk-Ports', `${all.length} extern lauschend`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (all.length === 0) {
                listContainer.add_child(new St.Label({ text: 'Keine extern lauschenden Ports aktiv.', style: `color: ${dimmedColor}; font-size: 11px;` }));
            } else {
                all.forEach(p => {
                    const row = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-top: 3px; margin-bottom: 3px;' });
                    const icon = new St.Icon({
                        icon_name: p.allowed ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
                        icon_size: 12,
                        style: `margin-right: 6px; color: ${p.allowed ? statusGreen : statusRed};`,
                    });
                    const portLbl = new St.Label({
                        text: `${p.proto.toUpperCase()} ${p.port} `,
                        style: `color: ${textColor}; font-weight: bold; font-size: 11px; font-feature-settings: "tnum"; min-width: 68px;`,
                    });
                    const srvName = p.service || p.process || 'Dienst';
                    const srvLbl = new St.Label({
                        text: `${srvName} `,
                        style: `color: ${textColor}; font-size: 11px; font-weight: 500;`,
                        x_expand: true,
                    });
                    const ipLbl = new St.Label({
                        text: p.allowed ? '{Autorisiert}' : '{UNBEKANNT}',
                        style: `color: ${p.allowed ? statusGreen : statusRed}; font-size: 11px; font-weight: bold;`,
                    });
                    row.add_child(icon);
                    row.add_child(portLbl);
                    row.add_child(srvLbl);
                    row.add_child(ipLbl);
                    listContainer.add_child(row);
                });
            }
            sidecar.add_child(listContainer);

        } else if (type === 'apt') {
            const apt = up.apt || {};
            const pkgs = apt.package_details || [];
            const phased = apt.phased_details || [];
            const held = apt.held_details || [];

            this._addSidecarHeader(sidecar, 'package-x-generic-symbolic', 'APT Paketverwaltung', `${apt.total || 0} Aktualisierungen`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (pkgs.length === 0 && phased.length === 0 && held.length === 0) {
                listContainer.add_child(new St.Label({ text: '✓ Alle Systempakete sind auf dem neuesten Stand.', style: `color: ${statusGreen}; font-size: 11px; font-weight: 500;` }));
            } else {
                const renderPackageList = (items, headerTitle, titleColor) => {
                    listContainer.add_child(new St.Label({
                        text: headerTitle,
                        style: `color: ${titleColor}; font-size: 11px; font-weight: bold; margin-top: 6px; margin-bottom: 3px;`
                    }));

                    items.slice(0, 12).forEach(it => {
                        const row = new St.BoxLayout({
                            vertical: false,
                            y_align: Clutter.ActorAlign.CENTER,
                            style: 'margin-top: 2px; margin-bottom: 2px;'
                        });

                        const icon = new St.Icon({
                            icon_name: it.is_kernel ? 'computer-symbolic' : 'package-x-generic-symbolic',
                            icon_size: 12,
                            style: `margin-right: 6px; color: ${it.is_kernel ? statusOrange : textColor};`
                        });

                        const nameLbl = new St.Label({
                            text: it.name,
                            style: `color: ${it.is_kernel ? statusOrange : textColor}; font-weight: ${it.is_kernel ? 'bold' : '600'}; font-size: 11px; min-width: 130px;`
                        });

                        const descText = it.is_kernel && !it.desc ? 'Linux-Kernel Update' : (it.desc || '');
                        const descLbl = new St.Label({
                            text: descText ? ` ${descText}` : '',
                            style: `color: ${dimmedColor}; font-size: 11px;`,
                            x_expand: true,
                        });
                        descLbl.clutter_text.set_line_wrap(true);

                        row.add_child(icon);
                        row.add_child(nameLbl);
                        row.add_child(descLbl);

                        if (it.is_kernel) {
                            const badge = new St.Label({
                                text: '{Kernel}',
                                style: `color: ${statusOrange}; font-size: 10px; font-weight: bold; margin-left: 4px;`
                            });
                            row.add_child(badge);
                        }

                        listContainer.add_child(row);
                    });

                    if (items.length > 12) {
                        listContainer.add_child(new St.Label({
                            text: `… und ${items.length - 12} weitere Pakete`,
                            style: `color: ${dimmedColor}; font-size: 10px; margin-top: 2px;`
                        }));
                    }
                };

                if (pkgs.length > 0) {
                    renderPackageList(pkgs, 'Verfügbare Aktualisierungen:', textColor);
                }
                if (phased.length > 0) {
                    renderPackageList(phased, 'Phased/Holdback zurückgehalten:', dimmedColor);
                }
                if (held.length > 0) {
                    renderPackageList(held, 'Gepinnte Pakete (Hold):', dimmedColor);
                }
            }
            sidecar.add_child(listContainer);

        } else if (type === 'snap') {
            const snap = up.snap || {};
            const pkgs = snap.packages || [];
            const blocked = data.blocked_snaps || [];

            this._addSidecarHeader(sidecar, 'system-software-install-symbolic', 'Snap Anwendungs-Updates', `${snap.count || 0} ausstehend`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (pkgs.length === 0) {
                listContainer.add_child(new St.Label({ text: '✓ Alle installierten Snaps sind aktuell.', style: `color: ${statusGreen}; font-size: 11px; font-weight: 500;` }));
            } else {
                listContainer.add_child(new St.Label({ text: `Ausstehend: ${pkgs.join(', ')}`, style: `color: ${textColor}; font-size: 11px;` }));
            }
            if (blocked.length > 0) {
                listContainer.add_child(new St.Label({
                    text: `⚠️ Blockiert durch laufende Prozesse: ${blocked.join(', ')}`,
                    style: `color: ${statusOrange}; font-size: 11px; margin-top: 6px; font-weight: 500;`,
                }));
            }
            sidecar.add_child(listContainer);

        } else if (type === 'flatpak') {
            const flatpak = up.flatpak || {};
            const pkgs = flatpak.packages || [];

            this._addSidecarHeader(sidecar, 'application-x-executable-symbolic', 'Flatpak Apps & Runtimes', `${flatpak.count || 0} ausstehend`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (pkgs.length === 0) {
                listContainer.add_child(new St.Label({ text: '✓ Alle Flatpak-Laufzeitumgebungen und Apps sind aktuell.', style: `color: ${statusGreen}; font-size: 11px; font-weight: 500;` }));
            } else {
                listContainer.add_child(new St.Label({ text: pkgs.join(', '), style: `color: ${textColor}; font-size: 11px;` }));
            }
            sidecar.add_child(listContainer);

        } else if (type === 'appimages') {
            const ai = up.appimages || {};
            const apps = ai.apps || [];

            this._addSidecarHeader(sidecar, 'package-x-generic-symbolic', 'AppImages (AM)', `${ai.count || 0} ausstehend`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (apps.length === 0) {
                listContainer.add_child(new St.Label({ text: 'Keine AM-verwalteten AppImages gefunden.', style: `color: ${dimmedColor}; font-size: 11px;` }));
            } else {
                apps.forEach(a => {
                    let mark, color, detail;
                    if (a.state === 'update') {
                        mark = '↑'; color = statusOrange; detail = `${a.installed} → ${a.latest}`;
                    } else if (a.state === 'ok') {
                        mark = '✓'; color = statusGreen; detail = a.installed;
                    } else {
                        mark = '?'; color = dimmedColor; detail = 'Prüfung fehlgeschlagen';
                    }
                    const rowBox = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 3px;' });
                    rowBox.add_child(new St.Label({ text: `${mark} ${a.name}`, style: `color: ${color}; font-size: 11px; font-weight: 600; min-width: 150px;` }));
                    const d = new St.Label({ text: detail, style: `color: ${dimmedColor}; font-size: 10px;`, x_expand: true });
                    d.clutter_text.set_line_wrap(true);
                    rowBox.add_child(d);
                    listContainer.add_child(rowBox);
                });
                if ((ai.count || 0) > 0) {
                    listContainer.add_child(new St.Label({ text: 'Aktualisieren: Menüeintrag „AppImages aktualisieren“ unten im Hauptmenü.', style: `color: ${dimmedColor}; font-size: 10px; margin-top: 8px;` }));
                }
            }
            sidecar.add_child(listContainer);

        } else if (type === 'gext') {
            const gx = up.gext || {};
            const exts = gx.extensions || [];

            this._addSidecarHeader(sidecar, 'application-x-addon-symbolic', 'GNOME Shell Extensions (gext)', gx.broken ? 'defekt' : `${gx.count || 0} ausstehend`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (gx.broken) {
                listContainer.add_child(new St.Label({ text: '⚠️ gext lässt sich nicht starten (' + (gx.error || 'unbekannter Fehler') + ').', style: `color: ${statusOrange}; font-size: 11px; font-weight: 500;` }));
                const hint = new St.Label({ text: 'Typische Ursache: pipx-Umgebung nach einem Python-Sprung (z. B. Ubuntu 24.04 → 26.04).', style: `color: ${dimmedColor}; font-size: 10px; margin-top: 4px;` });
                hint.clutter_text.set_line_wrap(true);
                listContainer.add_child(hint);
                listContainer.add_child(new St.Label({ text: 'Reparieren: Menüeintrag „gext reparieren“ unten im Hauptmenü.', style: `color: ${dimmedColor}; font-size: 10px; margin-top: 8px;` }));
            } else if (exts.length === 0) {
                listContainer.add_child(new St.Label({ text: 'Keine Extensions von extensions.gnome.org gefunden.', style: `color: ${dimmedColor}; font-size: 11px;` }));
            } else {
                exts.forEach(e => {
                    const upd = e.state === 'update';
                    const rowBox = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 3px;' });
                    rowBox.add_child(new St.Label({ text: `${upd ? '↑' : '✓'} ${e.name}`, style: `color: ${upd ? statusOrange : statusGreen}; font-size: 11px; font-weight: 600; min-width: 150px;` }));
                    const d = new St.Label({ text: upd ? (e.detail || 'Update verfügbar') : (e.version || 'aktuell'), style: `color: ${dimmedColor}; font-size: 10px;`, x_expand: true });
                    d.clutter_text.set_line_wrap(true);
                    rowBox.add_child(d);
                    listContainer.add_child(rowBox);
                });
                if ((gx.count || 0) > 0) {
                    listContainer.add_child(new St.Label({ text: 'Aktualisieren: Menüeintrag „GNOME Extensions aktualisieren“ unten im Hauptmenü.', style: `color: ${dimmedColor}; font-size: 10px; margin-top: 8px;` }));
                }
            }
            sidecar.add_child(listContainer);

        } else if (type === 'firmware') {
            const fw = up.firmware || {};
            const devs = fw.devices || [];

            this._addSidecarHeader(sidecar, 'computer-symbolic', 'Geräte-Firmware (fwupd)', `${fw.count || 0} verfügbar`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (devs.length === 0) {
                listContainer.add_child(new St.Label({ text: '✓ Alle Geräte-Firmwares (UEFI, Controller, Peripherie) sind aktuell.', style: `color: ${statusGreen}; font-size: 11px; font-weight: 500;` }));
            } else {
                listContainer.add_child(new St.Label({ text: `Aktualisierungen verfügbar für:\n${devs.join('\n')}`, style: `color: ${statusOrange}; font-size: 11px;` }));
            }
            sidecar.add_child(listContainer);

        } else if (type === 'rkhunter') {
            const rk = sec.rkhunter || {};
            const warns = rk.warnings || [];

            this._addSidecarHeader(sidecar, 'system-search-symbolic', 'Rootkit-Hunter Status', `${rk.warnings_count || 0} Funde`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (warns.length === 0) {
                listContainer.add_child(new St.Label({ text: '✓ Keine Rootkits, Trojaner oder Hook-Muster erkannt.', style: `color: ${statusGreen}; font-size: 11px; font-weight: 500;` }));
            } else {
                listContainer.add_child(new St.Label({ text: 'Gefundene Warnungen im Audit-Log:', style: `color: ${statusRed}; font-size: 11px; font-weight: bold; margin-bottom: 4px;` }));
                warns.slice(0, 8).forEach(w => {
                    const wl = new St.Label({ text: `• ${w}`, style: `color: ${textColor}; font-size: 10px; margin-bottom: 2px;` });
                    wl.clutter_text.set_line_wrap(true);
                    listContainer.add_child(wl);
                });
            }
            listContainer.add_child(new St.Label({ text: 'KI-Übergabe: Menüeintrag „Diagnose für KI kopieren“ unten im Hauptmenü.', style: `color: ${dimmedColor}; font-size: 10px; margin-top: 8px;` }));
            sidecar.add_child(listContainer);

        } else if (type === 'logs') {
            const lg = sec.logs || {};
            const cats = lg.categories || [];

            this._addSidecarHeader(sidecar, 'dialog-information-symbolic', 'System-Logs (aktueller Boot)', `${lg.flagged || 0} auffällig`, textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            cats.forEach(c => {
                let mark, color;
                if (c.alert) { mark = '!'; color = statusOrange; }
                else if (c.count === 0) { mark = '✓'; color = statusGreen; }
                else { mark = 'i'; color = dimmedColor; }

                const head = new St.BoxLayout({ vertical: false, style: 'margin-top: 4px;' });
                head.add_child(new St.Label({ text: `${mark} ${c.label}`, style: `color: ${color}; font-size: 11px; font-weight: 600; min-width: 190px;` }));
                head.add_child(new St.Label({ text: `${c.count}${c.new ? `  (NEU: ${c.new})` : ''}`, style: `color: ${c.new ? statusOrange : textColor}; font-size: 11px;`, x_expand: true }));
                listContainer.add_child(head);

                (c.top || []).slice(0, 2).forEach(t => {
                    const tl = new St.Label({ text: `${t.count}× ${t.new ? 'NEU ' : ''}${t.text}`, style: `color: ${t.new || t.exceeded ? statusOrange : dimmedColor}; font-size: 10px; margin-left: 14px;` });
                    tl.clutter_text.set_line_wrap(true);
                    listContainer.add_child(tl);
                });

                // Unterdrücktes bleibt sichtbar (bekannte Meldungen samt Begründung)
                const shown = ((c.suppressed || {}).items || []).filter(s => !s.exceeded);
                if (shown.length > 0) {
                    const st = new St.Label({ text: `unterdrückt (bekannt): ${shown.map(s => `${s.count}× ${s.reason}`).join('; ')}`, style: `color: ${dimmedColor}; font-size: 10px; font-style: italic; margin-left: 14px;` });
                    st.clutter_text.set_line_wrap(true);
                    listContainer.add_child(st);
                }
            });
            listContainer.add_child(new St.Label({ text: 'KI-Übergabe: Menüeintrag „Diagnose für KI kopieren“ unten im Hauptmenü.', style: `color: ${dimmedColor}; font-size: 10px; margin-top: 8px;` }));
            sidecar.add_child(listContainer);

        } else if (type === 'kernel') {
            const kn = sec.kernel || {};
            const nvk = kn.nvidia || {};
            this._addSidecarHeader(sidecar, 'applications-system-symbolic', 'Kernel', (kn.flagged || 0) > 0 ? `{${kn.flagged} Hinweis}` : '{OK}', textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            const addLine = (ok, text) => {
                const l = new St.Label({ text: `${ok ? '✓' : '!'} ${text}`, style: `color: ${ok ? statusGreen : statusOrange}; font-size: 11px; margin-top: 3px;` });
                l.clutter_text.set_line_wrap(true);
                listContainer.add_child(l);
            };
            addLine(!!kn.running_ok, `Läuft: ${kn.running || '?'} (Typ ${kn.flavour || '?'}, erlaubt: ${(kn.allowed || []).join(', ')})`);
            const fi = kn.foreign_installed || [];
            addLine(fi.length === 0, fi.length ? `Fremd-Kernel installiert: ${fi.slice(0, 3).join(', ')}${fi.length > 3 ? ' …' : ''}` : 'Kein Fremd-Kernel installiert');
            if (nvk.hardware) {
                const bad = nvk.driver_installed && !nvk.module_loaded;
                addLine(!bad, nvk.module_loaded ? 'NVIDIA-Modul geladen' : (nvk.driver_installed ? 'NVIDIA-Treiber installiert, Modul NICHT geladen' : 'Kein NVIDIA-Treiber installiert'));
            }
            sidecar.add_child(listContainer);

        } else if (type === 'ufw') {
            const ufw = sec.ufw || {};

            this._addSidecarHeader(sidecar, 'security-high-symbolic', 'Firewall (UFW) Status', ufw.active ? '{Aktiv}' : '{INAKTIV}', textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            listContainer.add_child(new St.Label({
                text: ufw.active
                    ? '✓ Eingehende Verbindungen sind standardmäßig blockiert.\n✓ Nur autorisierte Dienste und Ports werden akzeptiert.'
                    : '⚠️ Firewall ist abgeschaltet! Eingehender Datenverkehr ist ungeschützt.',
                style: `color: ${ufw.active ? statusGreen : statusRed}; font-size: 11px;`,
            }));
            sidecar.add_child(listContainer);

        } else if (type === 'lynis') {
            const lynis = sec.lynis || {};

            this._addSidecarHeader(sidecar, 'view-list-symbolic', 'Lynis System-Audit', lynis.timer_active ? '{Timer Aktiv}' : '{Timer Inaktiv}', textColor, dimmedColor);

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            listContainer.add_child(new St.Label({
                text: lynis.timer_active
                    ? '✓ Der systemd-Timer (lynis.timer) führt regelmäßige nächtliche System-Audits durch.'
                    : 'Der automatische Audit-Timer ist nicht aktiv.',
                style: `color: ${lynis.timer_active ? textColor : dimmedColor}; font-size: 11px;`,
            }));
            sidecar.add_child(listContainer);

        } else if (type === 'reboot') {
            const pkgs = reboot.packages || [];

            this._addSidecarHeader(
                sidecar,
                'system-reboot-symbolic',
                'Systemneustart-Status',
                reboot.required ? '{Neustart erforderlich}' : '{Kein Neustart erforderlich}',
                textColor,
                dimmedColor
            );

            const listContainer = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
            if (reboot.required) {
                listContainer.add_child(new St.Label({
                    text: '⚠️ Ein Systemneustart ist erforderlich, um Aktualisierungen (z. B. Kernel) abzuschließen.',
                    style: `color: ${statusRed}; font-size: 11px; font-weight: bold; margin-bottom: 4px;`,
                }));
                if (pkgs.length > 0) {
                    listContainer.add_child(new St.Label({
                        text: `Auslösende Pakete:\n• ${pkgs.join('\n• ')}`,
                        style: `color: ${textColor}; font-size: 11px;`,
                    }));
                }
            } else {
                listContainer.add_child(new St.Label({
                    text: '✓ Kein Neustart erforderlich.\nAlle Systemdienste und Kernel-Module laufen aktuell.',
                    style: `color: ${statusGreen}; font-size: 11px; font-weight: 500;`,
                }));
            }
            sidecar.add_child(listContainer);
        }
    }

    _addSidecarHeader(sidecar, iconName, title, subtitle, textColor, dimmedColor) {
        const hRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            style: `margin-right: 8px; color: ${textColor};`,
        });
        const tLabel = new St.Label({
            text: title,
            style: `color: ${textColor}; font-weight: 800; font-size: 13px;`,
        });
        hRow.add_child(icon);
        hRow.add_child(tLabel);
        sidecar.add_child(hRow);

        if (subtitle) {
            const subLabel = new St.Label({
                text: subtitle,
                style: `color: ${dimmedColor}; font-size: 11px; margin-left: 24px; margin-top: 1px;`,
            });
            sidecar.add_child(subLabel);
        }
    }

    // ==============================================================================
    // Haupt-Dropdown Menü Aufbau (3 Kacheln & Flyover Hover Bindings)
    // ==============================================================================
    _rebuildMenu(data) {
        if (!this._indicator || !this._indicator.menu) return;
        const menu = this._indicator.menu;
        menu.removeAll();

        const isDark = this._isDarkMode();
        const textColor = isDark ? '#f6f6f6' : '#1a1a1a';
        const cardBorderColor = isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.16)';
        const cardBgColor = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.035)';
        const statusGreen = isDark ? '#33d17a' : '#26a269';
        const statusOrange = isDark ? '#ff7800' : '#e66100';
        const statusRed = isDark ? '#f66151' : '#c01c28';
        const dimmedColor = isDark ? '#9a9996' : '#77767b';

        const styleTitle = `color: ${textColor}; font-weight: 800; font-size: 13px;`;
        const cardStyle = `border: 1px solid ${cardBorderColor}; background-color: ${cardBgColor}; border-radius: 8px; padding: 10px 14px; margin: 4px 6px; min-width: 380px;`;

        const state = data.overall_state || 'OK';
        const up = data.updates || {};
        const sec = data.security || {};
        const apt = up.apt || {};
        const snap = up.snap || {};
        const flatpak = up.flatpak || {};
        const appimages = up.appimages || {};
        const gext = up.gext || {};
        const fw = up.firmware || {};
        const reboot = up.reboot || {};
        const ufw = sec.ufw || {};
        const ports = sec.ports || {};
        const rk = sec.rkhunter || {};
        const lynis = sec.lynis || {};
        const logs = sec.logs || {};
        const totalUpdates = up.total || 0;

        const hostName = GLib.get_host_name() || 'Ubuntu Host';

        // ======================================================================
        // Optionaler Extension-Update Banner (falls im Git eine neuere Version)
        // ======================================================================
        if (this._remoteUpdateInfo && this._remoteUpdateInfo.updateAvailable) {
            const bannerItem = new PopupMenu.PopupImageMenuItem(
                `Extension Update v${this._remoteUpdateInfo.remoteVersion} verfügbar!`,
                'software-update-available-symbolic'
            );
            bannerItem.connect('activate', () => {
                this._launchTerminal(`python3 '${GLib.build_filenamev([this.path, 'selfupdate.py'])}'`);
            });
            menu.addMenuItem(bannerItem);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // ======================================================================
        // RAHMEN 1: Kopf (PC Name, Letzte Prüfung, Reboot-Status, Gesamtstatus)
        // ======================================================================
        const card1Item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'maint-card-item',
        });
        const card1Box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'maint-card-box',
            style: cardStyle,
        });

        const title1Row = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const hostIcon = new St.Icon({
            icon_name: 'computer-symbolic',
            icon_size: 16,
            style: `margin-right: 8px; color: ${textColor};`,
        });
        const header1Label = new St.Label({
            text: hostName,
            style: styleTitle,
        });

        let statusText = '{System geschützt & aktuell}';
        let statusCol = statusGreen;
        if (state === 'CRITICAL') {
            statusText = '{Sicherheitswarnung!}';
            statusCol = statusRed;
        } else if (state === 'UPDATES') {
            statusText = `{${totalUpdates} Update${totalUpdates === 1 ? '' : 's'} verfügbar}`;
            statusCol = statusOrange;
        }

        const header1Status = new St.Label({
            text: `  ${statusText}`,
            style: `font-size: 11px; font-weight: bold; color: ${statusCol}; margin-left: 6px;`,
        });

        title1Row.add_child(hostIcon);
        title1Row.add_child(header1Label);
        title1Row.add_child(header1Status);
        card1Box.add_child(title1Row);

        let tsStr = 'gerade eben';
        if (data.timestamp) {
            try {
                const dt = new Date(data.timestamp);
                tsStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch (e) {
                tsStr = data.timestamp;
            }
        }
        const timeRow = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 24px; margin-top: 2px;',
        });
        const timeIcon = new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
            icon_size: 12,
            style: `margin-right: 5px; color: ${dimmedColor};`,
        });
        const timeLabel = new St.Label({
            text: `Letzte Prüfung: ${tsStr}`,
            style: `color: ${dimmedColor}; font-size: 11px;`,
        });
        timeRow.add_child(timeIcon);
        timeRow.add_child(timeLabel);
        card1Box.add_child(timeRow);

        // Zeile 3: Info ob Neustart erforderlich direkt unter der letzten Prüfung
        const rebootRow = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: true,
            track_hover: true,
            style_class: 'maint-interactive-row',
            style: 'margin-left: 18px; margin-top: 2px;',
        });
        const rebootIcon = new St.Icon({
            icon_name: 'system-reboot-symbolic',
            icon_size: 12,
            style: `margin-right: 5px; color: ${reboot.required ? statusRed : statusGreen};`,
        });
        const rebootTextLabel = new St.Label({
            text: 'Neustart: ',
            style: `color: ${dimmedColor}; font-size: 11px;`,
        });
        const rebootStatusLabel = new St.Label({
            text: reboot.required ? '{Erforderlich}' : '{Nicht erforderlich}',
            style: `font-size: 11px; font-weight: bold; color: ${reboot.required ? statusRed : statusGreen}; font-feature-settings: "tnum";`,
        });
        rebootRow.add_child(rebootIcon);
        rebootRow.add_child(rebootTextLabel);
        rebootRow.add_child(rebootStatusLabel);

        rebootRow.connect('enter-event', () => {
            this._showHoverSidecar('reboot', rebootRow, isDark);
            return Clutter.EVENT_PROPAGATE;
        });
        rebootRow.connect('leave-event', () => {
            this._hideHoverSidecar();
            return Clutter.EVENT_PROPAGATE;
        });
        card1Box.add_child(rebootRow);

        card1Item.add_child(card1Box);
        menu.addMenuItem(card1Item);

        // ======================================================================
        // RAHMEN 2: Sicherheit (Großes Schild-Icon, Topic: Sicherheit)
        // ======================================================================
        const card2Item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'maint-card-item',
        });
        const card2Box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'maint-card-box',
            style: cardStyle,
        });

        // Topic Header
        const secHeaderRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 6px;' });
        const secShieldIcon = new St.Icon({
            icon_name: 'security-high-symbolic',
            icon_size: 18,
            style: `margin-right: 8px; color: ${textColor};`,
        });
        const secHeaderLabel = new St.Label({
            text: 'Sicherheit',
            style: styleTitle,
        });
        const secHeaderStatus = new St.Label({
            text: state === 'CRITICAL' ? '  {Alarm}' : '  {Sicher}',
            style: `font-size: 11px; font-weight: bold; color: ${state === 'CRITICAL' ? statusRed : statusGreen}; margin-left: 6px;`,
        });
        secHeaderRow.add_child(secShieldIcon);
        secHeaderRow.add_child(secHeaderLabel);
        secHeaderRow.add_child(secHeaderStatus);
        card2Box.add_child(secHeaderRow);

        // Zeile 1: UFW Firewall
        const ufwRow = this._createInteractiveRow(
            'security-high-symbolic',
            'Firewall (UFW)',
            ufw.active ? '{Aktiv}' : '{INAKTIV!}',
            ufw.active ? statusGreen : statusRed,
            textColor,
            'ufw',
            isDark
        );
        card2Box.add_child(ufwRow);

        // Zeile 2: Offene Ports (Flyover zeigt vollständige Tabelle!)
        const unkCount = ports.unknown_count || 0;
        const totExt = ports.total_external || 0;
        const portsRow = this._createInteractiveRow(
            'network-wired-symbolic',
            'Offene Ports',
            unkCount > 0 ? `{${unkCount} UNBEKANNT!}` : `{${totExt} autorisiert}`,
            unkCount > 0 ? statusRed : statusGreen,
            textColor,
            'ports',
            isDark,
            unkCount === 0 ? '(alle verifiziert)' : ''
        );
        card2Box.add_child(portsRow);

        // Zeile 3: Rootkit-Hunter
        const rkWarns = rk.warnings_count || 0;
        const rkRow = this._createInteractiveRow(
            'system-search-symbolic',
            'Rootkit-Hunter',
            rkWarns === 0 ? '{0 Funde}' : `{${rkWarns} Warnung(en)!}`,
            rkWarns === 0 ? statusGreen : statusRed,
            textColor,
            'rkhunter',
            isDark
        );
        card2Box.add_child(rkRow);

        // Zeile 4: Lynis Audit
        const lynisRow = this._createInteractiveRow(
            'view-list-symbolic',
            'Lynis Audit',
            lynis.timer_active ? '{Aktiv}' : '{Timer inaktiv}',
            lynis.timer_active ? statusGreen : dimmedColor,
            textColor,
            'lynis',
            isDark
        );
        card2Box.add_child(lynisRow);

        // Zeile 5: System-Logs (Auffälligkeiten im Journal)
        if (logs.available) {
            const logFlags = logs.flagged || 0;
            const logRow = this._createInteractiveRow(
                'dialog-information-symbolic',
                'System-Logs',
                logFlags > 0 ? `{${logFlags} Auffällig}` : '{Unauffällig}',
                logFlags > 0 ? statusOrange : statusGreen,
                textColor,
                'logs',
                isDark
            );
            card2Box.add_child(logRow);
        }

        // Zeile 6: Kernel (Typ, Fremd-Kernel, NVIDIA-Modul)
        if (sec.kernel) {
            const kFlags = sec.kernel.flagged || 0;
            const kernelRow = this._createInteractiveRow(
                'applications-system-symbolic',
                'Kernel',
                kFlags > 0 ? `{${kFlags} Hinweis}` : '{OK}',
                kFlags > 0 ? statusOrange : statusGreen,
                textColor,
                'kernel',
                isDark
            );
            card2Box.add_child(kernelRow);
        }

        card2Item.add_child(card2Box);
        menu.addMenuItem(card2Item);

        // ======================================================================
        // RAHMEN 3: Updates (APT, Snap, Flatpak, Firmware)
        // ======================================================================
        const card3Item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'maint-card-item',
        });
        const card3Box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'maint-card-box',
            style: cardStyle,
        });

        // Topic Header
        const upHeaderRow = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 6px;' });
        const upIcon = new St.Icon({
            icon_name: 'software-update-available-symbolic',
            icon_size: 18,
            style: `margin-right: 8px; color: ${textColor};`,
        });
        const upHeaderLabel = new St.Label({
            text: 'System-Updates',
            style: styleTitle,
        });
        const upHeaderStatus = new St.Label({
            text: totalUpdates > 0 ? `  {${totalUpdates} Ausstehend}` : '  {Alles aktuell}',
            style: `font-size: 11px; font-weight: bold; color: ${totalUpdates > 0 ? statusOrange : statusGreen}; margin-left: 6px;`,
        });
        upHeaderRow.add_child(upIcon);
        upHeaderRow.add_child(upHeaderLabel);
        upHeaderRow.add_child(upHeaderStatus);
        card3Box.add_child(upHeaderRow);

        // Zeile 1: APT Pakete
        const aptSec = apt.security || 0;
        const aptNorm = apt.total || 0;
        let aptText = '{Alles aktuell}';
        let aptCol = statusGreen;
        if (aptNorm > 0) {
            aptCol = aptSec > 0 ? statusRed : statusOrange;
            aptText = aptSec > 0 ? `{${aptSec} Sicherheit, ${aptNorm} Regulär}` : `{${aptNorm} Updates}`;
        }
        const aptRow = this._createInteractiveRow('package-x-generic-symbolic', 'APT Pakete', aptText, aptCol, textColor, 'apt', isDark);
        card3Box.add_child(aptRow);

        // Zeile 2: Snap Pakete
        const snapCount = snap.count || 0;
        const snapRow = this._createInteractiveRow(
            'system-software-install-symbolic',
            'Snap Pakete',
            snapCount > 0 ? `{${snapCount} Ausstehend}` : '{Alles aktuell}',
            snapCount > 0 ? statusOrange : statusGreen,
            textColor,
            'snap',
            isDark
        );
        card3Box.add_child(snapRow);

        // Blockierte Snaps (z.B. cups, spotify) falls aktiv
        if (data.blocked_snaps && data.blocked_snaps.length > 0) {
            for (const pkg of data.blocked_snaps) {
                const blockRow = new St.BoxLayout({
                    vertical: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-left: 20px; margin-top: 2px; margin-bottom: 3px;',
                });
                const warnIco = new St.Icon({
                    icon_name: 'dialog-warning-symbolic',
                    icon_size: 12,
                    style: `margin-right: 5px; color: ${statusOrange};`,
                });
                const blockLbl = new St.Label({
                    text: `Läuft aktiv: ${pkg} `,
                    style: `color: ${dimmedColor}; font-size: 11px;`,
                    x_expand: true,
                });
                const killBtn = new St.Button({
                    label: 'Beenden',
                    style_class: 'maint-action-btn',
                });
                killBtn.connect('clicked', () => {
                    this._killSnap(pkg);
                });
                blockRow.add_child(warnIco);
                blockRow.add_child(blockLbl);
                blockRow.add_child(killBtn);
                card3Box.add_child(blockRow);
            }
        }

        // Zeile 3: Flatpak Apps
        const flatpakCount = flatpak.count || 0;
        const flatpakRow = this._createInteractiveRow(
            'application-x-executable-symbolic',
            'Flatpak Apps',
            flatpakCount > 0 ? `{${flatpakCount} Ausstehend}` : '{Alles aktuell}',
            flatpakCount > 0 ? statusOrange : statusGreen,
            textColor,
            'flatpak',
            isDark
        );
        card3Box.add_child(flatpakRow);

        // Zeile 3b: AppImages (nur sichtbar, wenn AM installiert ist)
        if (appimages.available) {
            const aiCount = appimages.count || 0;
            const aiRow = this._createInteractiveRow(
                'package-x-generic-symbolic',
                'AppImages (AM)',
                aiCount > 0 ? `{${aiCount} Ausstehend}` : '{Alles aktuell}',
                aiCount > 0 ? statusOrange : statusGreen,
                textColor,
                'appimages',
                isDark
            );
            card3Box.add_child(aiRow);
        }

        // Zeile 3c: GNOME Shell Extensions (nur sichtbar, wenn gext vorhanden ist)
        if (gext.available) {
            const gxCount = gext.count || 0;
            const gxBroken = !!gext.broken;
            const gxRow = this._createInteractiveRow(
                'application-x-addon-symbolic',
                'GNOME Extensions (gext)',
                gxBroken ? '{Defekt}' : (gxCount > 0 ? `{${gxCount} Ausstehend}` : '{Alles aktuell}'),
                (gxBroken || gxCount > 0) ? statusOrange : statusGreen,
                textColor,
                'gext',
                isDark
            );
            card3Box.add_child(gxRow);
        }

        // Zeile 4: Firmware Updates (fwupd)
        const fwCount = fw.count || 0;
        const fwRow = this._createInteractiveRow(
            'computer-symbolic',
            'Firmware (fwupd)',
            fwCount > 0 ? `{${fwCount} Ausstehend}` : '{Alles aktuell}',
            fwCount > 0 ? statusOrange : statusGreen,
            textColor,
            'firmware',
            isDark
        );
        card3Box.add_child(fwRow);

        card3Item.add_child(card3Box);
        menu.addMenuItem(card3Item);

        // ======================================================================
        // Aktionen als native GNOME PopupMenu-Items (exakt nach snmpbar-Vorbild)
        // ======================================================================
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Kontextabhängige Aktionen als native Menüeinträge. Buttons im Sidecar sind nicht klickbar,
        // weil das Sidecar außerhalb des modalen Menü-Grabs liegt und beim Verlassen der Zeile verschwindet.
        if (appimages.available && (appimages.count || 0) > 0) {
            const aiItem = new PopupMenu.PopupImageMenuItem(
                `AppImages aktualisieren (${appimages.count})`,
                'package-x-generic-symbolic'
            );
            aiItem.connect('activate', () => this._launchTerminal('am -u'));
            menu.addMenuItem(aiItem);
        }

        if (gext.available && gext.broken) {
            const gxFixItem = new PopupMenu.PopupImageMenuItem(
                'gext reparieren (pipx reinstall)',
                'application-x-addon-symbolic'
            );
            gxFixItem.connect('activate', () => this._launchTerminal('pipx reinstall gnome-extensions-cli'));
            menu.addMenuItem(gxFixItem);
        } else if (gext.available && (gext.count || 0) > 0) {
            const gxItem = new PopupMenu.PopupImageMenuItem(
                `GNOME Extensions aktualisieren (${gext.count})`,
                'application-x-addon-symbolic'
            );
            gxItem.connect('activate', () => this._launchTerminal('gext update'));
            menu.addMenuItem(gxItem);
        }

        const diagMenu = new PopupMenu.PopupSubMenuMenuItem('Diagnose für KI kopieren', true);
        diagMenu.icon.icon_name = 'edit-copy-symbolic';
        diagMenu.menu.addAction('RKHunter-Diagnose', () => this._copyRkhunterToClipboard());
        if (logs.available) {
            diagMenu.menu.addAction('System-Log-Diagnose', () => this._copyBackendToClipboard('--copy-logs', 'Log-Diagnose in Zwischenablage kopiert'));
        }
        menu.addMenuItem(diagMenu);

        if (logs.available) {
            const ignItem = new PopupMenu.PopupImageMenuItem(
                'Bekannte Log-Meldungen (Ignoreliste)',
                'view-list-symbolic'
            );
            ignItem.connect('activate', () => this._launchTerminal(`python3 '${this._backendScript}' --ignore-list`));
            menu.addMenuItem(ignItem);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const maintItem = new PopupMenu.PopupImageMenuItem(
            'Vollständige Systemwartung starten',
            'system-run-symbolic'
        );
        maintItem.connect('activate', () => this._runMaintenanceScript());
        menu.addMenuItem(maintItem);

        const logsItem = new PopupMenu.PopupImageMenuItem(
            'Wartungsprotokolle anzeigen',
            'folder-symbolic'
        );
        logsItem.connect('activate', () => this._openLogsFolder());
        menu.addMenuItem(logsItem);

        const refreshItem = new PopupMenu.PopupImageMenuItem(
            'Jetzt aktualisieren',
            'view-refresh-symbolic'
        );
        refreshItem.connect('activate', () => {
            this._triggerCheck();
            if (this._settings && this._settings.get_boolean('update-check-enabled'))
                this._checkExtensionUpdate();
        });
        menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupImageMenuItem(
            'Einstellungen...',
            'preferences-system-symbolic'
        );
        prefsItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(prefsItem);
    }

    _createInteractiveRow(iconName, labelText, statusText, statusColor, textColor, flyoverType = null, isDark = true, suffixText = '') {
        const row = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            can_focus: true,
            track_hover: true,
            style_class: 'maint-interactive-row',
        });

        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 14,
            style: `margin-right: 6px; color: ${textColor};`,
        });
        const nameLabel = new St.Label({
            text: `${labelText} `,
            style: `font-weight: 600; color: ${textColor}; font-size: 12px;`,
        });
        const statusLabel = new St.Label({
            text: statusText,
            style: `font-weight: bold; color: ${statusColor}; font-size: 11px; font-feature-settings: "tnum";`,
        });

        row.add_child(icon);
        row.add_child(nameLabel);
        row.add_child(statusLabel);

        if (suffixText) {
            const suffixLabel = new St.Label({
                text: ` ${suffixText}`,
                style: `color: ${textColor}; font-size: 11px; opacity: 0.7; margin-left: 4px;`,
            });
            row.add_child(suffixLabel);
        }

        // Flyover-Sidecar Anbindung
        if (flyoverType) {
            row.connect('enter-event', () => {
                this._showHoverSidecar(flyoverType, row, isDark);
                return Clutter.EVENT_PROPAGATE;
            });
            row.connect('leave-event', () => {
                this._hideHoverSidecar();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        return row;
    }

    _findMaintenanceScript() {
        const candidates = [
            GLib.build_filenamev([this.path, '..', 'ubuntumaintenance.sh']),
            GLib.build_filenamev([GLib.get_user_data_dir(), 'ubuntu-maintenance-indicator', 'ubuntumaintenance.sh']),
        ];
        for (const p of candidates) {
            if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE | GLib.FileTest.EXISTS)) {
                return p;
            }
        }
        return null;
    }

    _runMaintenanceScript() {
        const scriptPath = this._findMaintenanceScript();
        if (!scriptPath) {
            Main.notify('Fehler', 'Wartungsskript ubuntumaintenance.sh wurde nicht gefunden.');
            return;
        }

        const terminalCmd = this._settings ? this._settings.get_string('terminal-command') : 'gnome-terminal --';
        const fullCmd = `${terminalCmd} bash -c "${scriptPath}; exec bash"`;
        try {
            GLib.spawn_command_line_async(fullCmd);
        } catch (e) {
            console.error(`[ubuntu-maintenance] Terminal spawn failed: ${e.message}`);
            Main.notify('Fehler', `Terminal konnte nicht geöffnet werden: ${e.message}`);
        }
    }

    _openLogsFolder() {
        const logsDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'ubuntu-maintenance-indicator', 'logs']);
        try {
            GLib.mkdir_with_parents(logsDir, 0o755);
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(logsDir, null), null);
        } catch (e) {
            console.error(`[ubuntu-maintenance] Open logs failed: ${e.message}`);
        }
    }

    _killSnap(pkg) {
        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/python3', this._backendScript, '--kill-snap', pkg],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, () => {
                Main.notify('Snap beendet', `Prozess ${pkg} wurde beendet. Starte snap refresh ...`);
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                    this._triggerCheck();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.error(`[ubuntu-maintenance] Kill snap error: ${e.message}`);
        }
    }

    _copyRkhunterToClipboard() {
        this._copyBackendToClipboard('--copy-rkhunter', 'RKHunter-Diagnose in Zwischenablage kopiert');
    }

    _copyBackendToClipboard(flag, message) {
        try {
            const proc = Gio.Subprocess.new(
                ['/usr/bin/python3', this._backendScript, flag],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (source, res) => {
                try {
                    const [, stdout] = source.communicate_utf8_finish(res);
                    if (stdout) {
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, stdout);
                        Main.osdWindowManager.show(-1, Gio.Icon.new_for_string('edit-copy-symbolic'), message);
                    }
                } catch (e) {
                    console.error(`[ubuntu-maintenance] Copy error: ${e.message}`);
                }
            });
        } catch (e) {
            console.error(`[ubuntu-maintenance] Copy launch error: ${e.message}`);
        }
    }

    _launchTerminal(command) {
        const terminalCmd = this._settings ? this._settings.get_string('terminal-command') : 'gnome-terminal --';
        const fullCmd = `${terminalCmd} bash -c "${command}; exec bash"`;
        try {
            GLib.spawn_command_line_async(fullCmd);
        } catch (e) {
            console.error(`[ubuntu-maintenance] Launch command failed: ${e.message}`);
        }
    }
}
