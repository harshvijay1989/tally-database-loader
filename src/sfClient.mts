import fs from 'node:fs';
import { httpFetch } from './httpFetch.mjs';

// Reusable Salesforce API client for the two-way agent (docs/salesforce-agent-plan.md).
// Client-credentials auth + SOQL query + Composite upsert-by-external-id. Uses httpFetch
// (Node-14 safe) and reads credentials from connections.json (git-ignored).

interface SfConn { instanceUrl?: string; loginUrl?: string; clientId?: string; clientSecret?: string; apiVersion?: string; }
function loadSf(): SfConn { try { return JSON.parse(fs.readFileSync('./connections.json', 'utf8')).salesforce || {}; } catch { return {}; } }

export interface SfAuth { token: string; instanceUrl: string; apiVersion: string; }
let cache: { auth: SfAuth; at: number } | null = null;

/** Authenticate via OAuth 2.0 Client Credentials; cached ~25 min. */
export async function sfAuth(force = false): Promise<SfAuth> {
    const c = loadSf();
    if (!c.clientId || !c.clientSecret) throw new Error('Salesforce client id/secret not configured in connections.json');
    if (!force && cache && Date.now() - cache.at < 25 * 60 * 1000) return cache.auth;
    const host = (c.instanceUrl || c.loginUrl || '').replace(/\/$/, '');
    if (!host) throw new Error('Salesforce instanceUrl/loginUrl not configured');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret });
    const r = await httpFetch(`${host}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw new Error(`Salesforce auth failed: ${d.error || r.status} ${d.error_description || ''}`);
    const auth: SfAuth = { token: d.access_token, instanceUrl: (d.instance_url || host).replace(/\/$/, ''), apiVersion: (c.apiVersion || '62.0').replace(/^v/, '') };
    cache = { auth, at: Date.now() };
    return auth;
}

/** Run a SOQL query; follows pagination. Re-auths once on 401. */
export async function sfQuery(soql: string): Promise<any[]> {
    let a = await sfAuth();
    const run = (auth: SfAuth) => httpFetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/query?q=${encodeURIComponent(soql)}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    let r = await run(a);
    if (r.status === 401) { a = await sfAuth(true); r = await run(a); }
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`SOQL failed: ${Array.isArray(d) ? JSON.stringify(d) : (d.message || r.status)}`);
    let records: any[] = d.records || [];
    let next: string | undefined = d.nextRecordsUrl;
    while (next) {
        const rr = await httpFetch(`${a.instanceUrl}${next}`, { headers: { Authorization: `Bearer ${a.token}` } });
        const dd: any = await rr.json().catch(() => ({}));
        records = records.concat(dd.records || []);
        next = dd.nextRecordsUrl;
    }
    return records;
}

export interface UpsertResult { success: number; failed: number; errors: string[] }

/** Upsert records by external id via Composite sObject Collections (<=200 per call). */
export async function sfUpsert(object: string, externalIdField: string, records: any[], log?: (m: string, e?: boolean) => void): Promise<UpsertResult> {
    const res: UpsertResult = { success: 0, failed: 0, errors: [] };
    if (!records.length) return res;
    let a = await sfAuth();
    for (let i = 0; i < records.length; i += 200) {
        const batch = records.slice(i, i + 200).map(r => ({ attributes: { type: object }, ...r }));
        const body = JSON.stringify({ allOrNone: false, records: batch });
        const doReq = (auth: SfAuth) => httpFetch(`${auth.instanceUrl}/services/data/v${auth.apiVersion}/composite/sobjects/${object}/${externalIdField}`,
            { method: 'PATCH', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body });
        let r = await doReq(a);
        if (r.status === 401) { a = await sfAuth(true); r = await doReq(a); }
        const results: any = await r.json().catch(() => ([]));
        if (!r.ok) { res.failed += batch.length; res.errors.push(`HTTP ${r.status}: ${JSON.stringify(results).slice(0, 200)}`); continue; }
        for (const rr of (Array.isArray(results) ? results : [])) {
            if (rr.success) res.success++;
            else { res.failed++; if (res.errors.length < 20) res.errors.push((rr.errors || []).map((e: any) => `${e.statusCode}: ${e.message}`).join('; ')); }
        }
    }
    log?.(`${object}: upserted ${res.success}, failed ${res.failed}`);
    return res;
}
