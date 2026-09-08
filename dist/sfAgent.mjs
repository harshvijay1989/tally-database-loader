import * as tallyLive from './tallyLive.mjs';
import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfUpsert, sfInsert } from './sfClient.mjs';
/** One Tally -> Salesforce run for a single object type. */
export async function syncToSalesforce(spec, server, port, log = () => { }) {
    log(`[agent] ${spec.objectType} Tally->SF: starting`);
    const maps = await loadMappings(spec.objectType, 'ToSalesforce');
    if (!maps.length) {
        log(`[agent] no active ToSalesforce mappings for ${spec.objectType} — nothing to do`, true);
        return { source: 0, mapped: 0, success: 0, failed: 0, errors: ['no mappings'] };
    }
    log(`[agent] ${spec.objectType}: ${maps.length} mappings loaded from Salesforce`);
    // read from Tally (safe windowed FETCH *; never bare)
    const r = await tallyLive.fetchAllWindowed(server, port, spec.tallyType, { windowSize: spec.windowSize || 500, log: (m, e) => log('  ' + m, e) });
    let rows = r.rows;
    if (spec.filterField) {
        const want = String(spec.filterValue || '').toLowerCase();
        rows = rows.filter(v => String(v[spec.filterField] || '').toLowerCase() === want);
        log(`[agent] ${spec.objectType}: filtered ${spec.filterField}='${spec.filterValue}' -> ${rows.length} of ${r.rows.length}`);
    }
    // apply the SF-authored mapping; keep only rows that produced the external id
    const mapped = rows.map(v => applyMapping(v, maps)).filter(x => x[spec.externalId] != null && x[spec.externalId] !== '');
    log(`[agent] ${spec.objectType}: ${rows.length} source rows -> ${mapped.length} mapped`);
    const up = await sfUpsert(spec.stagingObject, spec.externalId, mapped, (m, e) => log('  ' + m, e));
    const res = { source: rows.length, mapped: mapped.length, success: up.success, failed: up.failed, errors: up.errors };
    // record the run for monitoring/debug in Salesforce
    try {
        await sfInsert('Sync_Log__c', [{
                Object_Type__c: spec.objectType, Direction__c: 'ToSalesforce',
                Status__c: up.failed ? (up.success ? 'Partial' : 'Error') : 'Success',
                Records_Processed__c: up.success, Records_Failed__c: up.failed,
                Message__c: up.errors.slice(0, 10).join('\n').slice(0, 30000), Run_At__c: new Date().toISOString(),
            }]);
    }
    catch (e) {
        log(`[agent] could not write Sync_Log__c - ${e?.message || e}`, true);
    }
    log(`[agent] ${spec.objectType} Tally->SF: done — upserted ${up.success}, failed ${up.failed}`);
    return res;
}
/** Built-in specs for the vertical slice (later these come from Sync_Config__c). */
export const SYNC_SPECS = {
    Invoice: { objectType: 'Invoice', stagingObject: 'Tally_Invoice__c', externalId: 'Tally_Guid__c', tallyType: 'voucher', filterField: 'vouchertypename', filterValue: 'Sales' },
};
//# sourceMappingURL=sfAgent.mjs.map