import * as tallyLive from './tallyLive.mjs';
import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfUpsert, sfInsert, sfQuery, sfUpdate } from './sfClient.mjs';
import { postVoucher, type VoucherInput } from './tallyImport.mjs';

// The two-way sync agent (docs/salesforce-agent-plan.md). This file wires the pieces:
// read from Tally -> apply the Salesforce-authored mapping -> upsert into the staging
// object -> record a Sync_Log__c. Direction A (Tally -> Salesforce) first.

export type LogFn = (msg: string, isError?: boolean) => void;

export interface SyncSpec {
    objectType: string;      // Field_Mapping__c / Sync picklist value, e.g. 'Invoice'
    stagingObject: string;   // Salesforce object, e.g. 'Tally_Invoice__c'
    externalId: string;      // external id field on the staging object, e.g. 'Tally_Guid__c'
    tallyType: string;       // Tally collection to read, e.g. 'voucher'
    filterField?: string;    // optional Tally field to filter on, e.g. 'vouchertypename'
    filterValue?: string;    // ...equals this (case-insensitive), e.g. 'Sales'
    windowSize?: number;
}

export interface SyncResult { source: number; mapped: number; success: number; failed: number; errors: string[] }

/** One Tally -> Salesforce run for a single object type. */
export async function syncToSalesforce(spec: SyncSpec, server: string, port: number, log: LogFn = () => { }): Promise<SyncResult> {
    log(`[agent] ${spec.objectType} Tally->SF: starting`);
    const maps = await loadMappings(spec.objectType, 'ToSalesforce');
    if (!maps.length) { log(`[agent] no active ToSalesforce mappings for ${spec.objectType} — nothing to do`, true); return { source: 0, mapped: 0, success: 0, failed: 0, errors: ['no mappings'] }; }
    log(`[agent] ${spec.objectType}: ${maps.length} mappings loaded from Salesforce`);

    // read from Tally (safe windowed FETCH *; never bare)
    const r = await tallyLive.fetchAllWindowed(server, port, spec.tallyType, { windowSize: spec.windowSize || 500, log: (m, e) => log('  ' + m, e) });
    let rows = r.rows;
    if (spec.filterField) {
        const want = String(spec.filterValue || '').toLowerCase();
        rows = rows.filter(v => String(v[spec.filterField!] || '').toLowerCase() === want);
        log(`[agent] ${spec.objectType}: filtered ${spec.filterField}='${spec.filterValue}' -> ${rows.length} of ${r.rows.length}`);
    }

    // apply the SF-authored mapping; keep only rows that produced the external id
    const mapped = rows.map(v => applyMapping(v, maps)).filter(x => x[spec.externalId] != null && x[spec.externalId] !== '');
    log(`[agent] ${spec.objectType}: ${rows.length} source rows -> ${mapped.length} mapped`);

    const up = await sfUpsert(spec.stagingObject, spec.externalId, mapped, (m, e) => log('  ' + m, e));
    const res: SyncResult = { source: rows.length, mapped: mapped.length, success: up.success, failed: up.failed, errors: up.errors };

    // record the run for monitoring/debug in Salesforce
    try {
        await sfInsert('Sync_Log__c', [{
            Object_Type__c: spec.objectType, Direction__c: 'ToSalesforce',
            Status__c: up.failed ? (up.success ? 'Partial' : 'Error') : 'Success',
            Records_Processed__c: up.success, Records_Failed__c: up.failed,
            Message__c: up.errors.slice(0, 10).join('\n').slice(0, 30000), Run_At__c: new Date().toISOString(),
        }]);
    } catch (e: any) { log(`[agent] could not write Sync_Log__c - ${e?.message || e}`, true); }

    log(`[agent] ${spec.objectType} Tally->SF: done — upserted ${up.success}, failed ${up.failed}`);
    return res;
}

/** Built-in specs for the vertical slice (later these come from Sync_Config__c). */
export const SYNC_SPECS: Record<string, SyncSpec> = {
    Invoice: { objectType: 'Invoice', stagingObject: 'Tally_Invoice__c', externalId: 'Tally_Guid__c', tallyType: 'voucher', filterField: 'vouchertypename', filterValue: 'Sales' },
};

