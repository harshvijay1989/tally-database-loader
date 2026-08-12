import http from 'node:http';
import fs from 'node:fs';
import child_process from 'node:child_process';
import { URL } from 'node:url';
import * as tallyLive from './tallyLive.mjs';
// Local web UI for the Tally connector (mapping designer + sync engine).
//
// Connections are configured entirely from the UI and stored in connections.json
// (git-ignored). No CLI, no tokens pasted into files by hand.
//   - Salesforce: OAuth 2.0 Client Credentials flow (Connected App Client ID +
//     Secret + My Domain URL). Used for object/field discovery and upserts.
//   - Google: OAuth 2.0 browser sign-in (loopback redirect). A refresh token is
//     stored and used to upload generated CSV files to Google Drive.
//
// A mapping document targets ONE destination ('salesforce' or 'googledrive').
const PORT = Number(process.env.PORT) || 3000;
const MAP_DIR = './mappings';
const CONN_FILE = './connections.json';
const REDIRECT_URI = `http://localhost:${PORT}/oauth/google/callback`;
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
function ensureMapDir() { if (!fs.existsSync(MAP_DIR))
    fs.mkdirSync(MAP_DIR); }
function mapSlug(name) { return (String(name).replace(/[^a-zA-Z0-9 _-]/g, '').trim()) || 'mapping'; }
function loadConn() {
    try {
        const c = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'));
        return { salesforce: c.salesforce || {}, google: c.google || {} };
    }
    catch {
        return { salesforce: {}, google: {} };
    }
}
function saveConn(c) { fs.writeFileSync(CONN_FILE, JSON.stringify(c, null, 2)); }
let sfCache = null;
// Returns null when credentials are not configured. Throws with a readable
// message when configured credentials are rejected by Salesforce.
async function sfAuth(force = false) {
    const c = loadConn().salesforce;
    if (!c.instanceUrl || !c.clientId || !c.clientSecret)
        return null;
    if (!force && sfCache && Date.now() - sfCache.at < 25 * 60 * 1000)
        return sfCache.auth;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret });
    const resp = await fetch(`${c.instanceUrl.replace(/\/$/, '')}/services/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
        throw new Error(`Salesforce login failed: ${data.error || resp.status} - ${data.error_description || 'check Instance URL / Client ID / Secret and that the Connected App enables the Client Credentials flow'}`);
    }
    const auth = { accessToken: data.access_token, instanceUrl: data.instance_url || c.instanceUrl, apiVersion: c.apiVersion || '62.0' };
    sfCache = { auth, at: Date.now() };
    return auth;
}
async function sfAuthOrNull(force = false) { try {
    return await sfAuth(force);
}
catch {
    return null;
} }
async function sfApi(path) {
    let auth = await sfAuth();
    if (!auth)
        throw new Error('Salesforce not connected');
    let resp = await fetch(`${auth.instanceUrl}${path}`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } });
    if (resp.status === 401) {
        auth = await sfAuth(true);
        if (auth)
            resp = await fetch(`${auth.instanceUrl}${path}`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } });
    }
    return resp.json();
}
async function sfUsername(auth) {
    try {
        const u = await (await fetch(`${auth.instanceUrl}/services/oauth2/userinfo`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } })).json();
        return u.preferred_username || u.name || u.email || '';
    }
    catch {
        return '';
    }
}
// --- Google auth (OAuth browser sign-in) ------------------------------------
let gCache = null;
async function googleToken(force = false) {
    const g = loadConn().google;
    if (!g.clientId || !g.clientSecret || !g.refreshToken)
        return null;
    if (!force && gCache && Date.now() < gCache.expires - 60000)
        return gCache.token;
    const body = new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' });
    const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token)
        return null;
    gCache = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
    return gCache.token;
}
async function googleEmail(token) {
    try {
        const u = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { 'Authorization': `Bearer ${token}` } })).json();
        return u.email || '';
    }
    catch {
        return '';
    }
}
async function driveUpload(token, folderId, name, csv) {
    const metadata = { name, mimeType: 'text/csv' };
    if (folderId)
        metadata.parents = [folderId];
    const boundary = 't2sf' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--`;
    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink', {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok)
        throw new Error(`Drive upload failed: ${data.error?.message || resp.status}`);
    return data;
}
function readBody(req) {
    return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}
