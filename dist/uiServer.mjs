import http from 'node:http';
import fs from 'node:fs';
import child_process from 'node:child_process';
import { URL } from 'node:url';
// Local web UI for the Tally -> Salesforce connector (mapping designer).
//
// Auth: piggybacks on the Salesforce CLI (`sf`). "Connect" runs `sf org login web`
// (browser login, no Connected App / no secret / no tokens pasted); the access token
// is read back via `sf org display` (the CLI auto-refreshes it). This is how many
// local Salesforce tools authenticate — zero app setup for the user.
//
// Discovers Tally source tables (from tally-export-config.json) and Salesforce target
// objects/fields (live via the Describe API).
const PORT = 3000;
const ORG_ALIAS = 'tallydemo';
let authCache = null;
function runSf(args) {
    return new Promise((resolve) => {
        const child = child_process.spawn('sf', args, { shell: true, env: { ...process.env, SF_TEMP_SHOW_SECRETS: 'true' } });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
        child.on('error', () => resolve({ code: -1, stdout, stderr }));
    });
}
async function getAuth(force = false) {
    if (!force && authCache && Date.now() - authCache.at < 25 * 60 * 1000)
        return authCache.auth;
    const r = await runSf(['org', 'display', '--target-org', ORG_ALIAS, '--verbose', '--json']);
    try {
        const j = JSON.parse(r.stdout);
        if (j.status === 0 && j.result && j.result.accessToken) {
            const auth = {
                accessToken: j.result.accessToken,
                instanceUrl: j.result.instanceUrl,
                apiVersion: j.result.apiVersion || '62.0',
                username: j.result.username
            };
            authCache = { auth, at: Date.now() };
            return auth;
        }
    }
    catch { /* not authed */ }
    return null;
}
async function sfApi(path) {
    let auth = await getAuth();
    if (!auth)
        throw new Error('not connected');
    let resp = await fetch(`${auth.instanceUrl}${path}`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } });
    if (resp.status === 401) { // token stale -> refresh once
        auth = await getAuth(true);
        if (auth)
            resp = await fetch(`${auth.instanceUrl}${path}`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } });
    }
    return resp.json();
}
function readBody(req) {
    return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}
// --- Run engine: extract Tally -> filter -> map -> upsert to Salesforce ---
function extractTallyToJson() {
    return new Promise((resolve, reject) => {
        const child = child_process.spawn(process.execPath, ['./dist/index.mjs', '--database-technology', 'json'], { cwd: process.cwd() });
        child.on('close', () => resolve());
        child.on('error', reject);
    });
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
async function upsertRecords(auth, objectApi, externalIdField, rows) {
    const result = { total: rows.length, success: 0, failed: 0, errors: [] };
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
        for (const res of body) {
            if (res.success)
                result.success++;
            else {
                result.failed++;
                if (result.errors.length < 10)
                    result.errors.push((res.errors || []).map((e) => `${e.statusCode || ''} ${e.message}`).join('; '));
            }
        }
    }
    return result;
}
async function runMapping() {
    const auth = await getAuth();
    if (!auth)
        throw new Error('not connected to Salesforce');
    if (!fs.existsSync('./mapping.json'))
        throw new Error('no mapping saved yet');
    const mapping = JSON.parse(fs.readFileSync('./mapping.json', 'utf8'));
    await extractTallyToJson(); // pull fresh Tally data as ./csv/<table>.json
    const out = [];
    for (const om of (mapping.objectMappings || [])) {
        const file = `./csv/${om.sourceObject}.json`;
        if (!fs.existsSync(file)) {
            out.push({ sourceObject: om.sourceObject, targetObject: om.targetObject, total: 0, success: 0, failed: 0, errors: [`source ${om.sourceObject} produced no data`] });
            continue;
        }
        let rows = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        if (om.filter && om.filter.field)
            rows = rows.filter(r => matchFilter(r[om.filter.field], om.filter.operator, om.filter.value));
        const mapped = rows.map(r => { const o = {}; for (const f of om.fields)
            o[f.target] = r[f.source]; return o; });
        const res = await upsertRecords(auth, om.targetObject, om.externalIdField, mapped);
        out.push({ sourceObject: om.sourceObject, targetObject: om.targetObject, ...res });
    }
    return out;
}
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    const json = (code, obj) => send(code, 'application/json', JSON.stringify(obj));
    try {
        if (url.pathname === '/')
            return send(200, 'text/html', fs.readFileSync('./webui/index.html', 'utf8'));
        // --- session / connect via Salesforce CLI ---
        if (url.pathname === '/api/session') {
            const auth = await getAuth();
            return json(200, { connected: !!auth, user: auth?.username, instanceUrl: auth?.instanceUrl });
        }
        if (url.pathname === '/api/connect' && req.method === 'POST') {
            let auth = await getAuth();
            if (!auth) { // open browser login (blocks until the user finishes)
                await runSf(['org', 'login', 'web', '--alias', ORG_ALIAS]);
                auth = await getAuth(true);
            }
            return json(200, { connected: !!auth, user: auth?.username });
        }
        if (url.pathname === '/api/switch-org' && req.method === 'POST') {
            await runSf(['org', 'login', 'web', '--alias', ORG_ALIAS]);
            const auth = await getAuth(true);
            return json(200, { connected: !!auth, user: auth?.username });
        }
        if (url.pathname === '/api/disconnect') {
            await runSf(['org', 'logout', '--target-org', ORG_ALIAS, '--no-prompt']);
            authCache = null;
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
        // --- Salesforce target discovery (live) ---
        if (url.pathname === '/api/salesforce/objects') {
            const auth = await getAuth();
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
            const auth = await getAuth();
            if (!auth)
                return json(401, { error: 'not connected' });
            const name = decodeURIComponent(url.pathname.split('/').pop() || '');
            const d = await sfApi(`/services/data/v${auth.apiVersion}/sobjects/${name}/describe`);
            const fields = (d.fields || []).map((f) => ({
                name: f.name, label: f.label, type: f.type,
                createable: f.createable, externalId: f.externalId, idLookup: f.idLookup,
                required: f.createable && !f.nillable && !f.defaultedOnCreate
            }));
            return json(200, { name, fields });
        }
        // --- mapping persistence ---
        if (url.pathname === '/api/mapping/save' && req.method === 'POST') {
            fs.writeFileSync('./mapping.json', await readBody(req));
            return json(200, { saved: true });
        }
        if (url.pathname === '/api/mapping/load') {
            const raw = fs.existsSync('./mapping.json') ? fs.readFileSync('./mapping.json', 'utf8') : '{"objectMappings":[]}';
            return send(200, 'application/json', raw);
        }
        if (url.pathname === '/api/run' && req.method === 'POST') {
            try {
                return json(200, { results: await runMapping() });
            }
            catch (e) {
                return json(200, { error: String(e?.message || e) });
            }
        }
        send(404, 'text/plain', 'not found');
    }
    catch (err) {
        send(500, 'text/plain', String(err?.message || err));
    }
});
server.listen(PORT, () => {
    console.log(`Connector UI running at http://localhost:${PORT}`);
    child_process.exec(`start http://localhost:${PORT}`);
});
//# sourceMappingURL=uiServer.mjs.map