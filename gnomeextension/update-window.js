#!/usr/bin/env -S gjs -m
// Aktualisieren-Fenster der Extension (eigene GTK4/libadwaita-App, läuft getrennt von der GNOME Shell).
//
// Das Fenster fragt das Backend nach dem Update-Plan (`--update-plan`, rein lesend, ohne Rechte), zeigt alle Quellen
// mit Auswahlfeldern und den Kernel-Schutz.
//
// Schritt 2: Der Lauf. Die Auswahl geht an das Backend (`--update-script`), das sie gegen einen frischen Plan prüft
// (inkl. Kernel-Schutz auf dem exakten Installationsbefehl) und ein Skript zurückgibt. Nach einer Bestätigung
// (mit sichtbarem Skript) führt `pkexec /bin/bash -c <Skript>` es aus: EINE Anmeldung, kein installierter Root-Code.
// Der Fortschritt kommt aus der Ausgabe (##STEP, apt Status-Fd). Flatpak/Extensions/AppImages folgen in Schritt 3.
//
// Zum Testen:
//   UM_WINDOW_PLAN=<plan.json>   Plan aus einer Datei statt vom Backend laden
//   UM_WINDOW_SCRIPT=<res.json>  Antwort von --update-script aus einer Datei (statt Backend)
//   UM_WINDOW_RUNNER=<cmd>       Programm statt pkexec (nur Test, z. B. env)
//   UM_WINDOW_AUTORUN=1          Auswahl ohne Rückfrage starten (nur Test)
//   UM_WINDOW_SHOT=<bild.png>    nach dem Aufbau einen Screenshot schreiben und beenden (Selbsttest)
//   UM_WINDOW_HEIGHT=<px>        Fensterhöhe für den Screenshot

import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const SCRIPT_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const BACKEND = GLib.build_filenamev([SCRIPT_DIR, 'maintenance_backend.py']);
const SHOT = GLib.getenv('UM_WINDOW_SHOT');
const PLAN_FILE = GLib.getenv('UM_WINDOW_PLAN');
const SCRIPT_FILE = GLib.getenv('UM_WINDOW_SCRIPT');
const RUNNER = GLib.getenv('UM_WINDOW_RUNNER') || 'pkexec';
const AUTORUN = !!GLib.getenv('UM_WINDOW_AUTORUN');
const TEST_HEIGHT = parseInt(GLib.getenv('UM_WINDOW_HEIGHT') ?? '', 10);

const AUTH_HINT = {
    root: 'Administratorrechte nötig.',
    terminal: 'Läuft vorerst im Terminal (eigene Anmeldung).',
    none: 'Ohne Anmeldung.',
};

// Nur diese Gruppen führt das Fenster in Schritt 2 aus.
const RUNNABLE = new Set(['apt', 'phased', 'kernel', 'snap', 'firmware', 'cleanup', 'flatpak', 'appimages']);
// Ohne root, als normaler Benutzer ausgeführt (kein pkexec)
const USER_PREFIXES = ['flatpak:', 'appimage:'];
const FAKE_USER = GLib.getenv('UM_WINDOW_USERFAKE');  // nur Test: statt der echten Befehle 'echo'
const isUserId = id => USER_PREFIXES.some(p => id.startsWith(p));

// Titel, Untertitel und Beschreibungen werden von libadwaita als Pango-Markup gelesen: immer maskieren.
const esc = s => GLib.markup_escape_text(String(s ?? ''), -1);

async function loadPlan(forceAppimages) {
    if (PLAN_FILE) {
        const [, bytes] = GLib.file_get_contents(PLAN_FILE);
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    const argv = ['/usr/bin/python3', BACKEND, '--update-plan'];
    if (forceAppimages) argv.push('--force-appimages');
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful()) throw new Error((stderr || '').trim() || 'Die Prüfung ist fehlgeschlagen.');
    return JSON.parse(stdout);
}

