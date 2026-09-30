/**
 * updater.js - Asynchrone Aktualitätsprüfung über Git Remote (GitHub / Gitea)
 * Kompatibel mit GNOME 45, 46, 47, 48, 49, 50 (Soup 3.0)
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

try {
    Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
} catch (e) {
    // Bereits promisified
}

export class UpdateChecker {
    constructor(currentVersion = 1) {
        this._currentVersion = Number(currentVersion) || 1;
        this._session = new Soup.Session({
            timeout: 10,
        });
    }

    /**
     * Prüft, ob im konfigurierten Raw-Git-Repository eine neuere Version vorliegt.
     * 
     * @param {string} rawMetadataUrl - URL zur remote metadata.json
     * @param {Gio.Cancellable} [cancellable=null]
     * @returns {Promise<{updateAvailable: boolean, currentVersion: number, remoteVersion: number|null, error: string|null}>}
     */
    async checkForUpdates(rawMetadataUrl, cancellable = null) {
        if (!rawMetadataUrl || rawMetadataUrl.trim() === '') {
            return {
                updateAvailable: false,
                currentVersion: this._currentVersion,
                remoteVersion: null,
                error: 'Keine Update-URL konfiguriert',
            };
        }

        try {
            const uri = GLib.Uri.parse(rawMetadataUrl.trim(), GLib.UriFlags.ENCODED);
            const message = new Soup.Message({
                method: 'GET',
                uri: uri,
            });

            // Cache umgehen
            message.request_headers.append('Cache-Control', 'no-cache');

            const bytes = await this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );

            const status = message.get_status();
            if (status !== Soup.Status.OK) {
                return {
                    updateAvailable: false,
                    currentVersion: this._currentVersion,
                    remoteVersion: null,
                    error: `HTTP ${status} beim Abruf von ${rawMetadataUrl}`,
                };
            }

            const text = new TextDecoder('utf-8').decode(bytes.toArray());
            const remoteMeta = JSON.parse(text);
            const remoteVer = Number(remoteMeta.version || 0);

            const isNewer = remoteVer > this._currentVersion;

            return {
                updateAvailable: isNewer,
                currentVersion: this._currentVersion,
                remoteVersion: remoteVer,
                error: null,
            };
        } catch (e) {
            if (!cancellable || !cancellable.is_cancelled()) {
                console.warn(`[ubuntu-maintenance] Update check failed: ${e.message}`);
            }
            return {
                updateAvailable: false,
                currentVersion: this._currentVersion,
                remoteVersion: null,
                error: e.message,
            };
        }
    }
}
