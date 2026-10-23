import { sfQuery, sfUpdate, sfInsert } from './sfClient.mjs';
import { AccountRef } from './sfConfig.mjs';
import { ensurePriceLevel, setLedgerPriceLevel, upsertStockItemPrice, currentCompanyName } from './tallyPrice.mjs';

// PRICING bridge (SF -> Tally only). Pricing is mastered in Salesforce on Tally_Price__c
// (Direction__c = ToTally only) and pushed into each distributor's Tally as price lists. One row =
// "customer C buys product P at >= Quantity for Price/UOM, valid [Start_Date, End_Date]". We map it
// to a Tally price level (named for the customer's ledger), assigned to that ledger, with a dated,
// quantity-banded rate on the product's stock item. Selection is by data state (Sync_Status__c =
// 'Pending'); we stamp 'Done'/'Error' + a synthetic Tally_Guid__c back. Idempotent and re-runnable.
//
// NOTE: Tally XML import does NOT auto-apply a price list to an imported voucher (that is a Tally UI
// convenience). The connector's SF->Tally voucher path resolves the line rate itself; this module
// only maintains the price-list masters in Tally so the distributor's own Tally reflects the agreed
// per-customer pricing.

export type LogFn = (msg: string, isError?: boolean) => void;

export interface PriceSyncResult { scanned: number; pushed: number; failed: number; errors: string[]; }

