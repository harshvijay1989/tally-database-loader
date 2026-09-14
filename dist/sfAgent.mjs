import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfQuery, sfUpdate, sfUpsert } from './sfClient.mjs';
import { postVoucher } from './tallyImport.mjs';
import { fetchFilteredCollection, describeError } from './tallyLive.mjs';
import { logToTrigger } from './sfLog.mjs';
import { saveWatermark, stampRun } from './sfConfig.mjs';
export const SPECS = {
    Invoice: { objectType: 'Invoice', stagingObject: 'Tally_Invoice__c', externalId: 'Tally_Guid__c', voucherTypes: ['Sales'] },
    Purchase: { objectType: 'Purchase', stagingObject: 'Tally_Purchase__c', externalId: 'Tally_Guid__c', voucherTypes: ['Purchase'] },
    Order: { objectType: 'Order', stagingObject: 'Tally_Order__c', externalId: 'Tally_Guid__c', voucherTypes: ['Sales Order', 'Purchase Order'] },
    Note: { objectType: 'Note', stagingObject: 'Tally_Note__c', externalId: 'Tally_Guid__c', voucherTypes: ['Credit Note', 'Debit Note'], noteType: true },
};
/** Fields the connector always reads regardless of mapping (idempotency + watermark + traceability). */
const SYSTEM_FETCH = ['GUID', 'ALTERID', 'VOUCHERNUMBER', 'DATE', 'VOUCHERTYPENAME'];
/**
 * One incremental Tally->SF pass for a single object type. Reads only vouchers of the
 * spec's voucher type whose $AlterID is past the config watermark (so re-runs are cheap and
 * resumable), maps them with the SF-authored mapping, upserts staging by GUID, and advances
 * the watermark. A bounded field list is used (never FETCH * over the whole collection).
 */
