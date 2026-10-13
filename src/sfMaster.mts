import { sfQuery, sfUpdate, sfUpsert, sfInsert } from './sfClient.mjs';
import { AccountRef } from './sfConfig.mjs';
import { upsertLedgerWithSapId, setLedgerSapId, readLedgerKeys, upsertStockItemWithSapId, MasterKey } from './tallyMaster.mjs';
import { resolveStateCode } from './stateCodes.mjs';

// Account master bridge (Tally side only). Morde's ORG already owns the Salesforce-side
// orchestration in Apex:
//   * AccountTallyHandler (Account after insert): creates a Tally_Account__c with SAP copied,
//     Tally_Guid__c BLANK, Account__c linked -- the "please create this ledger" signal.
//   * DistributorCustomerSapIdHandler: generates the customer SAP_ID__c.
//   * TallyAccountSyncHandler (Tally_Account__c after insert/update): matches/creates the Account
//     for an inbound ledger, and on the round-trip copies the Tally GUID onto the Account.
// So the connector must NOT create Accounts or invent SAP Ids -- the org owns those. It does the
// one thing Apex cannot -- talk to the distributor's Tally:
//   OUTBOUND: the row exists with Sync_Status__c='To Tally', a SAP Id and a blank GUID -> create/
//             alter the ledger, write the real Tally GUID back (the org then stamps it on the
//             Account). We touch only Tally_Guid__c, never SAP or status.
//   INBOUND : read this distributor's ledgers (scoped) -> upsert Tally_Account__c by GUID with
//             Sync_Status__c='From Tally'; the org links/creates the Account and generates SAP.

export type LogFn = (msg: string, isError?: boolean) => void;
const DEFAULT_DEBTOR_GROUP = 'Sundry Debtors';

export interface MasterSyncResult { scanned: number; pushed: number; pulled: number; failed: number; newWatermark: number; errors: string[]; }

