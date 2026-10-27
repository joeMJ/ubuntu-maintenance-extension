/**
 * updater.js - Asynchrone Aktualitätsprüfung der Extension
 *
 * Bevorzugt die Release-Weiterleitung von GitHub (github.com/<Nutzer>/<Repo>/releases/latest -> .../tag/vN): dieselbe
 * Quelle wie selfupdate.py und install-remote.sh, ohne API-Limit und ohne den 5-Minuten-Cache von
 * raw.githubusercontent.com. Nur wenn sich aus der Raw-URL kein GitHub-Repo ableiten lässt, wird wie bisher die
 * metadata.json von der angegebenen URL gelesen.
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

/** https://raw.githubusercontent.com/<Nutzer>/<Repo>/... -> https://github.com/<Nutzer>/<Repo>/releases/latest (sonst null) */
export function releasesUrlFromRaw(rawUrl) {
    const m = /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\//.exec((rawUrl || '').trim());
    return m ? `https://github.com/${m[1]}/${m[2]}/releases/latest` : null;
}

/** '.../releases/tag/v12' -> 12 (erste Zahl des Tags), sonst null */
export function versionFromReleaseUri(uriText, releasesUrl) {
    const base = releasesUrl.replace(/\/latest$/, '/tag/');
    if (!uriText || !uriText.startsWith(base)) return null;
    const m = /^v(\d+)(?:\.\d+){0,2}$/.exec(uriText.slice(base.length).split(/[?#]/)[0]);
    return m ? Number(m[1]) : null;
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
        const releasesUrl = releasesUrlFromRaw(rawMetadataUrl);
        if (releasesUrl)
            return this._checkViaReleases(releasesUrl, cancellable);
        return this._checkViaRaw(rawMetadataUrl, cancellable);
    }

    /** Release-Weiterleitung: HEAD auf .../releases/latest, das Ziel der Weiterleitung nennt den Tag. */
    async _checkViaReleases(releasesUrl, cancellable = null) {
        const result = { updateAvailable: false, currentVersion: this._currentVersion, remoteVersion: null, error: null };
        try {
            const message = new Soup.Message({
                method: 'HEAD',
                uri: GLib.Uri.parse(releasesUrl, GLib.UriFlags.ENCODED),
            });
            await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);

            const status = message.get_status();
            if (status !== Soup.Status.OK) {
                result.error = `HTTP ${status} beim Abruf von ${releasesUrl}`;
                return result;
            }
            const remote = versionFromReleaseUri(message.get_uri().to_string(), releasesUrl);
            if (remote === null) {
                result.error = 'Noch kein Release vorhanden';
                return result;
            }
            result.remoteVersion = remote;
            result.updateAvailable = remote > this._currentVersion;
            return result;
        } catch (e) {
            if (!cancellable || !cancellable.is_cancelled()) {
                console.warn(`[ubuntu-maintenance] Update check failed: ${e.message}`);
            }
            result.error = e.message;
            return result;
        }
    }

    async _checkViaRaw(rawMetadataUrl, cancellable = null) {
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
