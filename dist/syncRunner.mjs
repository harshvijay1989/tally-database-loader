import fs from 'node:fs';
import { loadSyncConfigs, resolveAccount, isDue, saveWatermark } from './sfConfig.mjs';
import { SPECS, syncToSalesforce, syncToTally } from './sfAgent.mjs';
import { syncAccountsToTally, syncAccountsToSalesforce, syncProductsToTally, syncGodownsToTally, syncGodownsToSalesforce } from './sfMaster.mjs';
import { logToTrigger } from './sfLog.mjs';
/** Masters (Account, Godown, then Product) run before transactions. Stable priority sort key. */
function masterFirst(objectType) { return objectType === 'Account' ? 0 : objectType === 'Godown' ? 1 : objectType === 'Product' ? 2 : 3; }
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
    const toSf = ((opts.direction && opts.direction !== 'ToSalesforce') ? [] : await loadSyncConfigs(sapCode, 'ToSalesforce'))
        .sort((a, b) => masterFirst(a.objectType) - masterFirst(b.objectType)); // masters before transactions (stable)
    for (const cfg of toSf) {
        if (opts.objectType && cfg.objectType !== opts.objectType)
            continue; // schedule one object at a time
        if (!opts.force && !isDue(cfg, Date.now())) {
            log(`[runner] ${cfg.objectType} Tally->SF not due yet (every ${cfg.frequencyMinutes}m)`);
            continue;
        }
        // Master object types have no SPEC — handle them directly, then continue.
        if (cfg.objectType === 'Account') {
            try {
                const r = await syncAccountsToSalesforce(acct, opts.server, opts.port, { sinceAlterId: cfg.lastAlterId, dryRun: opts.dryRun, log });
                const ok = r.failed === 0 && r.errors.length === 0;
                // Advance the watermark on PROGRESS (pulled > 0), not only on a fully-clean run:
                // legacy stateless ledgers always fail the Require_Billing_State rule, so gating on
                // r.failed===0 would pin the watermark at 0 and re-pull + re-fail them every cycle.
                // pulled>0 means the Tally read succeeded and ≥1 account upserted, so advancing is
                // safe; a fixed ledger's AlterID bumps above the watermark and is re-pulled anyway.
                // A transient TOTAL failure leaves pulled===0, so the watermark holds and retries.
                if (!opts.dryRun && r.pulled > 0)
                    await saveWatermark(cfg.id, r.newWatermark).catch(() => { });
                reports.push({ direction: 'ToSalesforce', objectType: 'Account', ok, detail: `scanned ${r.scanned}, pulled ${r.pulled}, failed ${r.failed}${r.errors[0] ? ` — ${r.errors[0]}` : ''}` });
            }
            catch (e) {
                log(`[runner] Account Tally->SF errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
                reports.push({ direction: 'ToSalesforce', objectType: 'Account', ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
            }
            continue;
        }
        if (cfg.objectType === 'Product') {
            log('[runner] Product Tally->SF not supported (no product inbound) — skipping');
            reports.push({ direction: 'ToSalesforce', objectType: 'Product', ok: true, detail: 'skipped — no Tally->SF product sync' });
            continue;
        }
        if (cfg.objectType === 'Godown') {
            try {
                const r = await syncGodownsToSalesforce(acct, opts.server, opts.port, { sinceAlterId: cfg.lastAlterId, dryRun: opts.dryRun, log });
                if (!opts.dryRun && r.pulled > 0)
                    await saveWatermark(cfg.id, r.newWatermark).catch(() => { }); // progress-gated, like Account
                reports.push({ direction: 'ToSalesforce', objectType: 'Godown', ok: r.failed === 0, detail: `scanned ${r.scanned}, pulled ${r.pulled}, failed ${r.failed}` });
            }
            catch (e) {
                log(`[runner] Godown Tally->SF errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
                reports.push({ direction: 'ToSalesforce', objectType: 'Godown', ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
            }
            continue;
        }
        const spec = SPECS[cfg.objectType];
        if (!spec) {
            log(`[runner] no connector spec for ${cfg.objectType} — skipping`, true);
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
    const toTally = ((opts.direction && opts.direction !== 'ToTally') ? [] : await loadSyncConfigs(sapCode, 'ToTally'))
        .sort((a, b) => masterFirst(a.objectType) - masterFirst(b.objectType)); // masters before transactions (stable)
    for (const cfg of toTally) {
        if (opts.objectType && cfg.objectType !== opts.objectType)
            continue; // schedule one object at a time
        if (!opts.force && !isDue(cfg, Date.now())) {
            log(`[runner] ${cfg.objectType} SF->Tally not due yet (every ${cfg.frequencyMinutes}m)`);
            continue;
        }
        // Master object types have no SPEC — handle them directly, then continue.
        if (cfg.objectType === 'Account') {
            try {
                const r = await syncAccountsToTally(acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
                reports.push({ direction: 'ToTally', objectType: 'Account', ok: r.failed === 0, detail: `scanned ${r.scanned}, pushed ${r.pushed}, failed ${r.failed}` });
            }
            catch (e) {
                log(`[runner] Account SF->Tally errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
                reports.push({ direction: 'ToTally', objectType: 'Account', ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
            }
            continue;
        }
        if (cfg.objectType === 'Product') {
            try {
                const r = await syncProductsToTally(acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
                reports.push({ direction: 'ToTally', objectType: 'Product', ok: r.failed === 0, detail: `scanned ${r.scanned}, pushed ${r.pushed}, failed ${r.failed}` });
            }
            catch (e) {
                log(`[runner] Product SF->Tally errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
                reports.push({ direction: 'ToTally', objectType: 'Product', ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
            }
            continue;
        }
        if (cfg.objectType === 'Godown') {
            try {
                const r = await syncGodownsToTally(acct, opts.server, opts.port, { dryRun: opts.dryRun, log });
                reports.push({ direction: 'ToTally', objectType: 'Godown', ok: r.failed === 0, detail: `scanned ${r.scanned}, pushed ${r.pushed}, failed ${r.failed}` });
            }
            catch (e) {
                log(`[runner] Godown SF->Tally errored: ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
                reports.push({ direction: 'ToTally', objectType: 'Godown', ok: false, detail: String((e === null || e === void 0 ? void 0 : e.message) || e) });
            }
            continue;
        }
        const spec = SPECS[cfg.objectType];
        if (!spec) {
            log(`[runner] no connector spec for ${cfg.objectType} — skipping`, true);
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