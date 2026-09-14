import fs from 'node:fs';
import { loadSyncConfigs, resolveAccount, isDue } from './sfConfig.mjs';
import { SPECS, syncToSalesforce, syncToTally } from './sfAgent.mjs';
import { logToTrigger } from './sfLog.mjs';
/** The distributor's SAP company code is baked into the per-distributor build. */
export function bakedSapCode() {
    var _a, _b;
    try {
        const c = JSON.parse(fs.readFileSync('./connections.json', 'utf8'));
        return ((_a = c.distributor) === null || _a === void 0 ? void 0 : _a.sapCode) || ((_b = c.salesforce) === null || _b === void 0 ? void 0 : _b.sapCode) || '';
    }
    catch {
        return '';
    }
}
/** Run one full cycle: check SF permission/schedule, then Tally->SF and SF->Tally for each
 *  enabled+due object. Safe to call repeatedly (idempotent by GUID / Pending status). */
export async function runCycle(opts) {
    const log = opts.log || (() => { });
    const reports = [];
    const sapCode = bakedSapCode();
    if (!sapCode) {
        log('[runner] no distributor SAP code configured (connections.json.distributor.sapCode)', true);
        return reports;
    }
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
        if (opts.objectType && cfg.objectType !== opts.objectType)
            continue; // schedule one object at a time
        const spec = SPECS[cfg.objectType];
        if (!spec) {
            log(`[runner] no connector spec for ${cfg.objectType} — skipping`, true);
            continue;
        }
        if (!opts.force && !isDue(cfg, Date.now())) {
            log(`[runner] ${cfg.objectType} Tally->SF not due yet (every ${cfg.frequencyMinutes}m)`);
            continue;
        }
        try {
            const r = await syncToSalesforce(spec, cfg, acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
            const ok = r.failed === 0 && r.errors.length === 0; // a Tally-down read reports errors with failed=0
            reports.push({ direction: 'ToSalesforce', objectType: cfg.objectType, ok, detail: `fetched ${r.fetched}, upserted ${r.upserted}, failed ${r.failed}${r.errors.length ? ` — ${r.errors[0]}` : ''}` });
        }
        catch (e) {
            log(`[runner] ${cfg.objectType} Tally->SF errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
            reports.push({ direction: 'ToSalesforce', objectType: cfg.objectType, ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
        }
    }
    // ---- Salesforce -> Tally (write) ----
    const toTally = (opts.direction && opts.direction !== 'ToTally') ? [] : await loadSyncConfigs(sapCode, 'ToTally');
    for (const cfg of toTally) {
        if (opts.objectType && cfg.objectType !== opts.objectType)
            continue; // schedule one object at a time
        const spec = SPECS[cfg.objectType];
        if (!spec) {
            log(`[runner] no connector spec for ${cfg.objectType} — skipping`, true);
            continue;
        }
        if (!opts.force && !isDue(cfg, Date.now())) {
            log(`[runner] ${cfg.objectType} SF->Tally not due yet (every ${cfg.frequencyMinutes}m)`);
            continue;
        }
        try {
            const r = await syncToTally(spec, acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
            reports.push({ direction: 'ToTally', objectType: cfg.objectType, ok: r.failed === 0, detail: `pending ${r.pending}, created ${r.created}, failed ${r.failed}` });
        }
        catch (e) {
            log(`[runner] ${cfg.objectType} SF->Tally errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
            reports.push({ direction: 'ToTally', objectType: cfg.objectType, ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
        }
    }
    log(`[runner] cycle done — ${reports.length} action(s)`);
    return reports;
}
//# sourceMappingURL=syncRunner.mjs.map