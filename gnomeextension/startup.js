/**
 * startup.js - Verzögerter Start der ersten Prüfung nach Anmeldung/Entsperren
 *
 * GNOME Shell schaltet Extensions ohne 'unlock-dialog' beim Sperren ab und beim Entsperren wieder an;
 * enable() läuft daher bei jeder Anmeldung und jedem Entsperren. Damit dort nicht sofort die schweren
 * Prüfbefehle starten, gibt es: Zwischenspeicher der letzten Prüfung (Menü sofort nutzbar), eine
 * Wartezeit und eine Ruhe-Prüfung über die Systemlast (Linux PSI).
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const CALM_RETRY_SECONDS = 60;   // Abstand der Wiederholungen, wenn der Rechner noch ausgelastet ist
export const CALM_MAX_RETRIES = 5;      // danach läuft die Prüfung trotzdem
export const CALM_CPU_MAX = 10.0;       // 'some avg10' in Prozent (CPU-Wartezeit der letzten 10 s)
export const CALM_IO_MAX = 10.0;        // 'some avg10' in Prozent (I/O-Wartezeit der letzten 10 s)
export const CACHE_MAX_AGE_SECONDS = 24 * 3600;  // ältere Zwischenspeicher werden nicht angezeigt

/** Wartezeit bis zur ersten Prüfung: nie kürzer als die Startverzögerung, und nicht vor Ablauf des Intervalls ab der letzten Prüfung. */
export function firstCheckDelay(cacheAgeSec, intervalSec, startupDelaySec) {
    const startup = Math.max(0, Number(startupDelaySec) || 0);
    if (cacheAgeSec === null || cacheAgeSec === undefined || !(cacheAgeSec >= 0))
        return startup;
    return Math.max(startup, Math.max(0, intervalSec - cacheAgeSec));
}

/** 'some avg10=1.23 …' -> 1.23, sonst null. */
export function parsePsiAvg10(text) {
    const m = /^some\s+avg10=([0-9.]+)/m.exec(text || '');
    return m ? parseFloat(m[1]) : null;
}

/** Ruhig = CPU- und I/O-Druck unter den Schwellen. Ist PSI nicht lesbar, wird nicht gewartet. */
export function isCalm(cpuText, ioText) {
    const c = parsePsiAvg10(cpuText);
    const i = parsePsiAvg10(ioText);
    if (c === null && i === null)
        return true;
    return (c === null || c < CALM_CPU_MAX) && (i === null || i < CALM_IO_MAX);
}

export function readTextFile(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder('utf-8').decode(bytes) : '';
    } catch (e) {
        return '';
    }
}

export function cachePath() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'ubuntu-maintenance-indicator', 'last_check.json']);
}

/** Letzte Prüfung aus dem Zwischenspeicher: { data, ageSec } oder null (fehlt, zu alt, kaputt, unvollständig). */
export function loadCache(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const ageSec = GLib.get_real_time() / 1e6 - info.get_attribute_uint64('time::modified');
        if (!(ageSec >= 0) || ageSec > CACHE_MAX_AGE_SECONDS)
            return null;
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        if (!data || typeof data !== 'object' || !data.timestamp || !data.updates || !data.security)
            return null;
        return { data, ageSec };
    } catch (e) {
        return null;
    }
}

/** Atomar schreiben (Datei ersetzen); Fehler werden nur geloggt, die Extension läuft weiter. */
export function saveCache(path, data) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        const bytes = new TextEncoder().encode(JSON.stringify(data));
        Gio.File.new_for_path(path).replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
        return true;
    } catch (e) {
        console.warn(`[ubuntu-maintenance] Zwischenspeicher nicht geschrieben: ${e.message}`);
        return false;
    }
}
