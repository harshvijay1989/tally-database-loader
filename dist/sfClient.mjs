import fs from 'node:fs';
import { httpFetch } from './httpFetch.mjs';
function loadSf() { try {
    return JSON.parse(fs.readFileSync('./connections.json', 'utf8')).salesforce || {};
}
catch {
    return {};
} }
let cache = null;
/** Authenticate via OAuth 2.0 Client Credentials; cached ~25 min. */
export async function sfAuth(force = false) {
    const c = loadSf();
    if (!c.clientId || !c.clientSecret)
        throw new Error('Salesforce client id/secret not configured in connections.json');
    if (!force && cache && Date.now() - cache.at < 25 * 60 * 1000)
        return cache.auth;
    const host = (c.instanceUrl || c.loginUrl || '').replace(/\/$/, '');
    if (!host)
        throw new Error('Salesforce instanceUrl/loginUrl not configured');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret });
    const r = await httpFetch(`${host}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token)
        throw new Error(`Salesforce auth failed: ${d.error || r.status} ${d.error_description || ''}`);
    const auth = { token: d.access_token, instanceUrl: (d.instance_url || host).replace(/\/$/, ''), apiVersion: (c.apiVersion || '62.0').replace(/^v/, '') };
    cache = { auth, at: Date.now() };
    return auth;
}
/** Run a SOQL query; follows pagination. Re-auths once on 401. */
export async function sfQuery(soql) {
    let a = await sfAuth();
    const run = (auth) => httpFetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/query?q=${encodeURIComponent(soql)}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    let r = await run(a);
    if (r.status === 401) {
        a = await sfAuth(true);
        r = await run(a);
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(`SOQL failed: ${Array.isArray(d) ? JSON.stringify(d) : (d.message || r.status)}`);
    let records = d.records || [];
    let next = d.nextRecordsUrl;
    while (next) {
        const rr = await httpFetch(`${a.instanceUrl}${next}`, { headers: { Authorization: `Bearer ${a.token}` } });
        const dd = await rr.json().catch(() => ({}));
        records = records.concat(dd.records || []);
        next = dd.nextRecordsUrl;
    }
    return records;
}
/** Insert records via Composite sObject Collections (<=200 per call). */
export async function sfInsert(object, records) {
    const out = { ids: [], errors: [] };
    if (!records.length)
        return out;
    let a = await sfAuth();
    for (let i = 0; i < records.length; i += 200) {
        const batch = records.slice(i, i + 200).map(r => ({ attributes: { type: object }, ...r }));
        const body = JSON.stringify({ allOrNone: false, records: batch });
        const doReq = (auth) => httpFetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/composite/sobjects`, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body });
        let r = await doReq(a);
        if (r.status === 401) {
            a = await sfAuth(true);
            r = await doReq(a);
        }
        const results = await r.json().catch(() => ([]));
        for (const rr of (Array.isArray(results) ? results : [])) {
            if (rr.success)
                out.ids.push(rr.id);
            else if (out.errors.length < 20)
                out.errors.push((rr.errors || []).map((e) => `${e.statusCode}: ${e.message}`).join('; '));
        }
    }
    return out;
}
/** Update one record by its Salesforce Id (PATCH). */
export async function sfUpdate(object, id, fields) {
    let a = await sfAuth();
    const doReq = (auth) => httpFetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/sobjects/${object}/${id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    let r = await doReq(a);
    if (r.status === 401) {
        a = await sfAuth(true);
        r = await doReq(a);
    }
    if (!r.ok && r.status !== 204) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`update ${object}/${id} failed: ${JSON.stringify(d).slice(0, 200)}`);
    }
}
/** Upsert records by external id via Composite sObject Collections (<=200 per call). */
export async function sfUpsert(object, externalIdField, records, log) {
    const res = { success: 0, failed: 0, errors: [] };
    if (!records.length)
        return res;
    let a = await sfAuth();
    for (let i = 0; i < records.length; i += 200) {
        const batch = records.slice(i, i + 200).map(r => ({ attributes: { type: object }, ...r }));
        const body = JSON.stringify({ allOrNone: false, records: batch });
        const doReq = (auth) => httpFetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/composite/sobjects/${object}/${externalIdField}`, { method: 'PATCH', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body });
        let r = await doReq(a);
        if (r.status === 401) {
            a = await sfAuth(true);
            r = await doReq(a);
        }
        const results = await r.json().catch(() => ([]));
        if (!r.ok) {
            res.failed += batch.length;
            res.errors.push(`HTTP ${r.status}: ${JSON.stringify(results).slice(0, 200)}`);
            continue;
        }
        for (const rr of (Array.isArray(results) ? results : [])) {
            if (rr.success)
                res.success++;
            else {
                res.failed++;
                if (res.errors.length < 20)
                    res.errors.push((rr.errors || []).map((e) => `${e.statusCode}: ${e.message}`).join('; '));
            }
        }
    }
    log?.(`${object}: upserted ${res.success}, failed ${res.failed}`);
    return res;
}
//# sourceMappingURL=sfClient.mjs.map