// bounded-concurrency map (keeps Tally probes from running one-at-a-time or all-at-once)
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return out;
}
function loadTallyConfig() {
    try {
        const c = JSON.parse(fs.readFileSync('./config.json', 'utf8')).tally || {};
        return { server: c.server || 'localhost', port: Number(c.port) || 9000, company: c.company || '', fromDate: c.fromdate || '', toDate: c.todate || '' };
    }
    catch {
        return { server: 'localhost', port: 9000, company: '', fromDate: '', toDate: '' };
    }
}
function loadCatalog() {
    const out = {};
    try {
        const cfg = JSON.parse(fs.readFileSync('./tally-export-config.json', 'utf8'));
        for (const t of (cfg.tables || [])) {
            out[t.name] = {
                table: t.name,
                tallyType: (t.collectionPaths && t.collectionPaths[0]) || '',
                // friendly output-column names — these match the static extractor's JSON keys
                staticFields: (t.fields || []).map((f) => f.name),
                isMaster: !!t.isMaster
            };
        }
    }
    catch { /* ignore */ }
    return out;
}
// Only pass a date window for voucher-type collections, and only when it is a real
// YYYYMMDD value (config often holds 'auto', which Tally would reject).
function liveDateOpts(tc, tallyType) {
    const opts = {};
    if (tc.company)
        opts.company = tc.company;
    if (/voucher/i.test(tallyType)) {
        if (/^\d{8}$/.test(tc.fromDate))
            opts.fromDate = tc.fromDate;
        if (/^\d{8}$/.test(tc.toDate))
            opts.toDate = tc.toDate;
    }
    return opts;
}
// --- Run engine: extract Tally -> filter -> map -> destination ---------------
function extractTallyToJson() {
    return new Promise((resolve, reject) => {
        const child = child_process.spawn(process.execPath, ['./dist/index.mjs', '--database-technology', 'json'], { cwd: process.cwd() });
        child.on('close', () => resolve());
        child.on('error', reject);
    });
}
function applyTransform(v, t) {
    if (v == null || !t || t === 'none')
        return v;
    switch (t) {
        case 'abs': {
            const n = parseFloat(v);
            return isNaN(n) ? v : Math.abs(n);
        }
        case 'number': {
            const n = parseFloat(v);
            return isNaN(n) ? v : n;
        }
        case 'trim': return String(v).trim();
        case 'upper': return String(v).toUpperCase();
        case 'lower': return String(v).toLowerCase();
        case 'date': return String(v).slice(0, 10);
        default: return v;
    }
}
function matchFilter(value, op, target) {
    const na = parseFloat(value), nb = parseFloat(target);
    const numeric = !isNaN(na) && !isNaN(nb);
    switch (op) {
        case '==': return String(value) === String(target);
        case '!=': return String(value) !== String(target);
        case '>': return numeric ? na > nb : String(value) > target;
        case '>=': return numeric ? na >= nb : String(value) >= target;
        case '<': return numeric ? na < nb : String(value) < target;
        case '<=': return numeric ? na <= nb : String(value) <= target;
        default: return true;
    }
}
function readSource(sourceObject) {
    const file = `./csv/${sourceObject}.json`;
    if (!fs.existsSync(file))
        return [];
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}
function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(fields, rows) {
    const header = fields.map(f => csvEscape(f.target || f.source)).join(',');
    const lines = rows.map(r => fields.map(f => {
        let val = ('constant' in f) ? f.constant : r[f.source];
        if (f.transform)
            val = applyTransform(val, f.transform);
        return csvEscape(val);
    }).join(','));
    return [header, ...lines].join('\r\n');
}
async function upsertRecords(auth, objectApi, externalIdField, rows) {
    const result = { total: rows.length, success: 0, failed: 0, errors: [], keyToId: {} };
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const payload = { allOrNone: false, records: batch.map(r => ({ attributes: { type: objectApi }, ...r })) };
        const resp = await fetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/composite/sobjects/${objectApi}/${externalIdField}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const body = await resp.json();
        if (!resp.ok) {
            result.failed += batch.length;
            if (result.errors.length < 10)
                result.errors.push(JSON.stringify(body).slice(0, 300));
            continue;
        }
        body.forEach((res, j) => {
            if (res.success) {
                result.success++;
                const key = batch[j][externalIdField];
                if (key != null && res.id)
                    result.keyToId[String(key)] = res.id;
            }
            else {
                result.failed++;
                if (result.errors.length < 10)
                    result.errors.push((res.errors || []).map((e) => `${e.statusCode || ''} ${e.message}`).join('; '));
            }
        });
    }
    return result;
}
// order object mappings so a parent runs before any child that references it
function orderMappings(oms) {
    const byId = Object.fromEntries(oms.map(m => [m.id, m]));
    const placed = new Set(), out = [];
    let guard = 0;
    while (out.length < oms.length && guard++ < 200) {
        for (const om of oms) {
            if (placed.has(om.id))
                continue;
            const deps = (om.relationships || []).map((r) => r.parentMapping).filter((p) => byId[p] && p !== om.id);
            if (deps.every((d) => placed.has(d))) {
                out.push(om);
                placed.add(om.id);
            }
        }
    }
    for (const om of oms)
        if (!placed.has(om.id))
            out.push(om);
    return out;
}
async function runSalesforce(mapping, emit, getRows) {
    const auth = await sfAuth();
    if (!auth)
        throw new Error('Salesforce not connected — configure it in Connections');
    const oms = orderMappings(mapping.objectMappings || []).filter((o) => o.targetObject && o.externalIdField);
    const byId = Object.fromEntries(oms.map(m => [m.id, m]));
    const parentData = {};
    emit({ type: 'start', objects: oms.map((o) => ({ sourceObject: o.sourceObject, targetObject: o.targetObject })) });
    for (const om of oms) {
        emit({ type: 'progress', targetObject: om.targetObject });
        let rows = await getRows(om.sourceObject);
        if (!rows.length) {
            emit({ type: 'object', sourceObject: om.sourceObject, targetObject: om.targetObject, total: 0, success: 0, failed: 0, errors: [`source ${om.sourceObject} produced no data`] });
            continue;
        }
        if (om.filter && om.filter.field)
            rows = rows.filter((r) => matchFilter(r[om.filter.field], om.filter.operator, om.filter.value));
        const relLookups = (om.relationships || []).map((rel) => {
            const parent = byId[rel.parentMapping];
            const pd = parentData[rel.parentMapping];
            const matchField = rel.parentMatchField || (parent && parent.externalIdField);
            const map = {};
            if (pd && matchField)
                for (const prow of pd.rows) {
                    const sfId = pd.keyToId[String(prow[pd.extId])];
                    const mv = prow[matchField];
                    if (sfId && mv != null && mv !== '')
                        map[String(mv)] = sfId;
                }
            return { rel, map };
        });
        const mapped = rows.map((r) => {
            const o = {};
            for (const f of (om.fields || [])) {
                let val = ('constant' in f) ? f.constant : r[f.source];
                if (f.transform)
                    val = applyTransform(val, f.transform);
                o[f.target] = val;
            }
            let orphan = false;
            for (const { rel, map } of relLookups) {
                const key = r[rel.sourceKey];
                const pid = (key != null && key !== '') ? map[String(key)] : undefined;
                if (pid)
                    o[rel.targetField] = pid;
                else
                    orphan = true;
            }
            return orphan ? null : o;
        }).filter(Boolean);
        const skipped = rows.length - mapped.length;
        const res = await upsertRecords(auth, om.targetObject, om.externalIdField, mapped);
        if (skipped)
            res.errors.unshift(`${skipped} row(s) skipped (no matching parent)`);
        parentData[om.id] = { rows: mapped, keyToId: res.keyToId, extId: om.externalIdField };
        emit({ type: 'object', sourceObject: om.sourceObject, targetObject: om.targetObject, total: res.total, success: res.success, failed: res.failed, errors: res.errors });
    }
    emit({ type: 'done' });
}
async function runGoogleDrive(mapping, emit, getRows) {
    const token = await googleToken();
    if (!token)
        throw new Error('Google not connected — configure it in Connections');
    const folderId = loadConn().google.folderId || '';
    const oms = (mapping.objectMappings || []).filter((o) => o.sourceObject && (o.fields || []).length);
    emit({ type: 'start', objects: oms.map((o) => ({ sourceObject: o.sourceObject, targetObject: (o.targetObject || o.sourceObject) })) });
    for (const om of oms) {
        const outName = om.targetObject || om.sourceObject;
        emit({ type: 'progress', targetObject: outName });
        let rows = await getRows(om.sourceObject);
        if (om.filter && om.filter.field)
            rows = rows.filter((r) => matchFilter(r[om.filter.field], om.filter.operator, om.filter.value));
        const csv = toCsv(om.fields || [], rows);
        const fname = String(outName).replace(/[^a-z0-9_-]+/gi, '_') + '.csv';
        try {
            const up = await driveUpload(token, folderId, fname, csv);
            emit({ type: 'object', sourceObject: om.sourceObject, targetObject: outName, total: rows.length, success: rows.length, failed: 0, errors: [`Uploaded ${up.name}${up.webViewLink ? ` — ${up.webViewLink}` : ''}`] });
        }
        catch (e) {
            emit({ type: 'object', sourceObject: om.sourceObject, targetObject: outName, total: rows.length, success: 0, failed: rows.length, errors: [String(e?.message || e)] });
        }
    }
    emit({ type: 'done' });
}
async function runMapping(name, emit) {
    const mapFile = `${MAP_DIR}/${mapSlug(name)}.json`;
    if (!fs.existsSync(mapFile))
        throw new Error('no mapping saved yet — save one first');
    const mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const tc = loadTallyConfig();
    const catalog = loadCatalog();
    const live = await tallyLive.reachable(tc.server, tc.port);
    emit({ type: 'extract', live });
    if (!live)
        await extractTallyToJson(); // static path: produce ./csv/<table>.json first
    // Source rows come live from Tally (FETCH *) when reachable, else from the
    // static extractor output. Cached per table so each object is fetched once.
    const cache = new Map();
    const getRows = async (table) => {
        if (cache.has(table))
            return cache.get(table);
        let rows;
        const cat = catalog[table];
        if (live && cat && cat.tallyType) {
            const r = await tallyLive.fetchObject(tc.server, tc.port, cat.tallyType, liveDateOpts(tc, cat.tallyType));
            rows = r.rows;
        }
        else {
            rows = readSource(table);
        }
        cache.set(table, rows);
        return rows;
    };
    if ((mapping.destination || 'salesforce') === 'googledrive')
        return runGoogleDrive(mapping, emit, getRows);
    return runSalesforce(mapping, emit, getRows);
}
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
    try {
        if (url.pathname === '/')
            return send(200, 'text/html', fs.readFileSync('./webui/index.html', 'utf8'));
        // --- combined session (both destinations) ---
        if (url.pathname === '/api/session') {
            const sf = await sfAuthOrNull();
            const gt = await googleToken();
            return json(200, {
                salesforce: { connected: !!sf, user: sf ? await sfUsername(sf) : '' },
                google: { connected: !!gt, email: gt ? await googleEmail(gt) : '' }
            });
        }
        // --- connections config ---
        if (url.pathname === '/api/connections' && req.method === 'GET') {
            const c = loadConn();
            // return everything except never echo secrets back in the clear; send a flag instead
            return json(200, {
                salesforce: { instanceUrl: c.salesforce.instanceUrl || '', clientId: c.salesforce.clientId || '', apiVersion: c.salesforce.apiVersion || '62.0', hasSecret: !!c.salesforce.clientSecret },
                google: { clientId: c.google.clientId || '', folderId: c.google.folderId || '', hasSecret: !!c.google.clientSecret, connected: !!c.google.refreshToken }
            });
        }
        if (url.pathname === '/api/connections/salesforce' && req.method === 'POST') {
            const b = JSON.parse(await readBody(req));
            const c = loadConn();
            c.salesforce.instanceUrl = (b.instanceUrl || '').trim();
            c.salesforce.clientId = (b.clientId || '').trim();
            if (b.clientSecret)
                c.salesforce.clientSecret = b.clientSecret.trim(); // keep existing if blank
            c.salesforce.apiVersion = (b.apiVersion || '62.0').replace(/^v/, '');
            saveConn(c);
            sfCache = null;
            return json(200, { saved: true });
        }
        if (url.pathname === '/api/connections/google' && req.method === 'POST') {
            const b = JSON.parse(await readBody(req));
            const c = loadConn();
            c.google.clientId = (b.clientId || '').trim();
            if (b.clientSecret)
                c.google.clientSecret = b.clientSecret.trim();
            c.google.folderId = extractDriveFolderId(b.folderId || '');
            saveConn(c);
            gCache = null;
            return json(200, { saved: true });
        }
        // --- Salesforce connect / test ---
        if (url.pathname === '/api/salesforce/test' && req.method === 'POST') {
            try {
                const a = await sfAuth(true);
                if (!a)
                    return json(200, { connected: false, error: 'Enter Instance URL, Client ID and Client Secret first' });
                return json(200, { connected: true, user: await sfUsername(a) });
            }
            catch (e) {
                return json(200, { connected: false, error: String(e?.message || e) });
            }
        }
        if (url.pathname === '/api/salesforce/disconnect' && req.method === 'POST') {
            sfCache = null;
            return json(200, { connected: false });
        }
        // --- Google OAuth browser flow ---
        if (url.pathname === '/api/google/auth-url') {
            const g = loadConn().google;
            if (!g.clientId || !g.clientSecret)
                return json(400, { error: 'Enter Google Client ID and Secret first' });
            const p = new URLSearchParams({ client_id: g.clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
            return json(200, { url: `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}` });
        }
        if (url.pathname === '/oauth/google/callback') {
            const code = url.searchParams.get('code');
            const err = url.searchParams.get('error');
            if (err || !code)
                return send(200, 'text/html', `<h2>Google sign-in cancelled</h2><p>${err || 'no code returned'}. You can close this tab.</p>`);
            const g = loadConn().google;
            const body = new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' });
            const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).json().catch(() => ({}));
            if (tok.refresh_token) {
                const c = loadConn();
                c.google.refreshToken = tok.refresh_token;
                saveConn(c);
                gCache = null;
            }
            const okHtml = `<body style="font:16px system-ui;text-align:center;padding-top:60px"><h2 style="color:#16a34a">✓ Google connected</h2><p>You can close this tab and return to the connector.</p><script>setTimeout(()=>window.close(),1200)</script></body>`;
            const failHtml = `<body style="font:16px system-ui;text-align:center;padding-top:60px"><h2 style="color:#b42318">Google sign-in failed</h2><p>${tok.error_description || tok.error || 'no refresh token returned — remove the app under Google Account permissions and try again'}</p></body>`;
            return send(200, 'text/html', tok.refresh_token ? okHtml : failHtml);
        }
        if (url.pathname === '/api/google/disconnect' && req.method === 'POST') {
            const c = loadConn();
            c.google.refreshToken = '';
            saveConn(c);
            gCache = null;
            return json(200, { connected: false });
        }
        // --- Tally source discovery ---
        if (url.pathname === '/api/tally/tables') {
            const cfg = JSON.parse(fs.readFileSync('./tally-export-config.json', 'utf8'));
            const tables = (cfg.tables || []).map((t) => ({
                name: t.name, isMaster: t.isMaster,
                fields: (t.fields || []).map((f) => ({ name: f.name, datatype: f.datatype, source: f.source }))
            }));
            return json(200, { tables });
        }
        // live "fetch everything": all fields for one object, or the static list if Tally is offline
        if (url.pathname === '/api/tally/fields') {
            const table = url.searchParams.get('table') || '';
            const cat = loadCatalog()[table];
            if (!cat)
                return json(404, { error: 'unknown table' });
            const tc = loadTallyConfig();
            try {
                if (!(await tallyLive.reachable(tc.server, tc.port)))
                    throw new Error('offline');
                const r = await tallyLive.fetchObject(tc.server, tc.port, cat.tallyType, liveDateOpts(tc, cat.tallyType));
                if (!r.fields.length)
                    throw new Error('no fields returned');
                return json(200, { source: 'live', tallyType: cat.tallyType, fields: r.fields, count: r.rows.length });
            }
            catch {
                return json(200, { source: 'static', tallyType: cat.tallyType, fields: cat.staticFields, count: null });
            }
        }
        // session-only object discovery: which known objects actually have data in the company
        if (url.pathname === '/api/tally/objects/refresh') {
            const tc = loadTallyConfig();
            if (!(await tallyLive.reachable(tc.server, tc.port)))
                return json(200, { reachable: false, objects: [] });
            const cat = loadCatalog();
            const entries = Object.values(cat);
            // probe in parallel (bounded) so ~30 objects don't run one-at-a-time
            const objects = await mapLimit(entries, 6, async (e) => {
                if (!e.tallyType)
                    return { table: e.table, present: false, count: 0 };
                const p = await tallyLive.probePresence(tc.server, tc.port, e.tallyType, liveDateOpts(tc, e.tallyType));
                return { table: e.table, present: p.present, count: p.count };
            });
            return json(200, { reachable: true, objects });
        }
        // --- Salesforce target discovery (live) ---
        if (url.pathname === '/api/salesforce/objects') {
            const auth = await sfAuthOrNull();
            if (!auth)
                return json(401, { error: 'not connected' });
            const d = await sfApi(`/services/data/v${auth.apiVersion}/sobjects`);
            const objects = (d.sobjects || [])
                .filter((s) => s.createable && s.queryable && !s.customSetting)
                .map((s) => ({ name: s.name, label: s.label, custom: s.custom }))
                .sort((a, b) => a.label.localeCompare(b.label));
            return json(200, { objects });
        }
        if (url.pathname.startsWith('/api/salesforce/object/')) {
            const auth = await sfAuthOrNull();
            if (!auth)
                return json(401, { error: 'not connected' });
            const name = decodeURIComponent(url.pathname.split('/').pop() || '');
            const d = await sfApi(`/services/data/v${auth.apiVersion}/sobjects/${name}/describe`);
            const fields = (d.fields || []).map((f) => ({
                name: f.name, label: f.label, type: f.type,
                createable: f.createable, externalId: f.externalId, idLookup: f.idLookup,
                required: f.createable && !f.nillable && !f.defaultedOnCreate,
                reference: f.type === 'reference',
                referenceTo: f.referenceTo || [],
                relationshipName: f.relationshipName || null
            }));
            return json(200, { name, fields });
        }
        // --- named mapping persistence (mappings/<name>.json) ---
        if (url.pathname === '/api/mappings') {
            ensureMapDir();
            const names = fs.readdirSync(MAP_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
            return json(200, { mappings: names });
        }
        if (url.pathname === '/api/mappings/get') {
            const file = `${MAP_DIR}/${mapSlug(url.searchParams.get('name') || '')}.json`;
            if (!fs.existsSync(file))
                return json(404, { error: 'not found' });
            return send(200, 'application/json', fs.readFileSync(file, 'utf8'));
        }
        if (url.pathname === '/api/mappings/save' && req.method === 'POST') {
            ensureMapDir();
            const doc = JSON.parse(await readBody(req));
            const name = mapSlug(doc.name);
            fs.writeFileSync(`${MAP_DIR}/${name}.json`, JSON.stringify({ name, destination: doc.destination || 'salesforce', objectMappings: doc.objectMappings || [] }, null, 2));
            return json(200, { saved: true, name });
        }
        if (url.pathname === '/api/mappings/delete' && req.method === 'POST') {
            const file = `${MAP_DIR}/${mapSlug(JSON.parse(await readBody(req)).name)}.json`;
            if (fs.existsSync(file))
                fs.unlinkSync(file);
            return json(200, { deleted: true });
        }
        if (url.pathname === '/api/run' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
            const emit = (ev) => { try {
                res.write(JSON.stringify(ev) + '\n');
            }
            catch { /* client gone */ } };
            try {
                await runMapping(mapSlug(body.name || ''), emit);
            }
            catch (e) {
                emit({ type: 'error', message: String(e?.message || e) });
            }
            res.end();
            return;
        }
        send(404, 'text/plain', 'not found');
    }
    catch (err) {
        send(500, 'text/plain', String(err?.message || err));
    }
});
// Accept a raw folder id OR a full Drive folder URL and return just the id.
function extractDriveFolderId(input) {
    const s = (input || '').trim();
    const m = s.match(/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : s;
}
server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.log(`The connector is already running — opening http://localhost:${PORT} in your browser.`);
        child_process.exec(`start http://localhost:${PORT}`);
        setTimeout(() => process.exit(0), 500);
    }
    else {
        console.error(err);
        process.exit(1);
    }
});
server.listen(PORT, () => {
    console.log(`Connector UI running at http://localhost:${PORT}`);
    if (!process.env.NO_OPEN)
        child_process.exec(`start http://localhost:${PORT}`);
});
//# sourceMappingURL=uiServer.mjs.map