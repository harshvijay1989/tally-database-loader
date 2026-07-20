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
const MAP_DIR = './mappings';
function ensureMapDir() { if (!fs.existsSync(MAP_DIR)) fs.mkdirSync(MAP_DIR); }
function mapSlug(name: string) { return (String(name).replace(/[^a-zA-Z0-9 _-]/g, '').trim()) || 'mapping'; }

interface SfAuth { accessToken: string; instanceUrl: string; apiVersion: string; username: string; }
let authCache: { auth: SfAuth; at: number } | null = null;

function runSf(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = child_process.spawn('sf', args, { shell: true, env: { ...process.env, SF_TEMP_SHOW_SECRETS: 'true' } });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
        child.on('error', () => resolve({ code: -1, stdout, stderr }));
    });
}

async function getAuth(force = false): Promise<SfAuth | null> {
    if (!force && authCache && Date.now() - authCache.at < 25 * 60 * 1000) return authCache.auth;
    const r = await runSf(['org', 'display', '--target-org', ORG_ALIAS, '--verbose', '--json']);
    try {
        const j = JSON.parse(r.stdout);
        if (j.status === 0 && j.result && j.result.accessToken) {
            const auth: SfAuth = {
                accessToken: j.result.accessToken,
                instanceUrl: j.result.instanceUrl,
                apiVersion: j.result.apiVersion || '62.0',
                username: j.result.username
            };
            authCache = { auth, at: Date.now() };
            return auth;
        }
    } catch { /* not authed */ }
    return null;
}

async function sfApi(path: string): Promise<any> {
    let auth = await getAuth();
    if (!auth) throw new Error('not connected');
    let resp = await fetch(`${auth.instanceUrl}${path}`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } });
    if (resp.status === 401) { // token stale -> refresh once
        auth = await getAuth(true);
        if (auth) resp = await fetch(`${auth.instanceUrl}${path}`, { headers: { 'Authorization': `Bearer ${auth.accessToken}` } });
    }
    return resp.json();
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}

// --- Run engine: extract Tally -> filter -> map -> upsert to Salesforce ---

function extractTallyToJson(): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = child_process.spawn(process.execPath, ['./dist/index.mjs', '--database-technology', 'json'], { cwd: process.cwd() });
        child.on('close', () => resolve());
        child.on('error', reject);
    });
}

function matchFilter(value: any, op: string, target: string): boolean {
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

async function upsertRecords(auth: SfAuth, objectApi: string, externalIdField: string, rows: Record<string, any>[]) {
    const result = { total: rows.length, success: 0, failed: 0, errors: [] as string[], keyToId: {} as Record<string, string> };
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const payload = { allOrNone: false, records: batch.map(r => ({ attributes: { type: objectApi }, ...r })) };
        const resp = await fetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/composite/sobjects/${objectApi}/${externalIdField}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const body: any = await resp.json();
        if (!resp.ok) { result.failed += batch.length; if (result.errors.length < 10) result.errors.push(JSON.stringify(body).slice(0, 300)); continue; }
        body.forEach((res: any, j: number) => {
            if (res.success) {
                result.success++;
                const key = batch[j][externalIdField];
                if (key != null && res.id) result.keyToId[String(key)] = res.id; // remember ext-id -> SF id for children
            } else {
                result.failed++;
                if (result.errors.length < 10) result.errors.push((res.errors || []).map((e: any) => `${e.statusCode || ''} ${e.message}`).join('; '));
            }
        });
    }
    return result;
}

// order object mappings so a parent runs before any child that references it
function orderMappings(oms: any[]): any[] {
    const byId: Record<string, any> = Object.fromEntries(oms.map(m => [m.id, m]));
    const placed = new Set<string>(), out: any[] = [];
    let guard = 0;
    while (out.length < oms.length && guard++ < 200) {
        for (const om of oms) {
            if (placed.has(om.id)) continue;
            const deps = (om.relationships || []).map((r: any) => r.parentMapping).filter((p: string) => byId[p] && p !== om.id);
            if (deps.every((d: string) => placed.has(d))) { out.push(om); placed.add(om.id); }
        }
    }
    for (const om of oms) if (!placed.has(om.id)) out.push(om); // cycle safety
    return out;
}