function esc(s: string): string { return (s || '').replace(/'/g, "\\'"); }

/** Best-effort audit row in Trigger_Log__c. Never throws (logging must not break a sync). */
async function logTrigger(op: string, status: string, objectName: string, relId: string, message: string): Promise<void> {
    try {
        await sfInsert('Trigger_Log__c', [{
            Integration_Name__c: 'Tally Connector',
            Object_Name__c: objectName,
            Operation__c: op,
            Status__c: status,
            Related_Record_Id__c: relId || undefined,
            Error_Message__c: message ? message.slice(0, 32000) : undefined,
            Started_At__c: new Date().toISOString(),
            Completed_At__c: new Date().toISOString(),
        }]);
    } catch { /* swallow */ }
}

/** OUTBOUND (SF -> Tally): the org created Tally_Account__c rows with a SAP Id and a blank GUID;
 *  create/alter the ledger carrying that SAP Id and copy the real Tally GUID back. Selection is by
 *  DATA STATE (GUID blank + SAP present), not by Sync_Status__c -- the org owns that picklist. */
export async function syncAccountsToTally(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: 0, errors: [] };
    // The business/org creates the row with Sync_Status__c = 'To Tally'; we send it when it also
    // has a SAP Id and no GUID yet. GUID-blank makes this self-terminating (once we write the
    // GUID back the row drops out of this query and is never pushed again).
    const rows = await sfQuery(
        `SELECT Id, Name, SAP_ID__c, Tally_Guid__c, Account_Group__c ` +
        `FROM Tally_Account__c ` +
        `WHERE Distributor__c = '${esc(acct.id)}' AND Sync_Status__c = 'To Tally' ` +
        `AND SAP_ID__c != null AND Tally_Guid__c = null ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    for (const r of rows) {
        const name: string = r.Name;
        const sapId: string = r.SAP_ID__c || '';
        const group: string = r.Account_Group__c || DEFAULT_DEBTOR_GROUP;
        if (opts.dryRun) { log(`[dry-run] would push ledger '${name}' (sap='${sapId}', group='${group}')`); continue; }
        try {
            const w = await upsertLedgerWithSapId(server, port, name, group, sapId, { log });
            if (!w.ok) { res.failed++; res.errors.push(`${name}: ${w.message}`); await logTrigger('SF->Tally Account', 'Error', 'Tally_Account__c', r.Id, w.message); continue; }
            res.pushed++;
            if (w.guid) {
                // Writing ONLY the GUID: the org's round-trip (Account__c already set by the
                // outbound handler) copies it onto the Account. We never touch SAP or status.
                await sfUpdate('Tally_Account__c', r.Id, { Tally_Guid__c: w.guid });
                log(`  ledger '${name}' -> GUID ${w.guid} written back to SF`);
            }
            await logTrigger('SF->Tally Account', 'Success', 'Tally_Account__c', r.Id, `guid=${w.guid || ''}`);
        } catch (e: any) {
            res.failed++; res.errors.push(`${name}: ${e.message}`);
            await logTrigger('SF->Tally Account', 'Error', 'Tally_Account__c', r.Id, e.message);
        }
    }
    log(`SF->Tally accounts: scanned=${res.scanned} pushed=${res.pushed} failed=${res.failed}`);
    return res;
}

/** INBOUND (Tally -> SF): read this distributor's in-scope ledgers and upsert Tally_Account__c by
 *  GUID. Scope is opt-in (default = ledgers carrying a Morde SAP Id, plus any names passed in from
 *  transaction sync), and incremental via the AlterID watermark. We set ONLY the bridge fields and
 *  leave Account__c / Sync_Status__c to the org's inbound handler. Returns the new watermark. */
export async function syncAccountsToSalesforce(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean; sinceAlterId?: number; includeNames?: string[] } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: opts.sinceAlterId || 0, errors: [] };
    // Scope: SAP-tagged + transaction-touched (names from voucher sync), incremental by AlterID.
    const keys: MasterKey[] = await readLedgerKeys(server, port, {
        sapTaggedOnly: true,
        names: opts.includeNames,
        sinceAlterId: opts.sinceAlterId,
    });
    const scoped = keys.filter(k => k.name && k.guid);
    res.scanned = scoped.length;
    res.newWatermark = scoped.reduce((mx, k) => Math.max(mx, k.alterId || 0), opts.sinceAlterId || 0);
    if (!scoped.length) { log('Tally->SF accounts: nothing in scope'); return res; }
    if (opts.dryRun) { scoped.forEach(k => log(`[dry-run] would upsert Tally_Account__c name='${k.name}' guid=${k.guid} sap='${k.sapId}'`)); return res; }
    const records = scoped.map(k => {
        const rec: Record<string, any> = {
            Tally_Guid__c: k.guid,
            Name: k.name.slice(0, 80),
            SAP_ID__c: k.sapId || undefined,
            GSTIN__c: k.gstin || undefined,  // copy the party's GSTIN up when Tally has it
            Distributor__c: acct.id,          // lets the org generate SAP + attach to the right distributor
            Sync_Status__c: 'From Tally',     // this record describes a ledger that came from Tally
            // Account__c is left for the org's inbound handler to match/create and link.
        };
        // Resolve the party's GST state (name first, GSTIN prefix fallback). A StateCode on a
        // State/Country picklist REQUIRES the CountryCode in the same write, so set both together.
        // When unresolvable, set neither — the record then fails the Require_Billing_State
        // validation rule by design and surfaces in Trigger_Log for a data fix.
        const code = resolveStateCode(k.state, k.gstin);
        if (code) { rec.BillingAddress__CountryCode__s = 'IN'; rec.BillingAddress__StateCode__s = code; }
        return rec;
    });
    try {
        const r = await sfUpsert('Tally_Account__c', 'Tally_Guid__c', records, log);
        res.pulled = r.success;
        res.failed = r.failed;
        if (r.errors?.length) res.errors.push(...r.errors);
        await logTrigger('Tally->SF Account', res.failed ? 'Partial' : 'Success', 'Tally_Account__c', acct.id, `pulled=${res.pulled} failed=${res.failed}`);
    } catch (e: any) {
        res.failed = records.length; res.errors.push(e.message);
        await logTrigger('Tally->SF Account', 'Error', 'Tally_Account__c', acct.id, e.message);
    }
    log(`Tally->SF accounts: scanned=${res.scanned} pulled=${res.pulled} failed=${res.failed} newWatermark=${res.newWatermark}`);
    return res;
}

/** BACKFILL (SF -> Tally): a retailer born in Tally comes in with no SAP; the org generates one and
 *  puts it on the Tally_Account__c. This writes that SAP back onto the Tally LEDGER's MordeSAPID UDF,
 *  so a later fetch can tell a KNOWN ledger (has a SAP) from a NEW one (no SAP). Idempotent: only
 *  writes where the ledger's current UDF differs from the SF SAP. Addressed by GUID, so a rename in
 *  Tally never loses the target. */
export async function backfillSapIdsToTally(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: 0, errors: [] };
    const rows = await sfQuery(
        `SELECT Id, SAP_ID__c, Tally_Guid__c ` +
        `FROM Tally_Account__c ` +
        `WHERE Distributor__c = '${esc(acct.id)}' AND SAP_ID__c != null AND Tally_Guid__c != null ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    if (!rows.length) { log('backfill SAP->Tally: nothing to check'); return res; }
    // Read current ledger state (name + current UDF) by GUID, chunked so the filter stays small.
    const byGuid = new Map<string, { name: string; sapId: string }>();
    const guids = rows.map(r => r.Tally_Guid__c);
    for (let i = 0; i < guids.length; i += 50) {
        const keys = await readLedgerKeys(server, port, { guids: guids.slice(i, i + 50) });
        for (const k of keys) byGuid.set(k.guid, { name: k.name, sapId: k.sapId });
    }
    for (const r of rows) {
        const led = byGuid.get(r.Tally_Guid__c);
        if (!led) { res.failed++; res.errors.push(`${r.Tally_Guid__c}: ledger not found in Tally`); continue; }
        if ((led.sapId || '') === r.SAP_ID__c) continue;   // already tagged with the same value
        if (opts.dryRun) { log(`[dry-run] would set SAP '${r.SAP_ID__c}' on ledger '${led.name}' (was '${led.sapId || ''}')`); res.pushed++; continue; }
        try {
            const ok = await setLedgerSapId(server, port, led.name, r.SAP_ID__c, log);
            if (ok) { res.pushed++; await logTrigger('SF->Tally SAP backfill', 'Success', 'Tally_Account__c', r.Id, `${led.name} <- ${r.SAP_ID__c}`); }
            else { res.failed++; res.errors.push(`${led.name}: set SAP failed`); await logTrigger('SF->Tally SAP backfill', 'Error', 'Tally_Account__c', r.Id, `${led.name} set failed`); }
        } catch (e: any) { res.failed++; res.errors.push(`${led.name}: ${e.message}`); await logTrigger('SF->Tally SAP backfill', 'Error', 'Tally_Account__c', r.Id, e.message); }
    }
    log(`backfill SAP->Tally: scanned=${res.scanned} written=${res.pushed} failed=${res.failed}`);
    return res;
}

/** OUTBOUND ONLY (SF -> Tally): products are mastered in Salesforce. The org's
 *  DistProductMappingHandler creates Tally_Product__c rows (SAP_ID__c = <distSAP>-<prodSAP/code>,
 *  Account__c = distributor, GUID blank); we create the Tally STOCK ITEM carrying that SAP Id and
 *  write the real GUID back onto the Tally_Product__c. The org's TallyProductSyncHandler then copies
 *  the GUID onto the DistProduct_Mapping__c. There is NO inbound: a Tally item with no SF mapping is
 *  left alone. Selection is by data state (SAP present + GUID blank), self-terminating on GUID. */
export async function syncProductsToTally(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean; defaultUnit?: string } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: 0, errors: [] };
    const fallbackUnit = opts.defaultUnit || 'pcs';
    const rows = await sfQuery(
        `SELECT Id, Name, SAP_ID__c, Tally_Guid__c, BaseUOM__c, HSN__c, GST_Percentage__c ` +
        `FROM Tally_Product__c ` +
        `WHERE Account__c = '${esc(acct.id)}' AND SAP_ID__c != null AND Tally_Guid__c = null ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    for (const r of rows) {
        const name: string = r.Name;
        const sapId: string = r.SAP_ID__c || '';
        const unit: string = (r.BaseUOM__c || fallbackUnit).trim() || fallbackUnit;
        const gstRate: number | undefined = (r.GST_Percentage__c != null) ? Number(r.GST_Percentage__c) : undefined;
        const hsn: string | undefined = r.HSN__c || undefined;
        if (opts.dryRun) { log(`[dry-run] would push stock item '${name}' (sap='${sapId}', unit='${unit}', gst=${gstRate ?? 'n/a'}, hsn=${hsn ?? 'n/a'})`); continue; }
        try {
            const w = await upsertStockItemWithSapId(server, port, name, unit, sapId, { gstRate, hsn, log });
            if (!w.ok) { res.failed++; res.errors.push(`${name}: ${w.message}`); await logTrigger('SF->Tally Product', 'Error', 'Tally_Product__c', r.Id, w.message); continue; }
            res.pushed++;
            if (w.guid) {
                await sfUpdate('Tally_Product__c', r.Id, { Tally_Guid__c: w.guid });
                log(`  stock item '${name}' -> GUID ${w.guid} written back to SF`);
            }
            await logTrigger('SF->Tally Product', 'Success', 'Tally_Product__c', r.Id, `guid=${w.guid || ''}`);
        } catch (e: any) {
            res.failed++; res.errors.push(`${name}: ${e.message}`);
            await logTrigger('SF->Tally Product', 'Error', 'Tally_Product__c', r.Id, e.message);
        }
    }
    log(`SF->Tally products: scanned=${res.scanned} pushed=${res.pushed} failed=${res.failed}`);
    return res;
}

export { setLedgerSapId };
