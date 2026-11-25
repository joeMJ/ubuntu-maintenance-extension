/**
 * am-page.js - Einstellungsseite 'AppImages (AM)': Status, Zielordner mit Rechteprüfung, Suche und Installation im
 * Benutzerordner, externe GitHub-AppImages, Umzugsliste. Alle Änderungen laufen über am_tool.py (ohne Administratorrechte;
 * nur das Entfernen von Systemversionen braucht eine Anmeldung).
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

    // --- Benachrichtigungen von AM ---
    const gNotify = new Adw.PreferencesGroup({
        title: 'Benachrichtigungen von AM',
        description: 'AM zeigt bei jedem AppImage-Update bis zu zwei Meldungen. Bei vielen Programmen sind das sehr viele; hier lässt sich das abschalten.',
    });
    page.add(gNotify);
    const notifyRow = new Adw.SwitchRow({ title: 'Meldungen bei AppImage-Updates', subtitle: 'Wird geprüft …', sensitive: false });
    gNotify.add(notifyRow);
    let notifyBusy = false;
    const showNotify = (st, err = '') => {
        notifyBusy = true;
        notifyRow.active = !st.disabled;
        notifyBusy = false;
        notifyRow.sensitive = !!st.can_run;
        let sub;
        if (!st.can_run) sub = 'AM wurde nicht gefunden.';
        else if (st.disabled) sub = st.active === 0 ? `Aus: ${st.total} Updater melden nichts.` : `Aus, aber ${st.active} von ${st.total} Updatern melden noch.`;
        else sub = `An: ${st.active} von ${st.total} Updatern melden.`;
        if (err) sub += ` ${err}`;
        notifyRow.subtitle = esc(sub);
    };
    const loadNotify = async () => {
        try { showNotify(await runTool(extPath, ['--am-notify-status'])); }
        catch (e) { notifyRow.subtitle = esc(`Fehler: ${e.message}`); }
    };
    notifyRow.connect('notify::active', () => {
        if (notifyBusy) return;
        const want = notifyRow.active;
        notifyRow.sensitive = false;
        notifyRow.subtitle = 'Wird umgestellt …';
        runTool(extPath, ['--am-notify', want ? 'on' : 'off'])
            .then(res => showNotify(res.status ?? {}, res.ok ? '' : (res.error ?? '')))
            .catch(e => { notifyRow.subtitle = esc(`Fehler: ${e.message}`); loadNotify(); });
    });

    // --- Zielordner ---
    const gDir = new Adw.PreferencesGroup({ title: 'Zielordner', description: 'Hier landen die AppImages nach dem Umzug.' });
    page.add(gDir);
    const dirRow = new Adw.ActionRow({ title: 'Ordner', subtitle: '…' });
    const chooseBtn = new Gtk.Button({ label: 'Ändern …', valign: Gtk.Align.CENTER });
    dirRow.add_suffix(chooseBtn);
    gDir.add(dirRow);
    let checkRows = [];

    // --- Suchen und installieren (Benutzerordner, kein root) ---
    const gSearch = new Adw.PreferencesGroup({ title: 'AppImage suchen und installieren',
        description: 'Suche in der AM-Datenbank. Installiert wird im Benutzerordner, ohne Administratorrechte; Aktualisieren geht danach ebenfalls ohne Anmeldung.' });
    page.add(gSearch);
    const searchRow = new Adw.EntryRow({ title: 'Suchbegriff (Enter startet die Suche)' });
    const searchBtn = new Gtk.Button({ label: 'Suchen', valign: Gtk.Align.CENTER });
    searchRow.add_suffix(searchBtn);
    gSearch.add(searchRow);
    const searchInfo = new Adw.ActionRow({ title: 'Noch keine Suche', subtitle: '', activatable: false });
    gSearch.add(searchInfo);
    let searchRows = [];
    const installBtns = [];

    // --- Externe GitHub-AppImages (am -e) ---
    const gExtra = new Adw.PreferencesGroup({ title: 'Externes GitHub-AppImage',
        description: 'Für Programme, die nicht in der AM-Datenbank stehen (z. B. Thorium). Repository, Name und bei mehreren Varianten ein Schlüsselwort (z. B. AVX2).' });
    page.add(gExtra);
    const repoRow = new Adw.EntryRow({ title: 'Repository (nutzer/projekt oder GitHub-Adresse)' });
    const nameRow = new Adw.EntryRow({ title: 'Programmname (Kleinbuchstaben, z. B. thorium)' });
    const kwRow = new Adw.EntryRow({ title: 'Schlüsselwort der Variante (optional, z. B. AVX2)' });
    [repoRow, nameRow, kwRow].forEach(r => gExtra.add(r));
    const extraBtnRow = new Adw.ActionRow({ title: 'Installieren', subtitle: 'Im Benutzerordner, danach wird die App geprüft.', activatable: false });
    const extraBtn = new Gtk.Button({ label: 'Installieren …', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'] });
    extraBtnRow.add_suffix(extraBtn);
    gExtra.add(extraBtnRow);
    let hintRows = [];

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
    const setBusy = v => {
        busy = v;
        startBtn.sensitive = !v && state.plan?.dir_check.ok && state.selected.size > 0;
        chooseBtn.sensitive = !v;
        searchBtn.sensitive = !v;
        extraBtn.sensitive = !v;
        installBtns.forEach(b => { b.sensitive = !v; });
    };

    const gRemove = new Adw.PreferencesGroup({ visible: false });
    page.add(gRemove);
    const removeRow = new Adw.ActionRow({ title: 'Systemversionen entfernen', subtitle: '' });
    const removeBtn = new Gtk.Button({ label: 'Entfernen …', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'] });
    removeRow.add_suffix(removeBtn);
    gRemove.add(removeRow);
    let verified = [];

    // Führt am_tool.py mit JSON-Zeilenausgabe aus und füllt Fortschritt und Protokoll. Rückgabe {rc, failed}.
    const streamInstall = async (args, total) => {
        setBusy(true);
        gRun.visible = true; gRemove.visible = false; verified = [];
        logView.buffer.text = '';
        runBar.fraction = 0; runBar.text = 'Starte …';
        const failed = [];
        const rc = await streamProc(['python3', '-I', GLib.build_filenamev([extPath, 'am_tool.py']), ...args], line => {
            let m; try { m = JSON.parse(line); } catch (_e) { log(line); return; }
            if (m.kind === 'step') { runBar.fraction = (m.index - 1) / m.total; runBar.text = `${m.index} von ${m.total}: ${m.app}`; log(m.text); }
            else if (m.kind === 'log') log('   ' + m.text);
            else if (m.kind === 'app') { log(m.ok ? `   ✔ ${m.app} installiert und geprüft` : `   ✘ ${m.app}: ${m.msgs.join('; ')}`); if (m.ok && m.msgs.length) log('   Hinweis: ' + m.msgs.join('; ')); if (!m.ok) failed.push(m.app); }
            else if (m.kind === 'fatal') log(`FEHLER: ${m.text}`);
            else if (m.kind === 'result') verified = m.verified;
        });
        runBar.fraction = 1;
        runBar.text = rc === 0 ? `Fertig: ${verified.length} von ${total} geprüft` : 'Abgebrochen';
        log(rc === 0 ? `\nErgebnis: ${verified.length} Programme installiert und geprüft, ${failed.length} mit Problemen.` : '\nDer Lauf wurde nicht ausgeführt (siehe oben).');
        setBusy(false);
        // Systemversionen derselben Programme können jetzt entfernt werden (nur wenn es welche gibt)
        const sys = new Set(state.plan?.status.system_apps ?? []);
        const removable = verified.filter(n => sys.has(n));
        if (removable.length) {
            removeRow.subtitle = esc(`${removable.length} Programme sind im Benutzerordner geprüft und haben noch eine Systemversion in /opt. Sie kann jetzt entfernt werden (eine Anmeldung, Skript einsehbar).`);
            gRemove.visible = true;
        }
        load(state.dir);
        return { rc, failed };
    };

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
        await streamInstall(['--am-install', plan.target, ...names], names.length);
    };
    startBtn.connect('clicked', () => { if (!busy) doInstall(); });

    // --- Suche ---
    const doSearch = async () => {
        const term = searchRow.text.trim();
        if (!term) { searchInfo.title = 'Bitte einen Suchbegriff eingeben'; return; }
        searchBtn.sensitive = false;
        searchInfo.title = 'Suche läuft …'; searchInfo.subtitle = '';
        searchRows.forEach(r => gSearch.remove(r)); searchRows = [];
        installBtns.length = 0;
        let res;
        try { res = await runTool(extPath, ['--am-search', term]); } catch (e) { res = { ok: false, error: e.message, results: [] }; }
        searchBtn.sensitive = !busy;
        if (!res.ok) { searchInfo.title = 'Suche nicht möglich'; searchInfo.subtitle = esc(res.error); return; }
        searchInfo.title = res.results.length ? `${res.results.length} Treffer für „${res.term}“` : `Keine Treffer für „${res.term}“`;
        searchInfo.subtitle = esc(res.truncated ? 'Nur die ersten Treffer werden gezeigt, bitte genauer suchen.'
            : (res.results.length ? '' : 'Nicht in der AM-Datenbank? Dann unten ein externes GitHub-AppImage eintragen.'));
        searchRows = res.results.map(e => {
            const desc = e.desc.length > 220 ? e.desc.slice(0, 217) + '…' : e.desc;
            const row = new Adw.ActionRow({ title: esc(e.name), subtitle: esc(desc), subtitle_lines: 3, activatable: false });
            if (e.installed === 'user') {
                row.add_suffix(new Gtk.Label({ label: 'im Benutzerordner', css_classes: ['dim-label'], valign: Gtk.Align.CENTER }));
            } else {
                const btn = new Gtk.Button({ label: e.installed === 'system' ? 'Zusätzlich als Benutzer installieren' : 'Installieren', valign: Gtk.Align.CENTER, sensitive: !busy });
                btn.connect('clicked', () => { if (!busy) doInstallNew(e); });
                installBtns.push(btn);
                row.add_suffix(btn);
            }
            gSearch.add(row);
            return row;
        });
    };
    searchBtn.connect('clicked', doSearch);
    searchRow.connect('entry-activated', doSearch);

    const doInstallNew = async e => {
        const body = [
            `„${e.name}“ wird im Benutzerordner installiert:`,
            `• Zielordner: ${state.plan?.target ?? ''}`,
            '• Ohne Administratorrechte; nichts in /opt oder /usr wird verändert.',
            '• Danach wird die App geprüft (Datei, Updater, Link, Start).',
            e.installed === 'system' ? '• Es gibt schon eine Systemversion in /opt; sie bleibt bestehen, bis du sie selbst entfernst.' : '',
            e.variants_note ? '• Dieses Programm gibt es in mehreren Varianten; bitte unten als externes GitHub-AppImage mit Schlüsselwort installieren.' : '',
        ].filter(Boolean).join('\n');
        if (!await confirm(window, 'Im Benutzerordner installieren?', body, 'Installieren')) return;
        await streamInstall(['--am-install-new', e.name], 1);
        doSearch();
    };

    // --- Externes GitHub-AppImage ---
    const loadHints = async () => {
        let hints = [];
        try { hints = await runTool(extPath, ['--am-extra-hints']); } catch (_e) { /* optional */ }
        hintRows.forEach(r => gExtra.remove(r)); hintRows = [];
        hintRows = hints.map(h => {
            const r = new Adw.ActionRow({ title: esc(`Vorschlag aus der Systeminstallation: ${h.name}`),
                subtitle: esc(`${h.repo}${h.keyword ? ' · Variante ' + h.keyword : ''}`), activatable: false });
            const b = new Gtk.Button({ label: 'Übernehmen', valign: Gtk.Align.CENTER });
            b.connect('clicked', () => { repoRow.text = h.repo; nameRow.text = h.name; kwRow.text = h.keyword; });
            r.add_suffix(b);
            gExtra.add(r);
            return r;
        });
        // Reihenfolge: Vorschläge zuerst, dann die Eingabefelder und der Installieren-Knopf
        [repoRow, nameRow, kwRow, extraBtnRow].forEach(r => { gExtra.remove(r); gExtra.add(r); });
    };
    extraBtn.connect('clicked', async () => {
        if (busy) return;
        const repo = repoRow.text.trim(), name = nameRow.text.trim(), kw = kwRow.text.trim();
        if (!repo || !name) { extraBtnRow.subtitle = 'Bitte Repository und Programmnamen ausfüllen.'; return; }
        extraBtnRow.subtitle = 'Im Benutzerordner, danach wird die App geprüft.';
        const body = [
            `„${name}“ wird von github.com/${repo.replace(/^https?:\/\/github\.com\//, '')} im Benutzerordner installiert${kw ? ' (Variante ' + kw + ')' : ''}.`,
            `• Zielordner: ${state.plan?.target ?? ''}`,
            '• Ohne Administratorrechte; nichts in /opt oder /usr wird verändert.',
            '• Quelle ist das neueste GitHub-Release, ohne Prüfsumme der Datenbank: nur für Quellen, denen du vertraust.',
        ].join('\n');
        if (!await confirm(window, 'Externes AppImage installieren?', body, 'Installieren')) return;
        await streamInstall(['--am-install-extra', repo, name, ...(kw ? [kw] : [])], 1);
    });

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
    loadHints();
    loadNotify();
    return page;
}
