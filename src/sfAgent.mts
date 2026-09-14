import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfQuery, sfUpdate, sfUpsert } from './sfClient.mjs';
import { postVoucher, type VoucherInput } from './tallyImport.mjs';
import { fetchFilteredCollection, describeError } from './tallyLive.mjs';
import { logToTrigger } from './sfLog.mjs';
import { saveWatermark, stampRun, type SyncConfig, type DistributorRef } from './sfConfig.mjs';

// Two-way Salesforce <-> Tally sync agent. Salesforce is the control plane: which objects,
// which direction, on what schedule, and the field mapping all live in SF (Sync_Config__c +
// Field_Mapping__c). The connector only acts on directions SF has enabled, and logs every
// run to Morde's shared Trigger_Log__c (docs/integration-build-notes.md).
//
//   Tally -> SF (read):  incremental voucher read by $AlterID watermark -> apply SF map ->
//                        upsert staging by Tally_Guid__c -> advance watermark.
//   SF -> Tally (write): Pending staging rows -> apply SF map -> assemble balanced voucher ->
//                        import into Tally -> write status back.

export type LogFn = (msg: string, isError?: boolean) => void;

// ---- Connector-fixed specs (the Tally side is fixed in the connector; SF controls the rest) ----
export interface ObjectSpec {
    objectType: string;      // matches Sync_Config__c / Field_Mapping__c Object_Type__c
    stagingObject: string;   // Salesforce staging object
    externalId: string;      // external id field on the staging object (idempotency key)
    voucherType: string;     // Tally voucher type name
}
export const SPECS: Record<string, ObjectSpec> = {
    Invoice: { objectType: 'Invoice', stagingObject: 'Tally_Invoice__c', externalId: 'Tally_Guid__c', voucherType: 'Sales' },
    Purchase: { objectType: 'Purchase', stagingObject: 'Tally_Purchase__c', externalId: 'Tally_Guid__c', voucherType: 'Purchase' },
};

// ============================ Tally -> Salesforce (read) ============================

export interface ToSfResult { fetched: number; upserted: number; failed: number; newWatermark: number; errors: string[] }

/** Fields the connector always reads regardless of mapping (idempotency + watermark + traceability). */
const SYSTEM_FETCH = ['GUID', 'ALTERID', 'VOUCHERNUMBER', 'DATE'];

/**
 * One incremental Tally->SF pass for a single object type. Reads only vouchers of the
 * spec's voucher type whose $AlterID is past the config watermark (so re-runs are cheap and
 * resumable), maps them with the SF-authored mapping, upserts staging by GUID, and advances
 * the watermark. A bounded field list is used (never FETCH * over the whole collection).
 */
