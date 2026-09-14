import fs from 'node:fs';
import { loadSyncConfigs, resolveAccount, isDue, type Direction } from './sfConfig.mjs';
import { SPECS, syncToSalesforce, syncToTally, type LogFn } from './sfAgent.mjs';
import { logToTrigger } from './sfLog.mjs';

// The runner is the connector's control loop. Every cycle it asks Salesforce what it is
// allowed to do (Sync_Config__c for THIS distributor, by SAP company code) and acts ONLY on
// the directions SF has enabled and that are due per their schedule. Nothing is hard-coded on
// or off in the connector — an admin flips a row in SF and the next cycle honours it.

export interface RunnerOptions { server: string; port: number; dryRun?: boolean; force?: boolean; objectType?: string; direction?: Direction; log?: LogFn; }

/** The distributor's SAP company code is baked into the per-distributor build. */
export function bakedSapCode(): string {
    try {
        const c = JSON.parse(fs.readFileSync('./connections.json', 'utf8'));
        return c.distributor?.sapCode || c.salesforce?.sapCode || '';
    } catch { return ''; }
}

export interface CycleReport { direction: string; objectType: string; ok: boolean; detail: string }

/** Run one full cycle: check SF permission/schedule, then Tally->SF and SF->Tally for each
 *  enabled+due object. Safe to call repeatedly (idempotent by GUID / Pending status). */
export async function runCycle(opts: RunnerOptions): Promise<CycleReport[]> {
    const log = opts.log || (() => { });
    const reports: CycleReport[] = [];
    const sapCode = bakedSapCode();
    if (!sapCode) { log('[runner] no distributor SAP code configured (connections.json.distributor.sapCode)', true); return reports; }

    const acct = await resolveAccount(sapCode);
    if (!acct) {
        log(`[runner] no Account in Salesforce with SAP_Company_Code__c = ${sapCode} — cannot sync`, true);
        await logToTrigger({ operation: 'Cycle', status: 'Error', errorMessage: `No Account for SAP code ${sapCode}` });
        return reports;
    }
    log(`[runner] distributor ${acct.name} (${sapCode}) — cycle start${opts.dryRun ? ' (dry-run)' : ''}`);

    // ---- Tally -> Salesforce (read) ----
    const toSf = (opts.direction && opts.direction !== 'ToSalesforce') ? [] : await loadSyncConfigs(sapCode, 'ToSalesforce');
    for (const cfg of toSf) {
        if (opts.objectType && cfg.objectType !== opts.objectType) continue; // schedule one object at a time
        const spec = SPECS[cfg.objectType];
        if (!spec) { log(`[runner] no connector spec for ${cfg.objectType} — skipping`, true); continue; }
        if (!opts.force && !isDue(cfg, Date.now())) { log(`[runner] ${cfg.objectType} Tally->SF not due yet (every ${cfg.frequencyMinutes}m)`); continue; }
        try {
            const r = await syncToSalesforce(spec, cfg, acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
            const ok = r.failed === 0 && r.errors.length === 0; // a Tally-down read reports errors with failed=0
            reports.push({ direction: 'ToSalesforce', objectType: cfg.objectType, ok, detail: `fetched ${r.fetched}, upserted ${r.upserted}, failed ${r.failed}${r.errors.length ? ` — ${r.errors[0]}` : ''}` });
        } catch (e: any) {
            log(`[runner] ${cfg.objectType} Tally->SF errored: ${e?.message || e}`, true);
            reports.push({ direction: 'ToSalesforce', objectType: cfg.objectType, ok: false, detail: String(e?.message || e) });
        }
    }

    // ---- Salesforce -> Tally (write) ----
    const toTally = (opts.direction && opts.direction !== 'ToTally') ? [] : await loadSyncConfigs(sapCode, 'ToTally');
    for (const cfg of toTally) {
        if (opts.objectType && cfg.objectType !== opts.objectType) continue; // schedule one object at a time
        const spec = SPECS[cfg.objectType];
        if (!spec) { log(`[runner] no connector spec for ${cfg.objectType} — skipping`, true); continue; }
        if (!opts.force && !isDue(cfg, Date.now())) { log(`[runner] ${cfg.objectType} SF->Tally not due yet (every ${cfg.frequencyMinutes}m)`); continue; }
        try {
            const r = await syncToTally(spec, acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
            reports.push({ direction: 'ToTally', objectType: cfg.objectType, ok: r.failed === 0, detail: `pending ${r.pending}, created ${r.created}, failed ${r.failed}` });
        } catch (e: any) {
            log(`[runner] ${cfg.objectType} SF->Tally errored: ${e?.message || e}`, true);
            reports.push({ direction: 'ToTally', objectType: cfg.objectType, ok: false, detail: String(e?.message || e) });
        }
    }

    log(`[runner] cycle done — ${reports.length} action(s)`);
    return reports;
}
