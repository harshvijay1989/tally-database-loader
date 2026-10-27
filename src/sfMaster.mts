import { sfQuery, sfUpdate, sfUpsert, sfInsert } from './sfClient.mjs';
import { AccountRef } from './sfConfig.mjs';
import { upsertLedgerWithSapId, setLedgerSapId, readLedgerKeys, upsertStockItemWithSapId, upsertGodown, readGodownKeys, ensureStockGroup, setLedgerMultiAddress, tallyUnitSymbol, MasterKey, TallyAddress, LedgerProfile } from './tallyMaster.mjs';
import { resolveStateCode, stateNameFromCode } from './stateCodes.mjs';

/** Build a TallyAddress from a Salesforce compound-address field set (e.g. 'BillingAddress__' on
 *  Tally_Account__c, 'Full_Address__' on Tally_Shipping_Address__c). Salesforce stores the STATE
 *  CODE ('MH'); Tally wants the state NAME ('Maharashtra'), so translate it here. */
export function addressFromSf(row: Record<string, any>, prefix: string,
    extra: { gstin?: string; phone?: string; email?: string; mailingName?: string; addressName?: string } = {}): TallyAddress {
    const g = (f: string) => { const v = row[`${prefix}${f}__s`]; return v == null ? '' : String(v).trim(); };
    const street = g('Street');
    return {
        lines: street ? street.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [],
        city: g('City'),
        state: stateNameFromCode(g('StateCode')) || '',
        pincode: g('PostalCode'),
        country: 'India',
        gstin: (extra.gstin || '').trim() || undefined,
        phone: (extra.phone || '').trim() || undefined,
        email: (extra.email || '').trim() || undefined,
        mailingName: (extra.mailingName || '').trim() || undefined,
        addressName: (extra.addressName || '').trim() || undefined,
    };
}

/** Build a ledger's commercial details from a Tally_Account__c row. Bank details are read from the
 *  bridge when present (Bank_* fields); they are absent on older orgs, in which case no bank block
 *  is sent rather than guessing. */
export function ledgerProfileFromSf(row: Record<string, any>): LedgerProfile {
    const n = (v: any) => (v == null || v === '') ? undefined : Number(v);
    const s = (v: any) => { const t = String(v == null ? '' : v).trim(); return t || undefined; };
    const bank = {
        name: s(row.Bank_Name__c), accountNumber: s(row.Bank_Account_Number__c),
        ifsc: s(row.IFSC_Code__c), branch: s(row.Bank_Branch__c),
    };
    return {
        creditLimit: n(row.Credit_Limit__c),
        creditPeriodDays: n(row.Credit_Period_Days__c),
        pan: s(row.PAN__c),
        gstRegistrationType: s(row.GST_Registration_Type__c),
        contactPerson: s(row.Primary_Contact__r?.Name),
        mobile: s(row.Phone__c),
        ...((bank.name || bank.accountNumber || bank.ifsc || bank.branch) ? { bank } : {}),
    };
}

/** One-line description of an address, for dry-run/log output. */
export function addressSummary(a: TallyAddress): string {
    return [...(a.lines || []), a.city, a.state, a.pincode].filter(Boolean).join(', ') || '(none)';
}

/** The stock item's unit of measure. PackType__c is the REAL packing unit (Bucket / Carton Box);
 *  BaseUOM__c is only a fallback because in this org it is literally 'Carton Box' on every product
 *  — including ones sold in buckets — so using it alone made every item carton-box. */
export function resolveProductUnit(row: Record<string, any>, fallback = 'Nos'): string {
    const pick = String(row.PackType__c || '').trim() || String(row.BaseUOM__c || '').trim() || fallback;
    return tallyUnitSymbol(pick);
}

