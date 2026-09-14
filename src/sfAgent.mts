import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfInsert, sfQuery, sfUpdate } from './sfClient.mjs';
import { postVoucher, type VoucherInput } from './tallyImport.mjs';

// Salesforce -> Tally sync agent (docs/salesforce-agent-plan.md). Reads Pending staging rows
// flagged Direction=ToTally, applies the Salesforce-authored mapping to logical voucher fields,
// assembles a balanced Tally voucher, imports it, and writes status back + a Sync_Log__c.
//
// The Tally -> Salesforce direction was removed intentionally; it will be rebuilt config-driven.

export type LogFn = (msg: string, isError?: boolean) => void;

export interface SyncSpec {
    objectType: string;      // Field_Mapping / Sync picklist value, e.g. 'Purchase'
    stagingObject: string;   // Salesforce staging object, e.g. 'Tally_Purchase__c'
    externalId: string;      // external id field on the staging object, e.g. 'Tally_Guid__c'
}

// Double-entry rule per object type — the accounting lives in code; field mapping stays in Salesforce.
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

/** Built-in specs (later these come from Salesforce config). */
export const SYNC_SPECS: Record<string, SyncSpec> = {
    Invoice: { objectType: 'Invoice', stagingObject: 'Tally_Invoice__c', externalId: 'Tally_Guid__c' },
    Purchase: { objectType: 'Purchase', stagingObject: 'Tally_Purchase__c', externalId: 'Tally_Guid__c' },
};