export async function syncToSalesforce(
    spec: ObjectSpec, config: SyncConfig, dist: DistributorRef, server: string, port: number,
    opts: { dryRun?: boolean; log?: LogFn } = {},
): Promise<ToSfResult> {
    const log = opts.log || (() => { });
    const startedAt = new Date();
    const res: ToSfResult = { fetched: 0, upserted: 0, failed: 0, newWatermark: config.lastAlterId, errors: [] };
    log(`[agent] ${spec.objectType} Tally->SF: starting (watermark AlterID>${config.lastAlterId})${opts.dryRun ? ' (dry-run)' : ''}`);

    // Tally row keys are lowercased by parseCollection, so match ToSalesforce source (a Tally
    // field name) case-insensitively; the SF-side target stays exactly as authored.
    const maps = (await loadMappings(spec.objectType, 'ToSalesforce')).map(m => ({ ...m, source: m.source?.toLowerCase() }));
    if (!maps.length) {
        log(`[agent] no active ToSalesforce mappings for ${spec.objectType} — nothing to do`, true);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', errorMessage: 'no active mappings', startedAt });
        return res;
    }
    const fetchList = [...new Set([...SYSTEM_FETCH, ...maps.filter(m => m.source).map(m => m.source!.toUpperCase())])].join(',');
    // Incremental + type-scoped filter. Operators/quotes MUST be XML-escaped (see alterIdRangeFilter).
    const filter = `$VoucherTypeName = ${qstr(spec.voucherType)} AND $AlterID &gt; ${config.lastAlterId}`;

    let rows: Record<string, string>[];
    try {
        rows = (await fetchFilteredCollection(server, port, 'Voucher', fetchList, filter)).rows;
    } catch (e: any) {
        // Tally unavailable — resilience: leave watermark untouched, log, retry next cycle.
        const msg = describeError(e);
        log(`[agent] ${spec.objectType}: Tally read failed — ${msg}`, true);
        res.errors.push(msg);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Error', errorMessage: `Tally unavailable: ${msg}`, retryCount: 0, startedAt });
        return res;
    }

    const clean = rows.filter(r => Object.keys(r).length && r.guid);
    res.fetched = clean.length;
    log(`[agent] ${spec.objectType}: ${clean.length} new/changed vouchers`);
    if (!clean.length) {
        if (!opts.dryRun) await stampRun(config.id).catch(() => { });
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Success', responseBody: '0 vouchers', startedAt });
        return res;
    }

    const records = clean.map(row => {
        const mapped = applyMapping(row, maps);
        const alterId = parseInt(row.alterid || '0', 10) || 0;
        if (alterId > res.newWatermark) res.newWatermark = alterId;
        return {
            ...mapped,
            [spec.externalId]: row.guid,
            Tally_AlterId__c: alterId,
            Tally_Voucher_Number__c: row.vouchernumber || mapped.Tally_Voucher_Number__c || '',
            Distributor__c: dist.id,
            Direction__c: 'ToSalesforce',
            Sync_Status__c: 'Done',
            Error__c: '',
        };
    });

    if (opts.dryRun) {
        log(`[agent] ${spec.objectType}: dry-run — would upsert ${records.length} rows (watermark -> ${res.newWatermark})`);
        log(`  sample: ${JSON.stringify(records[0]).slice(0, 500)}`);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', responseBody: `dry-run ${records.length} rows`, startedAt });
        return res;
    }

    const up = await sfUpsert(spec.stagingObject, spec.externalId, records, (m, e) => log('  ' + m, e));
    res.upserted = up.success; res.failed = up.failed; res.errors.push(...up.errors);

    // Only advance the watermark when everything upserted — otherwise re-read the failures next cycle.
    if (up.failed === 0) { await saveWatermark(config.id, res.newWatermark).catch(() => { }); }
    else { await stampRun(config.id).catch(() => { }); }

    await logToTrigger({
        operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject,
        status: up.failed ? (up.success ? 'Partial' : 'Error') : 'Success',
        errorMessage: up.errors.slice(0, 10).join('\n') || undefined,
        responseBody: `fetched ${res.fetched}, upserted ${up.success}, failed ${up.failed}, watermark -> ${res.newWatermark}`,
        startedAt,
    });
    log(`[agent] ${spec.objectType} Tally->SF: done — upserted ${up.success}, failed ${up.failed}`);
    return res;
}

// ============================ Salesforce -> Tally (write) ============================

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
export async function syncToTally(spec: ObjectSpec, server: string, port: number, opts: { dryRun?: boolean; log?: LogFn } = {}): Promise<ToTallyResult> {
    const log = opts.log || (() => { });
    const startedAt = new Date();
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

    await logToTrigger({
        operation: `SF->Tally ${spec.objectType}`, objectName: spec.stagingObject,
        status: res.failed ? (res.created ? 'Partial' : 'Error') : 'Success',
        errorMessage: res.errors.slice(0, 10).join('\n') || undefined,
        responseBody: `pending ${res.pending}, created ${res.created}, failed ${res.failed}`,
        startedAt,
    });
    log(`[agent] ${spec.objectType} SF->Tally: done — created ${res.created}, failed ${res.failed}`);
    return res;
}

/** Quote + XML-escape a string for a Tally FILTER formula. */
function qstr(s: string): string { return '&quot;' + s.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '&quot;'; }