/** Create the Category > SubCategory stock groups for a product (once per run, tracked in `done`). */
export async function ensureProductStockGroups(server: string, port: number, category: string,
    subCategory: string, done: Set<string>, log?: LogFn): Promise<void> {
    const cat = (category || '').trim();
    const sub = (subCategory || '').trim();
    if (cat && !done.has(`c:${cat}`)) { await ensureStockGroup(server, port, cat, undefined, log); done.add(`c:${cat}`); }
    // The sub-group nests under its category (when there is one); a sub with no category is top-level.
    if (sub && sub !== cat && !done.has(`s:${cat}>${sub}`)) {
        await ensureStockGroup(server, port, sub, cat || undefined, log);
        done.add(`s:${cat}>${sub}`);
    }
}

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
        `SELECT Id, Name, SAP_ID__c, Tally_Guid__c, Account_Group__c, ` +
        // Mailing address + contact/tax identity — without these the Tally ledger is created
        // address-less (the org holds the full address on Tally_Account__c; we simply never sent it).
        `BillingAddress__Street__s, BillingAddress__City__s, BillingAddress__PostalCode__s, ` +
        `BillingAddress__StateCode__s, BillingAddress__CountryCode__s, ` +
        `GSTIN__c, Phone__c, Email__c, Mailing_Name__c, ` +
        // Commercial details — present on Tally_Account__c and already populated by the org's own
        // mapping, but never sent to Tally until now.
        `Credit_Limit__c, Credit_Period_Days__c, PAN__c, GST_Registration_Type__c, Primary_Contact__r.Name ` +
        `FROM Tally_Account__c ` +
        `WHERE Distributor__c = '${esc(acct.id)}' AND Sync_Status__c = 'To Tally' ` +
        `AND SAP_ID__c != null AND Tally_Guid__c = null ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    for (const r of rows) {
        const name: string = r.Name;
        const sapId: string = r.SAP_ID__c || '';
        const group: string = r.Account_Group__c || DEFAULT_DEBTOR_GROUP;
        const address = addressFromSf(r, 'BillingAddress__', { gstin: r.GSTIN__c, phone: r.Phone__c, email: r.Email__c, mailingName: r.Mailing_Name__c });
        const profile = ledgerProfileFromSf(r);
        if (opts.dryRun) { log(`[dry-run] would push ledger '${name}' (sap='${sapId}', group='${group}', address='${addressSummary(address)}', creditLimit=${profile.creditLimit ?? 'n/a'}, pan=${profile.pan || 'n/a'})`); continue; }
        try {
            const w = await upsertLedgerWithSapId(server, port, name, group, sapId, { log, address, profile });
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

// A distributor's own warehouses (= Tally godowns / stock locations) are modelled in the org on
// Tally_Shipping_Address__c with Address_Type__c = WAREHOUSE_ADDR_TYPE. (The same object also holds
// customer ship-to rows, Address_Type__c='Shipping', which are consumed at voucher time — see
// sfAgent — and are NOT Tally masters.) The Tally-side godown machinery (upsertGodown/readGodownKeys
// in tallyMaster) is unchanged; only the Salesforce object this reads/writes changed from our old
// Tally_Godown__c to Tally_Shipping_Address__c.
export const WAREHOUSE_ADDR_TYPE = 'Warehouse';

/** OUTBOUND (SF -> Tally) LOCATION master: push the distributor's OWN warehouses as Tally godowns.
 *  Tally_Shipping_Address__c holds two different things, told apart by Address_Type__c:
 *    * 'Warehouse'          -> one of the DISTRIBUTOR's own stock locations  = a Tally GODOWN (here)
 *    * 'Shipping'/'Billing' -> a CUSTOMER's address, which is NOT a stock location: it belongs on
 *                              that customer's ledger as a Tally "multiple address" entry
 *                              (see syncCustomerAddressesToTally).
 *  Creating a godown for a customer address was wrong — it invented phantom stock locations. */
export async function syncWarehousesToTally(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: 0, errors: [] };
    const rows = await sfQuery(
        `SELECT Id, Name, Address_Type__c, Tally_Guid__c ` +
        `FROM Tally_Shipping_Address__c ` +
        `WHERE Account__c = '${esc(acct.id)}' AND Sync_Status__c = 'To Tally' ` +
        `AND Address_Type__c = '${esc(WAREHOUSE_ADDR_TYPE)}' ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    for (const r of rows) {
        const name: string = r.Name;
        const knownGuid: string = r.Tally_Guid__c || '';
        if (opts.dryRun) { log(`[dry-run] would push warehouse/godown '${name}' (guid='${knownGuid}')`); continue; }
        try {
            const w = await upsertGodown(server, port, name, '', { knownGuid: knownGuid || undefined, log });
            if (!w.ok) { res.failed++; res.errors.push(`${name}: ${w.message}`); await logTrigger('SF->Tally Warehouse', 'Error', 'Tally_Shipping_Address__c', r.Id, w.message); continue; }
            res.pushed++;
            if (w.guid && w.guid !== knownGuid) {
                await sfUpdate('Tally_Shipping_Address__c', r.Id, { Tally_Guid__c: w.guid });
                log(`  warehouse '${name}' -> GUID ${w.guid} written back to SF`);
            }
            await logTrigger('SF->Tally Warehouse', 'Success', 'Tally_Shipping_Address__c', r.Id, `guid=${w.guid || ''}`);
        } catch (e: any) {
            res.failed++; res.errors.push(`${name}: ${e.message}`);
            await logTrigger('SF->Tally Warehouse', 'Error', 'Tally_Shipping_Address__c', r.Id, e.message);
        }
    }
    log(`SF->Tally warehouses: scanned=${res.scanned} pushed=${res.pushed} failed=${res.failed}`);
    return res;
}