function esc(s: any): string { return (s == null ? '' : String(s)).replace(/'/g, "\\'"); }

/** Tally_Price__c.Start_Date__c (ISO 'YYYY-MM-DD' or Date) -> Tally 'YYYYMMDD'. '' when unparseable. */
function toTallyDate(v: any): string {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

async function logTrigger(op: string, status: string, relId: string, message: string): Promise<void> {
    try {
        await sfInsert('Trigger_Log__c', [{
            Integration_Name__c: 'Tally Connector', Object_Name__c: 'Tally_Price__c',
            Operation__c: op, Status__c: status, Related_Record_Id__c: relId || undefined,
            Error_Message__c: message ? message.slice(0, 32000) : undefined,
            Started_At__c: new Date().toISOString(), Completed_At__c: new Date().toISOString(),
        }]);
    } catch { /* swallow */ }
}

/** OUTBOUND (SF -> Tally) PRICE sync: push Pending Tally_Price__c rows for this distributor into
 *  Tally as price-level price lists, then stamp status back. */
export async function syncPricesToTally(acct: AccountRef, server: string, port: number,
    opts: { log?: LogFn; dryRun?: boolean } = {}): Promise<PriceSyncResult> {
    const log = opts.log || (() => { });
    const res: PriceSyncResult = { scanned: 0, pushed: 0, failed: 0, errors: [] };
    const rows = await sfQuery(
        `SELECT Id, Customer__c, Product__c, Price__c, Quantity__c, Start_Date__c, End_Date__c, UOM__c ` +
        `FROM Tally_Price__c ` +
        `WHERE Account__c = '${esc(acct.id)}' AND Direction__c = 'ToTally' AND Sync_Status__c = 'Pending' ` +
        `AND Customer__c != null AND Product__c != null AND Price__c != null ` +
        `ORDER BY Start_Date__c NULLS FIRST`);
    res.scanned = rows.length;
    if (!rows.length) { log('SF->Tally prices: nothing pending'); return res; }

    // Resolve the two references we need, scoped to this distributor:
    //  Customer (Account) -> Tally party ledger name (Tally_Account__c under this distributor)
    //  Product (Product2) -> Tally stock item name + base unit (Tally_Product__c via its mapping)
    const custIds = [...new Set(rows.map(r => r.Customer__c).filter(Boolean))];
    const prodIds = [...new Set(rows.map(r => r.Product__c).filter(Boolean))];
    const inClause = (ids: string[]) => ids.map(i => `'${esc(i)}'`).join(',');

    const ledgerByCustomer = new Map<string, string>();
    if (custIds.length) {
        const la = await sfQuery(
            `SELECT Account__c, Name FROM Tally_Account__c ` +
            `WHERE Distributor__c = '${esc(acct.id)}' AND Account__c IN (${inClause(custIds)})`);
        for (const r of la) if (r.Account__c && r.Name) ledgerByCustomer.set(r.Account__c, r.Name);
    }
    const itemByProduct = new Map<string, { name: string; unit: string }>();
    if (prodIds.length) {
        const tp = await sfQuery(
            `SELECT Dist_Product_Mapping__r.Product__c, Name, BaseUOM__c FROM Tally_Product__c ` +
            `WHERE Account__c = '${esc(acct.id)}' AND Dist_Product_Mapping__r.Product__c IN (${inClause(prodIds)})`);
        for (const r of tp) {
            const pid = r.Dist_Product_Mapping__r?.Product__c;
            if (pid && r.Name) itemByProduct.set(pid, { name: r.Name, unit: r.BaseUOM__c || '' });
        }
    }

    // Resolve the active company name ONCE (needed as a literal to create price levels).
    const company = await currentCompanyName(server, port);
    if (!company) log('SF->Tally prices: WARNING — could not resolve current company name; price-level creation may fail', true);

    // A price level per customer only needs to be ensured + assigned to the ledger once per run.
    const levelReady = new Set<string>();

    for (const r of rows) {
        const ledger = ledgerByCustomer.get(r.Customer__c);
        const item = itemByProduct.get(r.Product__c);
        const fail = async (msg: string) => {
            res.failed++; res.errors.push(`${r.Id}: ${msg}`);
            if (!opts.dryRun) await sfUpdate('Tally_Price__c', r.Id, { Sync_Status__c: 'Error', Error__c: msg.slice(0, 32000) }).catch(() => { });
            await logTrigger('SF->Tally Price', 'Error', r.Id, msg);
            log(`  price ${r.Id}: ${msg}`, true);
        };
        if (!ledger) { await fail(`no Tally ledger for customer ${r.Customer__c} under this distributor (create/sync the customer's Tally_Account first)`); continue; }
        if (!item) { await fail(`no Tally stock item for product ${r.Product__c} under this distributor (sync the product first)`); continue; }
        const applicableFrom = toTallyDate(r.Start_Date__c) || toTallyDate(new Date().toISOString());
        const unit = (r.UOM__c || item.unit || 'pcs').toString().trim() || 'pcs';
        const level = ledger; // price level named for the customer's ledger (1:1, unique per company)
        const rate = Number(r.Price__c) || 0;
        const qtyFrom = (r.Quantity__c != null) ? Number(r.Quantity__c) : undefined;

        if (opts.dryRun) {
            log(`[dry-run] price '${item.name}' @ '${level}' from ${applicableFrom} (qty>=${qtyFrom ?? 1}) = ${rate.toFixed(2)}/${unit}`);
            res.pushed++; continue;
        }
        try {
            if (!levelReady.has(level)) {
                const lv = await ensurePriceLevel(server, port, level, company, log);
                if (!lv.ok) { await fail(`price level '${level}': ${lv.message}`); continue; }
                const al = await setLedgerPriceLevel(server, port, ledger, level, log);
                if (!al.ok) { await fail(`assign price level to ledger '${ledger}': ${al.message}`); continue; }
                levelReady.add(level);
            }
            const w = await upsertStockItemPrice(server, port, { stockItem: item.name, priceLevel: level, applicableFrom, qtyFrom, rate, unit }, log);
            if (!w.ok) { await fail(`price list '${item.name}': ${w.message}`); continue; }
            res.pushed++;
            // No native GUID for a price-list row; stamp a synthetic key for traceability + Done.
            const synth = `price:${item.name}#${level}#${applicableFrom}#${qtyFrom ?? 1}`.slice(0, 255);
            await sfUpdate('Tally_Price__c', r.Id, { Sync_Status__c: 'Done', Error__c: '', Tally_Guid__c: synth }).catch(() => { });
            await logTrigger('SF->Tally Price', 'Success', r.Id, synth);
        } catch (e: any) {
            await fail(e?.message || String(e));
        }
    }
    log(`SF->Tally prices: scanned=${res.scanned} pushed=${res.pushed} failed=${res.failed}`);
    return res;
}