async function runMapping(name: string): Promise<any[]> {
    const auth = await getAuth();
    if (!auth) throw new Error('not connected to Salesforce');
    const file = `${MAP_DIR}/${mapSlug(name)}.json`;
    if (!fs.existsSync(file)) throw new Error('no mapping saved yet — save one first');
    const mapping = JSON.parse(fs.readFileSync(file, 'utf8'));

    await extractTallyToJson(); // pull fresh Tally data as ./csv/<table>.json

    const oms = orderMappings(mapping.objectMappings || []);
    const byId: Record<string, any> = Object.fromEntries(oms.map(m => [m.id, m]));
    // per parent mapping: the upserted rows + ext-id->SF-id, so children can match on ANY parent field
    const parentData: Record<string, { rows: any[]; keyToId: Record<string, string>; extId: string }> = {};
    const out: any[] = [];

    for (const om of oms) {
        const file = `./csv/${om.sourceObject}.json`;
        if (!om.targetObject || !om.externalIdField) continue;
        if (!fs.existsSync(file)) { out.push({ sourceObject: om.sourceObject, targetObject: om.targetObject, total: 0, success: 0, failed: 0, errors: [`source ${om.sourceObject} produced no data`] }); continue; }
        let rows: any[] = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        if (om.filter && om.filter.field) rows = rows.filter(r => matchFilter(r[om.filter.field], om.filter.operator, om.filter.value));

        // build a value -> SF id lookup for each relationship, keyed on the parent's chosen match field
        const relLookups = (om.relationships || []).map((rel: any) => {
            const parent = byId[rel.parentMapping];
            const pd = parentData[rel.parentMapping];
            const matchField = rel.parentMatchField || (parent && parent.externalIdField);
            const map: Record<string, string> = {};
            if (pd && matchField) for (const prow of pd.rows) {
                const sfId = pd.keyToId[String(prow[pd.extId])];
                const mv = prow[matchField];
                if (sfId && mv != null && mv !== '') map[String(mv)] = sfId;
            }
            return { rel, map };
        });

        const mapped = rows.map(r => {
            const o: Record<string, any> = {};
            for (const f of (om.fields || [])) o[f.target] = ('constant' in f) ? f.constant : r[f.source];
            let orphan = false;
            for (const { rel, map } of relLookups) {
                const key = r[rel.sourceKey];
                const pid = (key != null && key !== '') ? map[String(key)] : undefined;
                if (pid) o[rel.targetField] = pid;   // resolved parent SF id
                else orphan = true;                  // parent not found -> skip this child
            }
            return orphan ? null : o;
        }).filter(Boolean) as Record<string, any>[];
        const skipped = rows.length - mapped.length;

        const res = await upsertRecords(auth, om.targetObject, om.externalIdField, mapped);
        if (skipped) res.errors.unshift(`${skipped} row(s) skipped (no matching parent)`);
        parentData[om.id] = { rows: mapped, keyToId: res.keyToId, extId: om.externalIdField };
        out.push({ sourceObject: om.sourceObject, targetObject: om.targetObject, total: res.total, success: res.success, failed: res.failed, errors: res.errors });
    }
    return out;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const send = (code: number, type: string, body: string) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    const json = (code: number, obj: any) => send(code, 'application/json', JSON.stringify(obj));

    try {
        if (url.pathname === '/') return send(200, 'text/html', fs.readFileSync('./webui/index.html', 'utf8'));

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
            const tables = (cfg.tables || []).map((t: any) => ({
                name: t.name, isMaster: t.isMaster,
                fields: (t.fields || []).map((f: any) => ({ name: f.name, datatype: f.datatype, source: f.source }))
            }));
            return json(200, { tables });
        }

        // --- Salesforce target discovery (live) ---
        if (url.pathname === '/api/salesforce/objects') {
            const auth = await getAuth();
            if (!auth) return json(401, { error: 'not connected' });
            const d = await sfApi(`/services/data/v${auth.apiVersion}/sobjects`);
            const objects = (d.sobjects || [])
                .filter((s: any) => s.createable && s.queryable && !s.customSetting)
                .map((s: any) => ({ name: s.name, label: s.label, custom: s.custom }))
                .sort((a: any, b: any) => a.label.localeCompare(b.label));
            return json(200, { objects });
        }
        if (url.pathname.startsWith('/api/salesforce/object/')) {
            const auth = await getAuth();
            if (!auth) return json(401, { error: 'not connected' });
            const name = decodeURIComponent(url.pathname.split('/').pop() || '');
            const d = await sfApi(`/services/data/v${auth.apiVersion}/sobjects/${name}/describe`);
            const fields = (d.fields || []).map((f: any) => ({
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
            if (!fs.existsSync(file)) return json(404, { error: 'not found' });
            return send(200, 'application/json', fs.readFileSync(file, 'utf8'));
        }
        if (url.pathname === '/api/mappings/save' && req.method === 'POST') {
            ensureMapDir();
            const doc = JSON.parse(await readBody(req));
            const name = mapSlug(doc.name);
            fs.writeFileSync(`${MAP_DIR}/${name}.json`, JSON.stringify({ name, objectMappings: doc.objectMappings || [] }, null, 2));
            return json(200, { saved: true, name });
        }
        if (url.pathname === '/api/mappings/delete' && req.method === 'POST') {
            const file = `${MAP_DIR}/${mapSlug(JSON.parse(await readBody(req)).name)}.json`;
            if (fs.existsSync(file)) fs.unlinkSync(file);
            return json(200, { deleted: true });
        }
        if (url.pathname === '/api/run' && req.method === 'POST') {
            try { return json(200, { results: await runMapping(mapSlug(JSON.parse(await readBody(req) || '{}').name || '')) }); }
            catch (e: any) { return json(200, { error: String(e?.message || e) }); }
        }

        send(404, 'text/plain', 'not found');
    } catch (err: any) {
        send(500, 'text/plain', String(err?.message || err));
    }
});

server.listen(PORT, () => {
    console.log(`Connector UI running at http://localhost:${PORT}`);
    child_process.exec(`start http://localhost:${PORT}`);
});