/** OUTBOUND (SF -> Tally) CUSTOMER ADDRESSES: Tally_Shipping_Address__c rows that are NOT the
 *  distributor's own warehouse (Address_Type__c 'Shipping' / 'Billing') describe a CUSTOMER's
 *  delivery or billing address. In Tally those live on the customer's LEDGER as a "multiple
 *  address" entry (labelled by the row's Name) — never as a godown. The customer ledger is the
 *  row's Tally_Account__c lookup; a row without one cannot be placed and is reported, not guessed. */
export async function syncCustomerAddressesToTally(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: 0, errors: [] };
    const rows = await sfQuery(
        `SELECT Id, Name, Address_Type__c, Tally_Account__r.Name, Tally_Account__r.GSTIN__c, ` +
        `Full_Address__Street__s, Full_Address__City__s, Full_Address__PostalCode__s, ` +
        `Full_Address__StateCode__s, Full_Address__CountryCode__s ` +
        `FROM Tally_Shipping_Address__c ` +
        `WHERE Account__c = '${esc(acct.id)}' AND Sync_Status__c = 'To Tally' ` +
        `AND Address_Type__c != '${esc(WAREHOUSE_ADDR_TYPE)}' ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    for (const r of rows) {
        const label: string = r.Name;
        const ledger: string = r.Tally_Account__r?.Name || '';
        if (!ledger) {
            res.failed++;
            const msg = `no Tally_Account__c (customer ledger) on this address — cannot place it`;
            res.errors.push(`${label}: ${msg}`);
            log(`  customer address '${label}': ${msg}`, true);
            await logTrigger('SF->Tally CustomerAddress', 'Error', 'Tally_Shipping_Address__c', r.Id, msg);
            continue;
        }
        const address = addressFromSf(r, 'Full_Address__', { gstin: r.Tally_Account__r?.GSTIN__c, addressName: label });
        if (opts.dryRun) { log(`[dry-run] would set ${r.Address_Type__c} address '${label}' on ledger '${ledger}' (${addressSummary(address)})`); continue; }
        try {
            const ok = await setLedgerMultiAddress(server, port, ledger, address, log);
            if (!ok) { res.failed++; res.errors.push(`${label}: could not set address on ledger '${ledger}'`); await logTrigger('SF->Tally CustomerAddress', 'Error', 'Tally_Shipping_Address__c', r.Id, `ledger '${ledger}'`); continue; }
            res.pushed++;
            log(`  ${r.Address_Type__c} address '${label}' -> ledger '${ledger}'`);
            await logTrigger('SF->Tally CustomerAddress', 'Success', 'Tally_Shipping_Address__c', r.Id, `ledger=${ledger}`);
        } catch (e: any) {
            res.failed++; res.errors.push(`${label}: ${e.message}`);
            await logTrigger('SF->Tally CustomerAddress', 'Error', 'Tally_Shipping_Address__c', r.Id, e.message);
        }
    }
    log(`SF->Tally customer addresses: scanned=${res.scanned} pushed=${res.pushed} failed=${res.failed}`);
    return res;
}

/** INBOUND (Tally -> SF) WAREHOUSE master: read ALL godowns (no SAP filter), incremental by AlterID,
 *  and upsert Tally_Shipping_Address__c (Address_Type__c='Warehouse', Account__c=distributor) by
 *  GUID. Mirrors syncAccountsToSalesforce; returns the new watermark. */
export async function syncWarehousesToSalesforce(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean; sinceAlterId?: number } = {}): Promise<MasterSyncResult> {
    const log = opts.log || (() => { });
    const res: MasterSyncResult = { scanned: 0, pushed: 0, pulled: 0, failed: 0, newWatermark: opts.sinceAlterId || 0, errors: [] };
    const keys: MasterKey[] = await readGodownKeys(server, port, { sinceAlterId: opts.sinceAlterId });
    const scoped = keys.filter(k => k.name && k.guid);
    res.scanned = scoped.length;
    res.newWatermark = scoped.reduce((mx, k) => Math.max(mx, k.alterId || 0), opts.sinceAlterId || 0);
    if (!scoped.length) { log('Tally->SF warehouses: nothing in scope'); return res; }
    if (opts.dryRun) { scoped.forEach(k => log(`[dry-run] would upsert Tally_Shipping_Address__c (Warehouse) name='${k.name}' guid=${k.guid}`)); return res; }
    const records = scoped.map(k => ({
        Tally_Guid__c: k.guid,
        Name: k.name.slice(0, 80),
        Account__c: acct.id,
        Address_Type__c: WAREHOUSE_ADDR_TYPE,
        Sync_Status__c: 'From Tally',
    }));
    try {
        const r = await sfUpsert('Tally_Shipping_Address__c', 'Tally_Guid__c', records, log);
        res.pulled = r.success;
        res.failed = r.failed;
        if (r.errors?.length) res.errors.push(...r.errors);
        await logTrigger('Tally->SF Warehouse', res.failed ? 'Partial' : 'Success', 'Tally_Shipping_Address__c', acct.id, `pulled=${res.pulled} failed=${res.failed}`);
    } catch (e: any) {
        res.failed = records.length; res.errors.push(e.message);
        await logTrigger('Tally->SF Warehouse', 'Error', 'Tally_Shipping_Address__c', acct.id, e.message);
    }
    log(`Tally->SF warehouses: scanned=${res.scanned} pulled=${res.pulled} failed=${res.failed} newWatermark=${res.newWatermark}`);
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

/** ONE-TIME BACKFILL (Tally -> SF): fill the GST state on legacy Tally_Account__c rows that have no
 *  BillingAddress__StateCode__s yet. The normal inbound pull is AlterID-watermark-gated, so an
 *  unchanged legacy ledger is never re-read and its stateless account would keep failing the
 *  Require_Billing_State validation rule. This reads each stateless row's ledger from Tally by GUID
 *  (state + GSTIN), resolves the SF state code, and updates the row. Idempotent and re-runnable:
 *  rows that already have a state are not queried; a row whose ledger has no resolvable state/GSTIN
 *  (or whose GUID isn't found in Tally) is counted 'unresolvable' and left for a data fix. */
export async function backfillAccountStates(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean } = {}): Promise<{ scanned: number; filled: number; unresolvable: number; failed: number; errors: string[] }> {
    const log = opts.log || (() => { });
    const res = { scanned: 0, filled: 0, unresolvable: 0, failed: 0, errors: [] as string[] };
    const rows = await sfQuery(
        `SELECT Id, Name, Tally_Guid__c ` +
        `FROM Tally_Account__c ` +
        `WHERE Distributor__c = '${esc(acct.id)}' AND Tally_Guid__c != null AND BillingAddress__StateCode__s = null ` +
        `ORDER BY Name`);
    res.scanned = rows.length;
    if (!rows.length) { log('account-state backfill: no stateless rows to fill'); return res; }
    // Read current ledger state + GSTIN by GUID, chunked so the OR-ed filter formula stays small.
    const byGuid = new Map<string, { state?: string; gstin?: string }>();
    const guids = rows.map(r => r.Tally_Guid__c);
    for (let i = 0; i < guids.length; i += 150) {
        const keys = await readLedgerKeys(server, port, { guids: guids.slice(i, i + 150) });
        for (const k of keys) byGuid.set(k.guid, { state: k.state, gstin: k.gstin });
    }
    for (const r of rows) {
        const led = byGuid.get(r.Tally_Guid__c);
        const code = led ? resolveStateCode(led.state, led.gstin) : '';
        if (!code) { res.unresolvable++; log(`  ${r.Name}: no resolvable state (ledger state='${led?.state || ''}' gstin='${led?.gstin || ''}'${led ? '' : ', guid not found in Tally'})`, true); continue; }
        if (opts.dryRun) { log(`[dry-run] would set state ${code} on '${r.Name}' (state='${led!.state || ''}' gstin='${led!.gstin || ''}')`); res.filled++; continue; }
        try {
            await sfUpdate('Tally_Account__c', r.Id, { BillingAddress__CountryCode__s: 'IN', BillingAddress__StateCode__s: code, GSTIN__c: led!.gstin || undefined });
            res.filled++;
            await logTrigger('Tally->SF State backfill', 'Success', 'Tally_Account__c', r.Id, `${r.Name} <- ${code}`);
        } catch (e: any) {
            res.failed++; res.errors.push(`${r.Name}: ${e.message}`);
            await logTrigger('Tally->SF State backfill', 'Error', 'Tally_Account__c', r.Id, e.message);
        }
    }
    log(`account-state backfill: scanned=${res.scanned} filled=${res.filled} unresolvable=${res.unresolvable} failed=${res.failed}`);
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
        `SELECT Id, Name, SAP_ID__c, Tally_Guid__c, BaseUOM__c, PackType__c, ` +
        `Category__c, SubCategory__c, HSN__c, GST_Percentage__c ` +
        `FROM Tally_Product__c ` +
        `WHERE Account__c = '${esc(acct.id)}' AND SAP_ID__c != null AND Tally_Guid__c = null ` +
        `ORDER BY Name`);
    // Stock groups created once per run (Category -> SubCategory), not per product.
    const groupsDone = new Set<string>();
    res.scanned = rows.length;
    for (const r of rows) {
        const name: string = r.Name;
        const sapId: string = r.SAP_ID__c || '';
        const unit: string = resolveProductUnit(r, fallbackUnit);
        const gstRate: number | undefined = (r.GST_Percentage__c != null) ? Number(r.GST_Percentage__c) : undefined;
        const hsn: string | undefined = r.HSN__c || undefined;
        // Category > SubCategory become nested Tally stock groups; the item sits in the deepest one.
        const category = String(r.Category__c || '').trim();
        const subCategory = String(r.SubCategory__c || '').trim();
        const stockGroup = subCategory || category || undefined;
        if (opts.dryRun) { log(`[dry-run] would push stock item '${name}' (sap='${sapId}', unit='${unit}', group='${stockGroup ?? 'n/a'}', gst=${gstRate ?? 'n/a'}, hsn=${hsn ?? 'n/a'})`); continue; }
        try {
            await ensureProductStockGroups(server, port, category, subCategory, groupsDone, log);
            const w = await upsertStockItemWithSapId(server, port, name, unit, sapId, { gstRate, hsn, stockGroup, log });
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