export async function syncToSalesforce(spec, config, acct, server, port, opts = {}) {
    const log = opts.log || (() => { });
    const startedAt = new Date();
    const res = { fetched: 0, upserted: 0, failed: 0, newWatermark: config.lastAlterId, errors: [] };
    log(`[agent] ${spec.objectType} Tally->SF: starting (watermark AlterID>${config.lastAlterId})${opts.dryRun ? ' (dry-run)' : ''}`);
    // Tally row keys are lowercased by parseCollection, so match ToSalesforce source (a Tally
    // field name) case-insensitively; the SF-side target stays exactly as authored.
    const maps = (await loadMappings(spec.objectType, 'ToSalesforce', acct.sapCode)).map(m => ({ ...m, source: m.source?.toLowerCase() }));
    if (!maps.length) {
        log(`[agent] no active ToSalesforce mappings for ${spec.objectType} — nothing to do`, true);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', errorMessage: 'no active mappings', startedAt });
        return res;
    }
    const fetchList = [...new Set([...SYSTEM_FETCH, ...maps.filter(m => m.source).map(m => m.source.toUpperCase())])].join(',');
    // Incremental + type-scoped filter. Operators/quotes MUST be XML-escaped (see alterIdRangeFilter).
    const typeFilter = spec.voucherTypes.map(vt => `$VoucherTypeName = ${qstr(vt)}`).join(' OR ');
    const filter = `(${typeFilter}) AND $AlterID &gt; ${config.lastAlterId}`;
    let rows;
    try {
        rows = (await fetchFilteredCollection(server, port, 'Voucher', fetchList, filter)).rows;
    }
    catch (e) {
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
        if (!opts.dryRun)
            await stampRun(config.id).catch(() => { });
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Success', responseBody: '0 vouchers', startedAt });
        return res;
    }
    const records = clean.map(row => {
        const mapped = applyMapping(row, maps);
        const alterId = parseInt(row.alterid || '0', 10) || 0;
        if (alterId > res.newWatermark)
            res.newWatermark = alterId;
        const rec = {
            ...mapped,
            [spec.externalId]: row.guid,
            Tally_AlterId__c: alterId,
            Tally_Voucher_Number__c: row.vouchernumber || mapped.Tally_Voucher_Number__c || '',
            SAP_Company_Code__c: acct.sapCode,
            Direction__c: 'ToSalesforce',
            Sync_Status__c: 'Done',
            Error__c: '',
            Raw_Payload__c: JSON.stringify(row).slice(0, 131072), // full-fidelity capture; nothing lost
        };
        // Note object: one staging object holds both Credit and Debit notes; stamp which.
        if (spec.noteType) {
            const vt = String(row.vouchertypename || '').toLowerCase();
            rec.Note_Type__c = vt.includes('debit') ? 'Debit' : vt.includes('credit') ? 'Credit' : undefined;
        }
        return rec;
    });
    if (opts.dryRun) {
        log(`[agent] ${spec.objectType}: dry-run — would upsert ${records.length} rows (watermark -> ${res.newWatermark})`);
        log(`  sample: ${JSON.stringify(records[0]).slice(0, 500)}`);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', responseBody: `dry-run ${records.length} rows`, startedAt });
        return res;
    }
    const up = await sfUpsert(spec.stagingObject, spec.externalId, records, (m, e) => log('  ' + m, e));
    res.upserted = up.success;
    res.failed = up.failed;
    res.errors.push(...up.errors);
    // Only advance the watermark when everything upserted — otherwise re-read the failures next cycle.
    if (up.failed === 0) {
        await saveWatermark(config.id, res.newWatermark).catch(() => { });
    }
    else {
        await stampRun(config.id).catch(() => { });
    }
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
const TO_TALLY_RULES = {
    Invoice: { voucherType: 'Sales', counterLedgerDefault: 'Sales', partySign: -1 }, // customer debit(-), sales credit(+)
    Purchase: { voucherType: 'Purchase', counterLedgerDefault: 'Purchase', partySign: 1 }, // supplier credit(+), purchase debit(-)
};
/** Build a balanced VoucherInput from mapped logical fields, or return an error string. */
export function assembleVoucher(objectType, logical) {
    const rule = TO_TALLY_RULES[objectType];
    if (!rule)
        return `no ToTally rule for ${objectType}`;
    if (!logical.party)
        return 'missing party';
    const amount = parseFloat(String(logical.amount).replace(/,/g, ''));
    if (isNaN(amount) || amount === 0)
        return 'missing/zero amount';
    if (!/^\d{8}$/.test(String(logical.date || '')))
        return `bad date '${logical.date}' (need YYYYMMDD)`;
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
/** One Salesforce -> Tally run for a single object type: create Tally vouchers from
 *  Pending staging rows flagged Direction=ToTally, then write status back. */
export async function syncToTally(spec, acct, server, port, opts = {}) {
    const log = opts.log || (() => { });
    const startedAt = new Date();
    log(`[agent] ${spec.objectType} SF->Tally: starting${opts.dryRun ? ' (dry-run)' : ''}`);
    const maps = await loadMappings(spec.objectType, 'ToTally', acct.sapCode);
    if (!maps.length) {
        log(`[agent] no active ToTally mappings for ${spec.objectType} — nothing to do`, true);
        return { pending: 0, created: 0, failed: 0, errors: ['no mappings'] };
    }
    const sourceFields = [...new Set(maps.filter(m => m.source).map(m => m.source))];
    const soql = `SELECT Id, ${sourceFields.join(', ')} FROM ${spec.stagingObject} ` +
        `WHERE Direction__c = 'ToTally' AND Sync_Status__c = 'Pending' AND SAP_Company_Code__c = '${acct.sapCode.replace(/'/g, "\\'")}'`;
    const rows = await sfQuery(soql);
    log(`[agent] ${spec.objectType}: ${rows.length} pending staging rows`);
    const res = { pending: rows.length, created: 0, failed: 0, errors: [] };
    for (const row of rows) {
        const logical = applyMapping(row, maps);
        const built = assembleVoucher(spec.objectType, logical);
        if (typeof built === 'string') {
            res.failed++;
            res.errors.push(`${row.Id}: ${built}`);
            if (!opts.dryRun)
                await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: built }).catch(() => { });
            log(`  ${row.Id}: invalid - ${built}`, true);
            continue;
        }
        const pr = await postVoucher(server, port, built, { dryRun: opts.dryRun, log: (m, e) => log('  ' + m, e) });
        if (pr.ok) {
            res.created++;
            if (!opts.dryRun)
                await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Done', Error__c: '', Tally_Voucher_Number__c: built.voucherNumber || '' }).catch(() => { });
        }
        else {
            res.failed++;
            res.errors.push(`${row.Id}: ${pr.message}`);
            if (!opts.dryRun)
                await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: pr.message.slice(0, 32000) }).catch(() => { });
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
function qstr(s) { return '&quot;' + s.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '&quot;'; }
//# sourceMappingURL=sfAgent.mjs.map