// --- Direction B: Salesforce -> Tally (voucher write-back) -------------------
// The ToTally mapping maps staging fields to LOGICAL voucher fields (date, party,
// amount, number, narration, voucherType, counterLedger). assembleVoucher turns those
// into a balanced double-entry per voucher-type rule; the double-entry accounting lives
// in code, the field mapping stays in Salesforce.
interface ToTallyRule { voucherType: string; counterLedgerDefault: string; partySign: 1 | -1; }
const TO_TALLY_RULES: Record<string, ToTallyRule> = {
    Invoice: { voucherType: 'Sales', counterLedgerDefault: 'Sales', partySign: -1 },      // customer debit(-), sales credit(+)
    Purchase: { voucherType: 'Purchase', counterLedgerDefault: 'Purchase', partySign: 1 }, // supplier credit(+), purchase debit(-)
};

/** Build a balanced VoucherInput from mapped logical fields, or return an error string. */
export function assembleVoucher(objectType: string, logical: Record<string, any>): VoucherInput | string {
    const rule = TO_TALLY_RULES[objectType];
    if (!rule) return `no ToTally rule for ${objectType}`;
    if (!logical.party) return 'missing party';
    const amount = parseFloat(String(logical.amount).replace(/,/g, ''));
    if (isNaN(amount) || amount === 0) return 'missing/zero amount';
    if (!/^\d{8}$/.test(String(logical.date || ''))) return `bad date '${logical.date}' (need YYYYMMDD)`;
    const party = String(logical.party);
    const counter = String(logical.counterLedger || rule.counterLedgerDefault);
    const partyAmt = rule.partySign * Math.abs(amount);
    return {
        date: String(logical.date), voucherType: String(logical.voucherType || rule.voucherType), partyLedger: party,
        voucherNumber: logical.number ? String(logical.number) : undefined,
        narration: logical.narration ? String(logical.narration) : undefined,
        entries: [{ ledger: party, amount: partyAmt }, { ledger: counter, amount: -partyAmt }],
    };
}

export interface ToTallyResult { pending: number; created: number; failed: number; errors: string[] }

/** One Salesforce -> Tally run for a single object type: create Tally vouchers from
 *  Pending staging rows flagged Direction=ToTally, then write status back. */
export async function syncToTally(spec: SyncSpec, server: string, port: number, opts: { dryRun?: boolean; log?: LogFn } = {}): Promise<ToTallyResult> {
    const log = opts.log || (() => { });
    log(`[agent] ${spec.objectType} SF->Tally: starting${opts.dryRun ? ' (dry-run)' : ''}`);
    const maps = await loadMappings(spec.objectType, 'ToTally');
    if (!maps.length) { log(`[agent] no active ToTally mappings for ${spec.objectType} — nothing to do`, true); return { pending: 0, created: 0, failed: 0, errors: ['no mappings'] }; }
    const sourceFields = [...new Set(maps.filter(m => m.source).map(m => m.source!))];
    const soql = `SELECT Id, ${sourceFields.join(', ')} FROM ${spec.stagingObject} WHERE Direction__c = 'ToTally' AND Sync_Status__c = 'Pending'`;
    const rows = await sfQuery(soql);
    log(`[agent] ${spec.objectType}: ${rows.length} pending staging rows`);
    const res: ToTallyResult = { pending: rows.length, created: 0, failed: 0, errors: [] };

    for (const row of rows) {
        const logical = applyMapping(row, maps);
        const built = assembleVoucher(spec.objectType, logical);
        if (typeof built === 'string') {
            res.failed++; res.errors.push(`${row.Id}: ${built}`);
            if (!opts.dryRun) await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: built }).catch(() => { });
            log(`  ${row.Id}: invalid - ${built}`, true);
            continue;
        }
        const pr = await postVoucher(server, port, built, { dryRun: opts.dryRun, log: (m, e) => log('  ' + m, e) });
        if (pr.ok) {
            res.created++;
            if (!opts.dryRun) await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Done', Error__c: '', Tally_Voucher_Number__c: built.voucherNumber || '' }).catch(() => { });
        } else {
            res.failed++; res.errors.push(`${row.Id}: ${pr.message}`);
            if (!opts.dryRun) await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: pr.message.slice(0, 32000) }).catch(() => { });
        }
    }

    try {
        await sfInsert('Sync_Log__c', [{
            Object_Type__c: spec.objectType, Direction__c: 'ToTally',
            Status__c: res.failed ? (res.created ? 'Partial' : 'Error') : 'Success',
            Records_Processed__c: res.created, Records_Failed__c: res.failed,
            Message__c: res.errors.slice(0, 10).join('\n').slice(0, 30000), Run_At__c: new Date().toISOString(),
        }]);
    } catch (e: any) { log(`[agent] could not write Sync_Log__c - ${e?.message || e}`, true); }

    log(`[agent] ${spec.objectType} SF->Tally: done — created ${res.created}, failed ${res.failed}`);
    return res;
}