async function loadScript(selected) {
    if (SCRIPT_FILE) {
        const [, bytes] = GLib.file_get_contents(SCRIPT_FILE);
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    const proc = Gio.Subprocess.new(['/usr/bin/python3', BACKEND, '--update-script'],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(JSON.stringify({ selected }), null);
    if (!proc.get_successful()) throw new Error((stderr || '').trim() || 'Die Prüfung der Auswahl ist fehlgeschlagen.');
    return JSON.parse(stdout);
}

function badge(text, kind) {
    const cls = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : kind === 'ok' ? 'success' : 'dim-label';
    return new Gtk.Label({ label: text, css_classes: ['caption-heading', cls], valign: Gtk.Align.CENTER });
}

function buildWindow(app) {
    const win = new Adw.ApplicationWindow({ application: app, default_width: 780, default_height: Number.isFinite(TEST_HEIGHT) ? TEST_HEIGHT : 860, title: 'Aktualisieren' });

    // --- Kopfzeile ---
    const title = new Adw.WindowTitle({ title: 'Aktualisieren', subtitle: 'Prüfe …' });
    const header = new Adw.HeaderBar({ title_widget: title });
    const refreshBtn = new Gtk.Button({ icon_name: 'view-refresh-symbolic', tooltip_text: 'Neu prüfen (Strg+R)' });
    const spinner = new Gtk.Spinner();
    header.pack_start(refreshBtn);
    header.pack_start(spinner);

    // --- Inhalt ---
    const page = new Adw.PreferencesPage();
    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    const status = new Adw.StatusPage({ title: 'Prüfe, was ansteht …', description: 'Das dauert einige Sekunden.' });
    status.set_child(new Gtk.Spinner({ spinning: true, width_request: 32, height_request: 32, halign: Gtk.Align.CENTER }));
    stack.add_named(status, 'status');
    stack.add_named(page, 'page');

    // --- Lauf-Ansicht ---
    const runTitle = new Gtk.Label({ label: '', xalign: 0, wrap: true, css_classes: ['title-3'] });
    const runSub = new Gtk.Label({ label: '', xalign: 0, wrap: true, css_classes: ['dim-label'] });
    const progress = new Gtk.ProgressBar({ show_text: false });
    const logView = new Gtk.TextView({ editable: false, cursor_visible: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
        left_margin: 8, right_margin: 8, top_margin: 6, bottom_margin: 6 });
    const logScroll = new Gtk.ScrolledWindow({ child: logView, vexpand: true, min_content_height: 220, css_classes: ['card'] });
    const runBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_start: 18, margin_end: 18, margin_top: 18, margin_bottom: 8 });
    runBox.append(runTitle);
    runBox.append(progress);
    runBox.append(runSub);
    runBox.append(logScroll);
    stack.add_named(runBox, 'run');

    // --- Fußzeile (Zusammenfassung, Start gesperrt bis Schritt 2) ---
    const summary = new Gtk.Label({ label: '', xalign: 0, hexpand: true, wrap: true, css_classes: ['dim-label'] });
    const startBtn = new Gtk.Button({ label: 'Aktualisieren', css_classes: ['suggested-action', 'pill'], sensitive: false,
        tooltip_text: 'Prüft die Auswahl und fragt nach einer Bestätigung. Danach folgt EINE Anmeldung.' });
    const doneBtn = new Gtk.Button({ label: 'Zurück zur Übersicht', css_classes: ['pill'], visible: false });
    const hint = new Gtk.Label({ label: 'Nach der Bestätigung folgt eine einmalige Anmeldung.', xalign: 0, css_classes: ['caption', 'dim-label'] });
    const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
    info.append(summary);
    info.append(hint);
    const bar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_start: 18, margin_end: 18, margin_top: 10, margin_bottom: 10 });
    bar.append(info);
    bar.append(startBtn);
    bar.append(doneBtn);

    const toolbar = new Adw.ToolbarView({ content: stack });
    toolbar.add_top_bar(header);
    toolbar.add_bottom_bar(bar);
    win.set_content(toolbar);

    // --- Zustand ---
    let shownGroups = [];
    const checks = new Map(); // id -> { check, group }
    let busy = false;
    let running = false;
    let autoStarted = false;

    function logLine(text) {
        const buf = logView.get_buffer();
        buf.insert(buf.get_end_iter(), text + '\n', -1);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { const a = logScroll.get_vadjustment(); a.set_value(a.get_upper() - a.get_page_size()); return GLib.SOURCE_REMOVE; });
    }

    function showRunView(titleText, sub) {
        runTitle.label = esc(titleText);
        runSub.label = esc(sub ?? '');
        stack.set_visible_child_name('run');
        startBtn.visible = false;
        refreshBtn.sensitive = false;
    }

    function backToOverview() {
        doneBtn.visible = false;
        hint.label = 'Nach der Bestätigung folgt eine einmalige Anmeldung.';
        startBtn.visible = true;
        refreshBtn.sensitive = true;
        logView.get_buffer().set_text('', -1);
        progress.fraction = 0;
        refresh(false).catch(e => console.error(e));
    }
    doneBtn.connect('clicked', backToOverview);

    function finishRun(ok, headline, detail) {
        running = false;
        progress.fraction = ok ? 1 : progress.fraction;
        runTitle.label = esc(headline);
        runSub.label = esc(detail ?? '');
        doneBtn.visible = true;
        hint.label = '';
        if (AUTORUN && SHOT) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => { screenshot(); return GLib.SOURCE_REMOVE; });
    }

    // --- Schritte ohne root: Flatpak und AppImages (AM) als normaler Benutzer ---
    function userSteps(ids) {
        const steps = [];
        // IDs: flatpak:<system|user>:<vollständige Referenz>; je Installation ein eigener Aufruf
        const REF_RE = /^(app|runtime)\/[A-Za-z0-9._-]+\/[A-Za-z0-9_]+\/[A-Za-z0-9._-]+$/;
        for (const [inst, label] of [['system', 'System'], ['user', 'Benutzer']]) {
            const refs = ids.filter(i => i.startsWith(`flatpak:${inst}:`)).map(i => i.slice(`flatpak:${inst}:`.length)).filter(r => REF_RE.test(r));
            if (refs.length) steps.push({ title: `Flatpak (${label}) aktualisieren: ${refs.length}`, argv: ['flatpak', 'update', `--${inst}`, '-y', '--noninteractive', ...refs] });
        }
        const am = GLib.find_program_in_path('am') ?? GLib.find_program_in_path('appman') ?? 'am';
        for (const id of ids.filter(i => i.startsWith('appimage:'))) {
            const name = id.slice(9);
            steps.push({ title: `AppImage ${name} aktualisieren`, argv: [am, '-y', '-u', name] });
        }
        return FAKE_USER ? steps.map(s => ({ ...s, argv: ['/bin/sh', '-c', 'echo FAKE "$@"', 'x', ...s.argv] })) : steps;
    }

    function runOne(argv) {
        return new Promise(resolve => {
            let proc;
            try {
                proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            } catch (e) { logLine('Start fehlgeschlagen: ' + e.message); resolve(-1); return; }
            const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe(), close_base_stream: true });
            const loop = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (src, r) => {
                let bytes = null;
                try { [bytes] = src.read_line_finish(r); } catch (e) { bytes = null; }
                if (bytes === null) {
                    proc.wait_async(null, (p, wr) => { try { p.wait_finish(wr); } catch (e) { /* ignorieren */ } resolve(p.get_if_exited() ? p.get_exit_status() : -1); });
                    return;
                }
                const line = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
                if (line.trim() && !/\d+%|^[\s-]+$|^\s*\d+K /.test(line)) logLine('   ' + line);
                loop();
            });
            loop();
        });
    }

    // Führt die Schritte nacheinander aus; Rückgabe: Liste der fehlgeschlagenen Schritte.
    async function runUserSteps(ids) {
        const steps = userSteps(ids);
        const failed = [];
        for (let i = 0; i < steps.length; i++) {
            runTitle.label = esc(`Schritt ${i + 1} von ${steps.length}: ${steps[i].title}`);
            logLine(`— ${steps[i].title} —`);
            progress.pulse();
            const pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => { progress.pulse(); return GLib.SOURCE_CONTINUE; });
            const rc = await runOne(steps[i].argv);
            GLib.source_remove(pulse);
            progress.fraction = (i + 1) / steps.length;
            if (rc !== 0) { failed.push(steps[i].title); logLine(`   ✘ Rückgabecode ${rc}`); } else logLine('   ✔ fertig');
        }
        return failed;
    }

    async function runUserOnly(ids, body) {
        const go = AUTORUN ? true : await confirmRun(body, null);
        if (!go) { backToOverview(); return; }
        running = true;
        showRunView('Aktualisierung läuft …', 'Ohne Administratorrechte, bitte das Fenster nicht schließen.');
        const failed = await runUserSteps(ids);
        finishRun(failed.length === 0, failed.length ? 'Nicht alles aktualisiert' : 'Fertig',
            failed.length ? `Fehlgeschlagen: ${failed.join(' · ')}. Das Protokoll zeigt die Meldung.` : 'Alles erfolgreich. „Zurück zur Übersicht“ zeigt den neuen Stand.');
    }

    function executeScript(res, userIds = []) {
        running = true;
        showRunView('Installation läuft …', 'Bitte das Fenster nicht schließen.');
        const sm = res.summary ?? {};
        const intro = [];
        if (sm.total) intro.push(`${sm.total} Pakete werden installiert${sm.total > (sm.install ?? 0) ? ` (${sm.install} gewählt, ${sm.total - sm.install} wegen Abhängigkeiten)` : ''}`);
        if (sm.purge) intro.push(`${sm.purge} werden entfernt`);
        if (sm.snap) intro.push(`${sm.snap} Snap(s)`);
        if (sm.firmware) intro.push(`${sm.firmware} Firmware-Update(s)`);
        logLine('Start: ' + intro.join(', ') + '. Technische Ausgabe von apt folgt.');
        let step = 0, steps = res.summary?.steps ?? 1, resultCode = null, failed = [];
        let proc;
        try {
            proc = Gio.Subprocess.new([RUNNER, '/bin/bash', '-c', res.script], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            finishRun(false, 'Start nicht möglich', e.message);
            return;
        }
        const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe(), close_base_stream: true });
        const setFrac = pct => { progress.fraction = Math.min(1, Math.max(0, (Math.max(step, 1) - 1 + pct / 100) / steps)); };
        const handle = line => {
            let m;
            if ((m = line.match(/^##STEP (\d+)\/(\d+) (.*)$/))) {
                step = parseInt(m[1], 10); steps = parseInt(m[2], 10);
                runTitle.label = esc(`Schritt ${step} von ${steps}: ${m[3]}`);
                setFrac(0);
                logLine(`— Schritt ${step} von ${steps}: ${m[3]} —`);
            } else if ((m = line.match(/^(?:pmstatus|dlstatus):([^:]*):([\d.]+):(.*)$/))) {
                setFrac(parseFloat(m[2]));
                runSub.label = esc(m[3]);
            } else if (/^\(Reading database \.\.\./.test(line)) {
                // dpkg-Fortschrittszeilen ohne Aussage, nicht ins Protokoll
            } else if (line.startsWith('pmconffile:')) {
                // Konfigurationsdatei-Meldung von dpkg, kein Fortschritt
            } else if ((m = line.match(/^##RESULT (\d+)$/))) {
                resultCode = parseInt(m[1], 10);
            } else {
                if (line.startsWith('##FAIL') || line.startsWith('##ABORT') || line.startsWith('pmerror:')) failed.push(line);
                logLine(line);
            }
        };
        const loop = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (src, r) => {
            let line = null, readError = null;
            try {
                const [bytes] = src.read_line_finish(r);
                line = bytes === null ? null : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            } catch (e) { readError = e.message; }
            if (readError !== null) {
                logLine(`[Lesefehler beim Mitlesen der Ausgabe: ${readError}]`);
                finishRun(false, 'Anzeige unterbrochen', 'Die Ausgabe konnte nicht weiter mitgelesen werden. Der Lauf selbst kann weiterlaufen oder beendet sein: bitte „Neu prüfen“ und bei Zweifel /var/log/apt/history.log ansehen.');
                return;
            }
            if (line === null) {
                proc.wait_async(null, (p, wr) => {
                    try { p.wait_finish(wr); } catch (e) { /* ignorieren */ }
                    const code = p.get_if_exited() ? p.get_exit_status() : -1;
                    logLine(`[Prozessende: Rückgabecode ${code}, Ergebniszeile ${resultCode === null ? 'nicht gesehen' : 'gesehen (' + resultCode + ')'}]`);
                    if (resultCode === 0 && userIds.length) {
                        logLine('— Weiter ohne Administratorrechte: Flatpak/AppImages —');
                        runUserSteps(userIds).then(f => finishRun(f.length === 0, f.length ? 'Nicht alles aktualisiert' : 'Fertig',
                            f.length ? `Fehlgeschlagen: ${f.join(' · ')}.` : 'Alles erfolgreich. „Zurück zur Übersicht“ zeigt den neuen Stand (ggf. ist ein Neustart nötig).'));
                    }
                    else if (resultCode === 0) finishRun(true, 'Fertig', 'Alles erfolgreich. „Zurück zur Übersicht“ zeigt den neuen Stand (ggf. ist ein Neustart nötig).');
                    else if (resultCode === null && (code === 126 || code === 127)) finishRun(false, 'Abgebrochen', 'Die Anmeldung wurde abgebrochen oder abgelehnt. Es wurde nichts geändert.');
                    else if (resultCode === null && code === 0) finishRun(true, 'Beendet, Ergebnis nicht gemeldet', 'Der Prozess endete ohne Fehler (Rückgabecode 0), hat aber keine Abschlusszeile geschickt. „Zurück zur Übersicht“ zeigt den tatsächlichen Stand.');
                    else if (resultCode === 2) finishRun(false, 'Nichts installiert (Schutz)', failed.length ? failed.join(' · ') : 'Der Kernel-Schutz hat vor der Installation abgebrochen. Es wurde nichts geändert.');
                    else finishRun(false, 'Nicht vollständig durchgelaufen', (failed.length ? failed.join(' · ') + ' ' : '') + `Rückgabecode ${resultCode ?? code}. Das Protokoll unten zeigt die Meldung von apt; geändert wurde nur, was dort als installiert steht.`);
                });
                return;
            }
            handle(line);
            loop();
        });
        loop();
    }

    async function startRun() {
        if (busy || running) return;
        const selected = [...checks.entries()].filter(([, v]) => v.check.sensitive && v.check.active).map(([id]) => id);
        if (selected.length === 0) return;
        const selectedNames = selected.map(id => checks.get(id)?.name).filter(Boolean);
        const rootIds = selected.filter(id => !isUserId(id));
        const userIds = selected.filter(isUserId);
        const userLines = [];
        const nFp = userIds.filter(i => i.startsWith('flatpak:')).length, nAi = userIds.filter(i => i.startsWith('appimage:')).length;
        if (nFp) userLines.push(`• ${nFp} Flatpak${nFp === 1 ? '' : 's'} aktualisieren (ohne Anmeldung)`);
        if (nAi) userLines.push(`• ${nAi} AppImage${nAi === 1 ? '' : 's'} per AM aktualisieren (ohne Anmeldung)`);
        if (rootIds.length === 0) {
            await runUserOnly(userIds, userLines.join('\n') + '\n   (' + selectedNames.slice(0, 8).join(', ') + (selectedNames.length > 8 ? ' …' : '') + ')');
            return;
        }
        busy = true;
        showRunView('Prüfe Auswahl …', 'Trockenlauf mit Kernel-Schutz, das dauert einige Sekunden.');
        progress.pulse();
        const pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { progress.pulse(); return GLib.SOURCE_CONTINUE; });
        let res;
        try {
            res = await loadScript(rootIds);
        } catch (e) {
            res = { ok: false, problems: [e.message] };
        } finally {
            GLib.source_remove(pulse);
            busy = false;
        }
        progress.fraction = 0;
        if (!res.ok) {
            logLine('Die Auswahl kann nicht ausgeführt werden:\n' + (res.problems ?? []).map(p => ' - ' + p).join('\n'));
            finishRun(false, 'Nicht ausgeführt', 'Der Kernel-Schutz oder die Prüfung hat die Auswahl abgelehnt. Es wurde nichts geändert.');
            return;
        }
        const sm = res.summary ?? {};
        // Bestätigung: nur was passiert, das Skript selbst liegt hinter 'Details anzeigen'.
        const n = (cnt, one, many) => `${cnt} ${cnt === 1 ? one : many}`;
        const lines = [];
        if (sm.install) lines.push(`• ${n(sm.install, 'Paket', 'Pakete')} installieren`);
        if (sm.purge) lines.push(`• ${n(sm.purge, 'Paket', 'Pakete')} entfernen`);
        if (sm.snap) lines.push(`• ${n(sm.snap, 'Snap', 'Snaps')} aktualisieren`);
        if (sm.firmware) lines.push(`• ${n(sm.firmware, 'Firmware-Update', 'Firmware-Updates')} einspielen`);
        if (selectedNames.length) lines.push(`   (${selectedNames.slice(0, 8).join(', ')}${selectedNames.length > 8 ? ' …' : ''})`);
        lines.push(...userLines);
        lines.push('• Einmalige Anmeldung für die Administrator-Schritte, Ablauf in diesem Fenster');
        lines.push('• Der Kernel-Schutz hat die Auswahl geprüft.');
        let body = lines.join('\n');
        if ((res.extra ?? []).length) body = `ACHTUNG: Gewählt ${sm.install}, installiert werden aber ${sm.total} Pakete.\napt braucht ${res.extra.length} weitere wegen Abhängigkeiten (z. B. gleiche Version zusammengehöriger Pakete):\n${res.extra.slice(0, 14).join(', ')}${res.extra.length > 14 ? ' …' : ''}\n\n` + body;
        const go = AUTORUN ? true : await confirmRun(body, res.script);
        if (!go) { backToOverview(); return; }
        executeScript(res, userIds);
    }

    function confirmRun(body, script) {
        return new Promise(resolve => {
            const dlg = new Adw.AlertDialog({ heading: 'Jetzt aktualisieren?', body: esc(body), body_use_markup: true });
            dlg.add_response('cancel', 'Abbrechen');
            dlg.add_response('go', 'Aktualisieren');
            dlg.set_response_appearance('go', Adw.ResponseAppearance.SUGGESTED);
            dlg.set_default_response('go');
            dlg.set_close_response('cancel');
            const tv = new Gtk.TextView({ editable: false, cursor_visible: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR });
            tv.get_buffer().set_text(script ?? '', -1);
            const details = new Gtk.Expander({ label: 'Details anzeigen (das Skript, das mit root-Rechten läuft)', expanded: false,
                child: new Gtk.ScrolledWindow({ child: tv, min_content_height: 180, min_content_width: 460, css_classes: ['card'] }) });
            if (script) dlg.set_extra_child(details);
            dlg.choose(win, null, (d, r) => { resolve(d.choose_finish(r) === 'go'); });
        });
    }
    startBtn.connect('clicked', () => startRun().catch(e => console.error(e)));
    win.connect('close-request', () => running);

    function updateSummary() {
        const perGroup = new Map();
        let total = 0, selected = 0;
        for (const { check, group } of checks.values()) {
            if (!check.sensitive) continue;
            total++;
            if (check.active) {
                selected++;
                perGroup.set(group.title, (perGroup.get(group.title) ?? 0) + 1);
            }
        }
        const parts = [...perGroup.entries()].map(([t, n]) => `${t.split(' (')[0]} ${n}`);
        startBtn.sensitive = selected > 0 && !running;
        summary.label = total === 0 ? 'Nichts auszuwählen.' : `${selected} von ${total} ausgewählt${parts.length ? ' · ' + parts.join(' · ') : ''}`;
    }

    function addItemRow(container, g, it, withMasterSync) {
        const row = new Adw.ActionRow({ title: esc(it.name), subtitle: esc(it.subtitle || ''), subtitle_lines: 2 });
        const check = new Gtk.CheckButton({ active: !!it.selected && it.selectable !== false, sensitive: it.selectable !== false, valign: Gtk.Align.CENTER });
        row.add_prefix(check);
        row.activatable_widget = check;
        if (it.badge) row.add_suffix(badge(it.badge, it.badge_kind));
        checks.set(it.id, { check, group: g, name: it.name });
        check.connect('toggled', () => { withMasterSync(); updateSummary(); });
        container(row);
        return check;
    }

    function addKernelUnit(grp, g, it, sync) {
        const expander = new Adw.ExpanderRow({ title: esc(it.name), subtitle: esc(it.subtitle || '') });
        const blocked = !!it.blocked;
        if (blocked) {
            expander.add_prefix(new Gtk.Image({ icon_name: 'dialog-error-symbolic', css_classes: ['error'], valign: Gtk.Align.CENTER }));
        } else {
            const check = new Gtk.CheckButton({ active: !!it.selected, valign: Gtk.Align.CENTER });
            expander.add_prefix(check);
            checks.set(it.id, { check, group: g, name: it.name });
            check.connect('toggled', () => { sync(); updateSummary(); });
        }
        if (it.badge) expander.add_suffix(badge(it.badge, it.badge_kind));
        for (const p of it.packages ?? []) {
            expander.add_row(new Adw.ActionRow({ title: esc(p), css_classes: ['monospace'] }));
        }
        grp.add(expander);
    }

    function renderGroup(g) {
        if (!RUNNABLE.has(g.id)) g = { ...g, items: g.items.map(i => ({ ...i, selected: false, selectable: false })) };
        const parts = [AUTH_HINT[g.auth] ?? ''];
        if (g.note) parts.push(g.note);
        if (g.warning) parts.push(g.warning);
        const grp = new Adw.PreferencesGroup({ title: esc(g.title), description: esc(parts.filter(Boolean).join(' ')) });
        const master = new Gtk.CheckButton({ label: 'Alle', valign: Gtk.Align.CENTER });
        let syncing = false;
        const mine = () => g.items.map(i => checks.get(i.id)).filter(Boolean).map(c => c.check).filter(c => c.sensitive);
        const sync = () => {
            if (syncing) return;
            syncing = true;
            const cs = mine();
            const n = cs.filter(c => c.active).length;
            master.inconsistent = n > 0 && n < cs.length;
            master.active = cs.length > 0 && n === cs.length;
            master.sensitive = cs.length > 0;
            syncing = false;
        };
        master.connect('toggled', () => {
            if (syncing) return;
            syncing = true;
            const want = master.active;
            master.inconsistent = false;
            for (const c of mine()) c.active = want;
            syncing = false;
            updateSummary();
        });
        grp.set_header_suffix(master);

        if (g.id === 'kernel') {
            for (const it of g.items) addKernelUnit(grp, g, it, sync);
        } else if (g.items.length > 8) {
            const expander = new Adw.ExpanderRow({ title: `${g.items.length} Einträge`, subtitle: 'Zum Ansehen und Abwählen aufklappen' });
            grp.add(expander);
            for (const it of g.items) addItemRow(r => expander.add_row(r), g, it, sync);
        } else {
            for (const it of g.items) addItemRow(r => grp.add(r), g, it, sync);
        }
        sync();
        return grp;
    }

    function renderPlan(plan) {
        for (const grp of shownGroups) page.remove(grp);
        shownGroups = [];
        checks.clear();

        // Kernel-Schutz und Neustart
        const guard = plan.guard ?? {};
        const gg = new Adw.PreferencesGroup({ title: 'Kernel-Schutz' });
        const pins = (guard.pin_files ?? []).map(p => GLib.path_get_basename(p)).join(', ');
        gg.add(new Adw.ActionRow({
            title: esc(`Laufender Kernel: ${guard.running ?? '?'}`),
            subtitle: esc(`Erlaubte Typen: ${(guard.allowed ?? []).join(', ')} · APT-Sperre: ${pins || 'keine'}`),
        }));
        for (const w of guard.warnings ?? []) {
            const r = new Adw.ActionRow({ title: esc(w), title_lines: 3 });
            r.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic', css_classes: ['warning'] }));
            gg.add(r);
        }
        if (plan.reboot?.required) {
            const r = new Adw.ActionRow({ title: 'Neustart erforderlich', subtitle: esc((plan.reboot.packages ?? []).join(', ')) });
            r.add_prefix(new Gtk.Image({ icon_name: 'system-reboot-symbolic', css_classes: ['warning'] }));
            gg.add(r);
        }
        page.add(gg);
        shownGroups.push(gg);

        const idle = [];
        for (const g of plan.groups ?? []) {
            if (!RUNNABLE.has(g.id)) g.auth = g.auth === 'terminal' ? 'terminal' : 'none';
            if (!g.items || g.items.length === 0) { idle.push(g.title.split(' (')[0]); continue; }
            const grp = renderGroup(g);
            page.add(grp);
            shownGroups.push(grp);
        }
        if (idle.length) {
            const ig = new Adw.PreferencesGroup();
            ig.add(new Adw.ActionRow({ title: 'Aktuell, nichts zu tun', subtitle: esc(idle.join(' · ')), sensitive: false }));
            page.add(ig);
            shownGroups.push(ig);
        }
        const t = plan.generated ? plan.generated.split('T')[1] : '';
        title.subtitle = t ? `Geprüft um ${t}` : '';
        updateSummary();
        stack.set_visible_child_name('page');
    }

    async function refresh(force = false) {
        if (busy) return;
        busy = true;
        refreshBtn.sensitive = false;
        spinner.spinning = true;
        try {
            const plan = await loadPlan(force);
            renderPlan(plan);
        } catch (e) {
            console.error(`[update-window] ${e.message}\n${e.stack ?? ''}`);
            status.title = 'Die Prüfung ist fehlgeschlagen';
            status.description = esc(e.message);
            status.set_child(null);
            stack.set_visible_child_name('status');
            title.subtitle = '';
        } finally {
            busy = false;
            refreshBtn.sensitive = true;
            spinner.spinning = false;
            if (AUTORUN && !autoStarted) { autoStarted = true; GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { startRun().catch(e => console.error(e)); return GLib.SOURCE_REMOVE; }); }
            else if (SHOT && !AUTORUN) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => { screenshot(); return GLib.SOURCE_REMOVE; });
        }
    }

    function screenshot() {
        const w = win.get_width(), h = win.get_height();
        const paintable = new Gtk.WidgetPaintable({ widget: win });
        const snapshot = new Gtk.Snapshot();
        paintable.snapshot(snapshot, w, h);
        const node = snapshot.to_node();
        const texture = win.get_native().get_renderer().render_texture(node, null);
        texture.save_to_png(SHOT);
        print(`Screenshot: ${SHOT} (${w}x${h}), Auswahlfelder: ${checks.size}`);
        app.quit();
    }

    refreshBtn.connect('clicked', () => refresh(true));
    const shortcut = new Gtk.ShortcutController();
    shortcut.add_shortcut(new Gtk.Shortcut({ trigger: Gtk.ShortcutTrigger.parse_string('<Control>r'), action: Gtk.CallbackAction.new(() => { refresh(true); return true; }) }));
    shortcut.add_shortcut(new Gtk.Shortcut({ trigger: Gtk.ShortcutTrigger.parse_string('<Control>w'), action: Gtk.CallbackAction.new(() => { win.close(); return true; }) }));
    win.add_controller(shortcut);

    win.present();
    refresh(false).catch(e => print(`FEHLER in refresh: ${e}\n${e.stack}`));
    return win;
}

const app = new Adw.Application({
    application_id: 'de.johnlose.UbuntuMaintenanceUpdater',
    flags: SHOT || PLAN_FILE ? Gio.ApplicationFlags.NON_UNIQUE : Gio.ApplicationFlags.DEFAULT_FLAGS,
});
app.connect('activate', () => {
    const existing = app.get_active_window();
    if (existing) existing.present();
    else buildWindow(app);
});
app.run([System.programInvocationName]);
