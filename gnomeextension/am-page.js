/**
 * am-page.js - Einstellungsseite 'AppImages (AM)': Status, Zielordner mit Rechteprüfung, Umzugsliste.
 * Stufe 2: nur Ansicht (liest über am_tool.py, ändert nichts am System).
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const esc = s => GLib.markup_escape_text(String(s ?? ''), -1);
const mb = b => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`;
const ICON = { ok: 'emblem-ok-symbolic', warn: 'dialog-warning-symbolic', fail: 'dialog-error-symbolic' };
const MARK = { ok: 'OK', warn: 'Hinweis', fail: 'Problem' };
const CSS = { ok: 'success', warn: 'warning', fail: 'error' };


const RUNNER = GLib.getenv('UM_AM_RUNNER') || 'pkexec';      // nur Test: Programm statt pkexec
const AUTOCONFIRM = GLib.getenv('UM_AM_AUTOCONFIRM') === '1'; // nur Test: Rückfragen automatisch bestätigen

// Rückfrage; extra = optionales Widget (z. B. aufklappbares Skript). Löst true/false auf.
function confirm(window, heading, body, okLabel, extra = null, destructive = false) {
    if (AUTOCONFIRM) return Promise.resolve(true);
    return new Promise(resolve => {
        const Dlg = Adw.AlertDialog ?? Adw.MessageDialog;
        const dlg = Adw.AlertDialog
            ? new Dlg({ heading, body: esc(body), body_use_markup: true })
            : new Dlg({ transient_for: window, heading, body: esc(body), body_use_markup: true });
        dlg.add_response('cancel', 'Abbrechen');
        dlg.add_response('ok', okLabel);
        dlg.set_response_appearance('ok', destructive ? Adw.ResponseAppearance.DESTRUCTIVE : Adw.ResponseAppearance.SUGGESTED);
        dlg.set_default_response('cancel');
        dlg.set_close_response('cancel');
        if (extra) dlg.set_extra_child(extra);
        dlg.connect('response', (_d, id) => resolve(id === 'ok'));
        if (Adw.AlertDialog) dlg.present(window); else dlg.present();
    });
}

function scriptExpander(label, text) {
    const tv = new Gtk.TextView({ editable: false, monospace: true, cursor_visible: false, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    tv.buffer.text = text;
    return new Gtk.Expander({ label, expanded: false,
        child: new Gtk.ScrolledWindow({ child: tv, min_content_height: 180, min_content_width: 460, css_classes: ['card'] }) });
}

// Startet einen Prozess und liefert jede Ausgabezeile an onLine; löst mit dem Rückgabecode auf.
function streamProc(argv, onLine) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) { onLine(`Start fehlgeschlagen: ${e.message}`); resolve(-1); return; }
        const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe(), close_base_stream: true });
        const loop = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (src, r) => {
            let line;
            try { [line] = src.read_line_finish_utf8(r); } catch (_e) { line = null; }
            if (line === null) {
                proc.wait_async(null, (p, res) => { try { p.wait_finish(res); resolve(p.get_exit_status()); } catch (_e) { resolve(-1); } });
                return;
            }
            onLine(line);
            loop();
        });
        loop();
    });
}

function runTool(path, args) {
    return new Promise((resolve, reject) => {
        try {
            const p = Gio.Subprocess.new(['python3', '-I', GLib.build_filenamev([path, 'am_tool.py']), ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            p.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, out, err] = proc.communicate_utf8_finish(res);
                    if (!proc.get_successful()) return reject(new Error((err || 'Fehler').trim()));
                    resolve(JSON.parse(out));
                } catch (e) { reject(e); }
            });
        } catch (e) { reject(e); }
    });
}

export function buildAmPage(window, extPath) {
    const page = new Adw.PreferencesPage({ title: 'AppImages (AM)', icon_name: 'application-x-executable-symbolic' });
    window.add(page);

    // --- Status ---
    const gStatus = new Adw.PreferencesGroup({
        title: 'AppImage-Verwaltung (AM)',
        description: 'Umzug der systemweiten AppImages (/opt) in den eigenen Benutzerordner: Aktualisieren geht dann ohne Administratorrechte.',
    });
    page.add(gStatus);
    const statusRow = new Adw.ActionRow({ title: 'Status', subtitle: 'Wird geprüft …' });
    gStatus.add(statusRow);

    // --- Zielordner ---
    const gDir = new Adw.PreferencesGroup({ title: 'Zielordner', description: 'Hier landen die AppImages nach dem Umzug.' });
    page.add(gDir);
    const dirRow = new Adw.ActionRow({ title: 'Ordner', subtitle: '…' });
    const chooseBtn = new Gtk.Button({ label: 'Ändern …', valign: Gtk.Align.CENTER });
    dirRow.add_suffix(chooseBtn);
    gDir.add(dirRow);
    let checkRows = [];

    // --- Programme ---
    const gApps = new Adw.PreferencesGroup({ title: 'Programme', description: 'Auswahl für den Umzug. Nichts wird verändert, solange du nicht ausdrücklich startest.' });
    page.add(gApps);
    let appRows = [];

    // --- Aktion (Stufe 3 folgt) ---
    const gAct = new Adw.PreferencesGroup();
    page.add(gAct);
    const summaryRow = new Adw.ActionRow({ title: 'Zusammenfassung', subtitle: '' });
    const startBtn = new Gtk.Button({ label: 'Installation starten', valign: Gtk.Align.CENTER, sensitive: false,
        css_classes: ['suggested-action'] });
    summaryRow.add_suffix(startBtn);
    gAct.add(summaryRow);

    const state = { dir: null, plan: null, selected: new Set() };

    // --- AppMan (nur wenn weder AM noch AppMan vorhanden) ---
    const gAppman = new Adw.PreferencesGroup({ title: 'AppMan einrichten', visible: false,
        description: 'AM/AppMan fehlt. AppMan ist dasselbe Programm für den Benutzerbetrieb ohne Administratorrechte.' });
    page.add(gAppman);
    const appmanRow = new Adw.ActionRow({ title: 'AppMan', subtitle: 'Wird nach ~/.local/bin/appman gelegt (ohne root).' });
    const appmanBtn = new Gtk.Button({ label: 'AppMan einrichten', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'] });
    appmanRow.add_suffix(appmanBtn);
    gAppman.add(appmanRow);

    // --- Lauf (Fortschritt/Protokoll) ---
    const gRun = new Adw.PreferencesGroup({ title: 'Ablauf', visible: false });
    page.add(gRun);
    const runBar = new Gtk.ProgressBar({ margin_top: 6, margin_bottom: 6, margin_start: 14, margin_end: 14, show_text: true });
    gRun.add(new Adw.PreferencesRow({ child: runBar, activatable: false, focusable: false }));
    const logView = new Gtk.TextView({ editable: false, monospace: true, cursor_visible: false, wrap_mode: Gtk.WrapMode.WORD_CHAR });
    gRun.add(new Adw.PreferencesRow({ activatable: false, focusable: false,
        child: new Gtk.ScrolledWindow({ child: logView, min_content_height: 200, hexpand: true, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 }) }));
    const log = line => {
        const b = logView.buffer;
        b.insert(b.get_end_iter(), line + '\n', -1);
        logView.scroll_to_mark(b.create_mark(null, b.get_end_iter(), false), 0, false, 0, 0);
    };
    let busy = false;
    const setBusy = v => { busy = v; startBtn.sensitive = !v && state.plan?.dir_check.ok && state.selected.size > 0; chooseBtn.sensitive = !v; };

    const gRemove = new Adw.PreferencesGroup({ visible: false });
    page.add(gRemove);
    const removeRow = new Adw.ActionRow({ title: 'Systemversionen entfernen', subtitle: '' });
    const removeBtn = new Gtk.Button({ label: 'Entfernen …', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'] });
    removeRow.add_suffix(removeBtn);
    gRemove.add(removeRow);
    let verified = [];

    const doInstall = async () => {
        const names = [...state.selected];
        const plan = state.plan;
        const body = [
            `${names.length} Programme werden im Benutzerordner installiert:`,
            `• Zielordner: ${plan.target}`,
            '• Ohne Administratorrechte, die Systemversionen in /opt bleiben unverändert.',
            '• Danach wird jede App geprüft (Datei, Updater, Link, Start).',
            '• ~/.config/appman/appman-config wird auf den Zielordner gesetzt (vorhandene Datei wird gesichert).',
            `• Download je App, zusammen ca. ${mb(plan.apps.filter(a => state.selected.has(a.name)).reduce((s, a) => s + a.size, 0))}.`,
        ].join('\n');
        if (!await confirm(window, 'Installation im Benutzerordner starten?', body, 'Installieren')) return;
        setBusy(true);
        gRun.visible = true; gRemove.visible = false; verified = [];
        logView.buffer.text = '';
        runBar.fraction = 0; runBar.text = 'Starte …';
        const failed = [];
        const rc = await streamProc(['python3', '-I', GLib.build_filenamev([extPath, 'am_tool.py']), '--am-install', plan.target, ...names], line => {
            let m; try { m = JSON.parse(line); } catch (_e) { log(line); return; }
            if (m.kind === 'step') { runBar.fraction = (m.index - 1) / m.total; runBar.text = `${m.index} von ${m.total}: ${m.app}`; log(m.text); }
            else if (m.kind === 'log') log('   ' + m.text);
            else if (m.kind === 'app') { log(m.ok ? `   ✔ ${m.app} installiert und geprüft` : `   ✘ ${m.app}: ${m.msgs.join('; ')}`); if (m.ok && m.msgs.length) log('   Hinweis: ' + m.msgs.join('; ')); if (!m.ok) failed.push(m.app); }
            else if (m.kind === 'fatal') log(`FEHLER: ${m.text}`);
            else if (m.kind === 'result') verified = m.verified;
        });
        runBar.fraction = 1;
        runBar.text = rc === 0 ? `Fertig: ${verified.length} von ${names.length} geprüft` : 'Abgebrochen';
        log(rc === 0 ? `\nErgebnis: ${verified.length} Programme installiert und geprüft, ${failed.length} mit Problemen.` : '\nDer Lauf wurde nicht ausgeführt (siehe oben).');
        setBusy(false);
        if (verified.length) {
            removeRow.subtitle = esc(`${verified.length} Programme sind im Benutzerordner geprüft. Die Systemversionen in /opt können jetzt entfernt werden (eine Anmeldung, Skript einsehbar).`);
            gRemove.visible = true;
        }
    };
    startBtn.connect('clicked', () => { if (!busy) doInstall(); });

    const doRemove = async () => {
        if (!verified.length) return;
        let res;
        try { res = await runTool(extPath, ['--am-remove-script', ...verified]); } catch (e) { log(`Fehler: ${e.message}`); return; }
        if (!res.ok || res.problems.length) {
            log('Entfernen nicht möglich: ' + res.problems.join('; '));
            if (!res.apps.length) return;
        }
        const body = [
            `Die Systemversionen von ${res.apps.length} Programmen werden mit Administratorrechten entfernt:`,
            esc(res.apps.join(', ')),
            '• Es werden nur die von AM angelegten Dateien gelöscht (/opt/<App>, Link in /usr/local/bin, Starter).',
            '• Die Benutzerversionen bleiben, ihre Einstellungen und Daten werden nicht angefasst.',
            '• Das Rückgängigmachen geht nur durch erneutes Installieren.',
            res.problems.length ? `• Nicht enthalten: ${res.problems.join('; ')}` : '',
            'Einmalige Anmeldung, Ablauf in diesem Fenster.',
        ].filter(Boolean).join('\n');
        if (!await confirm(window, 'Systemversionen jetzt entfernen?', body, 'Entfernen',
            scriptExpander('Details anzeigen (das Skript, das mit root-Rechten läuft)', res.script), true)) return;
        setBusy(true);
        log('\nEntferne Systemversionen (Anmeldung erforderlich) …');
        const rc = await streamProc([RUNNER, '/bin/sh', '-c', res.script], line => log('   ' + line));
        log(rc === 0 ? 'Fertig.' : (rc === 126 || rc === 127 ? 'Nicht ausgeführt (Anmeldung abgelehnt oder abgebrochen).' : `Mit Fehlern beendet (Rückgabecode ${rc}).`));
        setBusy(false);
        gRemove.visible = false;
        load(state.dir);
    };
    removeBtn.connect('clicked', () => { if (!busy) doRemove(); });

    const doAppman = async () => {
        let r;
        try { r = await runTool(extPath, ['--appman-install']); } catch (e) { appmanRow.subtitle = esc(`Fehler: ${e.message}`); return; }
        if (r.need_download) {
            const ok = await confirm(window, 'AppMan herunterladen?',
                `Es gibt keine lokale Kopie. Geladen wird das AM-Skript von\n${r.url}\n\nHinweis: Das ist der Entwicklungszweig (main) ohne Prüfsumme und ohne feste Version. ` +
                'Das Skript wird ohne Administratorrechte nach ~/.local/bin/appman gelegt und nur auf Ihre Aktion ausgeführt.', 'Herunterladen');
            if (!ok) return;
            try { r = await runTool(extPath, ['--appman-install', '--download']); } catch (e) { appmanRow.subtitle = esc(`Fehler: ${e.message}`); return; }
        }
        appmanRow.subtitle = esc(r.text + (r.sha256 ? ` SHA256: ${r.sha256.slice(0, 16)}…` : ''));
        if (r.ok) load(state.dir);
    };
    appmanBtn.connect('clicked', doAppman);


    const updateSummary = () => {
        const plan = state.plan;
        if (!plan) return;
        const sel = plan.apps.filter(a => state.selected.has(a.name));
        const size = sel.reduce((s, a) => s + a.size, 0);
        summaryRow.subtitle = esc(`${sel.length} Programme gewählt (${mb(size)}). ` +
            (plan.dir_check.ok ? 'Ordner ist geeignet.' : 'Ordner ist NICHT geeignet.') +
            ' Es wird erst installiert; die Systemversionen entfernst du danach in einem eigenen Schritt.');
        startBtn.sensitive = !busy && plan.dir_check.ok && sel.length > 0 && plan.status.can_run_user_mode;
    };

    const render = plan => {
        state.plan = plan;
        const st = plan.status;
        const parts = [];
        parts.push(st.am ? `AM gefunden (${st.am})` : 'AM nicht gefunden');
        parts.push(st.appman ? `AppMan gefunden (${st.appman})` : 'AppMan nicht gefunden');
        parts.push(`${st.system_apps.length} Programme systemweit (/opt)`);
        parts.push(`${st.user_apps.length} im Benutzerordner`);
        statusRow.subtitle = esc(parts.join(' · '));
        gAppman.visible = !st.can_run_user_mode;
        dirRow.subtitle = esc(plan.target);

        checkRows.forEach(r => gDir.remove(r));
        checkRows = plan.dir_check.checks.map(c => {
            const r = new Adw.ActionRow({ title: esc(`${MARK[c.level]}: ${c.text}`), activatable: false });
            const img = new Gtk.Image({ icon_name: ICON[c.level] });
            img.add_css_class(CSS[c.level]);
            r.add_prefix(img);
            gDir.add(r);
            return r;
        });

        appRows.forEach(r => gApps.remove(r));
        state.selected = new Set();
        appRows = plan.apps.map(a => {
            const notes = [];
            if (a.version) notes.push(a.version);
            notes.push(mb(a.size));
            let blocked = '';
            if (a.excluded) blocked = a.reason;
            else if (a.already_in_user_dir) blocked = 'Im Zielordner schon vorhanden.';
            else if (!a.remove_matches) blocked = 'Das Entfernen-Skript in /opt weicht vom Erwarteten ab; die Systemversion würde nicht entfernt.';
            const r = new Adw.ActionRow({ title: esc(a.name), subtitle: esc(blocked ? `${notes.join(' · ')}\n${blocked}` : notes.join(' · ')) });
            const chk = new Gtk.CheckButton({ valign: Gtk.Align.CENTER, active: false, sensitive: !a.excluded && !a.already_in_user_dir });
            const only = GLib.getenv('UM_AM_ONLY');  // nur Test: Vorauswahl begrenzen
            if (!a.excluded && !a.already_in_user_dir && a.remove_matches && (!only || only.split(',').includes(a.name))) chk.active = true;
            if (chk.active) state.selected.add(a.name);
            chk.connect('toggled', () => {
                if (chk.active) state.selected.add(a.name); else state.selected.delete(a.name);
                updateSummary();
            });
            r.add_prefix(chk);
            gApps.add(r);
            return r;
        });
        updateSummary();
    };

    const load = async (dir) => {
        statusRow.subtitle = 'Wird geprüft …';
        try {
            const plan = await runTool(extPath, ['--am-migration-plan', ...(dir ? ['--dir', dir] : [])]);
            state.dir = plan.target;
            render(plan);
        } catch (e) {
            statusRow.subtitle = esc(`Fehler: ${e.message}`);
        }
    };

    chooseBtn.connect('clicked', () => {
        const dlg = new Gtk.FileDialog({ title: 'Zielordner für AppImages wählen' });
        if (state.dir) {
            try { dlg.set_initial_folder(Gio.File.new_for_path(state.dir)); } catch (_e) { /* Ordner evtl. noch nicht vorhanden */ }
        }
        dlg.select_folder(window, null, (d, res) => {
            try {
                const f = d.select_folder_finish(res);
                if (f) load(f.get_path());
            } catch (_e) { /* abgebrochen */ }
        });
    });

    load(null);
    return page;
}
