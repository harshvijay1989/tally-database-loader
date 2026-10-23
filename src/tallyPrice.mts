import { postTallyXml } from './tallyLive.mjs';

// Tally WRITE path for PRICING (SF -> Tally only; Tally_Price__c.Direction__c is ToTally only).
//
// Per-customer pricing in Tally is modelled with PRICE LEVELS: a price level is defined on the
// company, assigned to a party ledger, and then each stock item carries a PRICE LIST — rates per
// price level, each dated (applicable-from) and optionally banded by quantity. So one Tally_Price__c
// row ("customer C buys product P at >= Qty for rate R during [Start,End]") becomes:
//   1. a price level named for the customer           (ensurePriceLevel)
//   2. that price level set on the customer's ledger  (setLedgerPriceLevel)
//   3. a price-list entry on the stock item: applicable-from = Start_Date, qty-from = Quantity,
//      rate = Price/UOM, under that price level        (upsertStockItemPrice)
//
// IMPORTANT (verify live): Tally's price-list XML schema is version-sensitive and must be confirmed
// against the live company during whole-system testing. The element structure below follows the
// TallyPrime stock-item FULLPRICELIST export shape; tags (FULLPRICELIST.LIST/PRICELEVELLIST.LIST/
// APPLICABLEFROM/STARTINGFROM/PRICELEVEL/RATE) and price-level creation via the Company master are
// the best-known forms and are the primary thing to validate when we test end-to-end. The company
// must also have "Use Multiple Price Levels" enabled (F11 > Inventory) — that is a one-time company
// setting that cannot be reliably toggled over the XML gateway.

function esc(s: any): string {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const num = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? parseInt(m[1], 10) || 0 : 0; };
const lineErr = (xml: string) => (xml.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';

export interface PriceWriteResult { ok: boolean; message: string; }

/** One price-list row to apply to a stock item. */
export interface StockPriceEntry {
    stockItem: string;        // Tally stock item name (must exist)
    priceLevel: string;       // the price level this rate belongs to
    applicableFrom: string;   // YYYYMMDD (from Tally_Price__c.Start_Date__c)
    qtyFrom?: number;         // quantity slab lower bound (Tally_Price__c.Quantity__c); omitted => from 1
    rate: number;             // price per unit (Tally_Price__c.Price__c)
    unit: string;             // UOM (Tally_Price__c.UOM__c or the stock item base unit)
}

/** Ensure a PRICE LEVEL exists on the active company (idempotent create; Tally ignores a duplicate).
 *  Price levels live on the company's price-level list; we add one by name. */
export async function ensurePriceLevel(server: string, port: number, level: string,
    log?: (m: string, e?: boolean) => void): Promise<PriceWriteResult> {
    if (!level) return { ok: false, message: 'empty price level name' };
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE>'
        + '<COMPANY NAME="##SVCurrentCompany" ACTION="Alter">'
        + `<PRICELEVELLIST.LIST><PRICELEVEL>${esc(level)}</PRICELEVEL></PRICELEVELLIST.LIST>`
        + '</COMPANY>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 20000);
    const errs = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const le = lineErr(resp);
    // A price level that already exists is reported as a duplicate / no-op, which we treat as success.
    const ok = errs === 0 || /duplicate|already/i.test(le);
    log?.(`price level '${level}': ${ok ? 'ensured' : 'FAILED — ' + (le || 'errors=' + errs)}`, !ok);
    return { ok, message: ok ? 'ok' : (le || `errors=${errs}`) };
}

/** Assign a price level to a party ledger (so Tally applies that level's price list for the party). */
export async function setLedgerPriceLevel(server: string, port: number, ledger: string, level: string,
    log?: (m: string, e?: boolean) => void): Promise<PriceWriteResult> {
    if (!ledger || !level) return { ok: false, message: 'ledger and level required' };
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE>'
        + `<LEDGER NAME="${esc(ledger)}" ACTION="Alter"><PRICELEVEL>${esc(level)}</PRICELEVEL></LEDGER>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 20000);
    const errs = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const ok = errs === 0 && num(resp, 'ALTERED') > 0;
    const le = lineErr(resp);
    log?.(`ledger '${ledger}' price level -> '${level}': ${ok ? 'ok' : 'FAILED — ' + (le || 'errors=' + errs)}`, !ok);
    return { ok, message: ok ? 'ok' : (le || `errors=${errs}`) };
}

/** Add/overwrite one price-list entry on a stock item: a rate for a price level, applicable from a
 *  date, for quantities at/above qtyFrom. Altering the stock item's FULLPRICELIST is additive in
 *  Tally for a new (date, level, qty-band) combination and overwrites a matching one. */
export async function upsertStockItemPrice(server: string, port: number, e: StockPriceEntry,
    log?: (m: string, e?: boolean) => void): Promise<PriceWriteResult> {
    if (!e.stockItem || !e.priceLevel) return { ok: false, message: 'stock item and price level required' };
    if (!/^\d{8}$/.test(String(e.applicableFrom || ''))) return { ok: false, message: `bad applicable-from date '${e.applicableFrom}'` };
    const qtyFrom = (typeof e.qtyFrom === 'number' && e.qtyFrom > 0) ? e.qtyFrom : 1;
    const rateStr = `${e.rate.toFixed(2)}/${esc(e.unit)}`;
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE>'
        + `<STOCKITEM NAME="${esc(e.stockItem)}" ACTION="Alter">`
        + '<FULLPRICELIST.LIST>'
        + `<APPLICABLEFROM>${esc(e.applicableFrom)}</APPLICABLEFROM>`
        + '<PRICELEVELLIST.LIST>'
        + `<PRICELEVEL>${esc(e.priceLevel)}</PRICELEVEL>`
        + `<STARTINGFROM>${qtyFrom} ${esc(e.unit)}</STARTINGFROM>`
        + `<RATE>${rateStr}</RATE>`
        + '</PRICELEVELLIST.LIST>'
        + '</FULLPRICELIST.LIST>'
        + '</STOCKITEM>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 25000);
    const errs = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const ok = errs === 0 && (num(resp, 'ALTERED') > 0 || num(resp, 'CREATED') > 0);
    const le = lineErr(resp);
    log?.(`price '${e.stockItem}' @ '${e.priceLevel}' from ${e.applicableFrom} (qty>=${qtyFrom}) = ${rateStr}: ${ok ? 'ok' : 'FAILED — ' + (le || 'errors=' + errs)}`, !ok);
    return { ok, message: ok ? 'ok' : (le || `errors=${errs}`) };
}
