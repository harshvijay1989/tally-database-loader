import { postTallyXml, buildFetchXmlFiltered, nameFilter, parseCollection } from './tallyLive.mjs';
import { tallyUnitSymbol } from './tallyMaster.mjs';
// Tally WRITE path (SF -> Tally) — creates/alters vouchers via an Import Data request over
// the same UTF-16LE gateway (docs/salesforce-agent-plan.md). This MODIFIES accounting data,
// so: validate before posting, balance debits==credits, support dry-run, and only ever run
// against a non-production company. Referenced masters (ledgers, voucher type) must already
// exist — that is guaranteed by the master-data-sync step in the full agent.
function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Build the Import Data XML for one voucher. ISDEEMEDPOSITIVE is derived from the amount
 *  sign (negative = debit = deemed positive), matching Tally's convention. */
export function buildVoucherImportXml(v, action = 'Create') {
    const hasInv = (v.inventoryEntries || []).length > 0;
    // KEY Tally rule: Invoice Voucher View (inventory vouchers) uses <LEDGERENTRIES.LIST>
    // for party/tax postings; Accounting Voucher View uses <ALLLEDGERENTRIES.LIST>. Using
    // the wrong tag makes Tally reject the voucher with a bare EXCEPTION (no line error).
    const ledgerTag = hasInv ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
    const objView = v.objView || (hasInv ? 'Invoice Voucher View' : 'Accounting Voucher View');
    const entries = v.entries.map(e => `<${ledgerTag}>`
        + `<LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>`
        + `<ISDEEMEDPOSITIVE>${e.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<AMOUNT>${e.amount.toFixed(2)}</AMOUNT>`
        + `</${ledgerTag}>`).join('');
    const dueDate = v.orderDueDate || v.date;
    const inventory = (v.inventoryEntries || []).map(i => '<ALLINVENTORYENTRIES.LIST>'
        + `<STOCKITEMNAME>${esc(i.stockItem)}</STOCKITEMNAME>`
        + `<ISDEEMEDPOSITIVE>${i.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<RATE>${i.rate.toFixed(2)}/${esc(tallyUnitSymbol(i.unit))}</RATE>`
        + `<AMOUNT>${i.amount.toFixed(2)}</AMOUNT>`
        // Quantity is always the POSITIVE magnitude; Tally takes direction (inward/outward) from
        // ISDEEMEDPOSITIVE (Yes = in / purchase, No = out / sale). A signed qty double-flips it and
        // a sale would wrongly ADD stock.
        + `<ACTUALQTY>${Math.abs(i.qty).toFixed(2)} ${esc(tallyUnitSymbol(i.unit))}</ACTUALQTY>`
        + `<BILLEDQTY>${Math.abs(i.qty).toFixed(2)} ${esc(tallyUnitSymbol(i.unit))}</BILLEDQTY>`
        // NOTE: no <DISCOUNT> is emitted. Tally's <DISCOUNT> is a PERCENTAGE, but the staging
        // Discount__c is an AMOUNT (e.g. 134.59 on a 6924.72 line = 1.94%), and the staging
        // Amount__c/header total are GROSS — the discount is not deducted anywhere in Salesforce.
        // Sending the raw number would discount by 134.59%; applying it properly would make the
        // Tally voucher total disagree with the Salesforce order total. Pending a business decision.
        // Order vouchers add the line's order due date; accounting allocations stay in both cases.
        + (v.isOrder ? `<ORDERDUEDATE>${esc(dueDate)}</ORDERDUEDATE>` : '')
        // A consuming voucher (purchase/sales invoice) carries the order number it fulfils, so
        // Tally nets this quantity against that order and tracks the pending/short balance.
        + (!v.isOrder && i.orderNo ? `<ORDERNO>${esc(i.orderNo)}</ORDERNO>` : '')
        // Godown/batch allocation — emitted ONLY for non-order vouchers with a godown set. A line
        // with no godown (or ANY order voucher) produces byte-identical XML to before: single-location
        // distributors and companies without multi-godown are unaffected, and ORDER vouchers (Sales/
        // Purchase Order) are commitments with no stock movement — Tally REJECTS an order carrying a
        // BATCHALLOCATIONS block, so orders must never emit one. One godown per line -> the single
        // allocation carries the full line amount/qty.
        + ((!v.isOrder && i.godown) ? '<BATCHALLOCATIONS.LIST><GODOWNNAME>' + esc(i.godown) + '</GODOWNNAME><BATCHNAME>' + esc(i.batch || 'Primary Batch') + '</BATCHNAME><AMOUNT>' + i.amount.toFixed(2) + '</AMOUNT><ACTUALQTY>' + Math.abs(i.qty).toFixed(2) + ' ' + esc(tallyUnitSymbol(i.unit)) + '</ACTUALQTY><BILLEDQTY>' + Math.abs(i.qty).toFixed(2) + ' ' + esc(tallyUnitSymbol(i.unit)) + '</BILLEDQTY></BATCHALLOCATIONS.LIST>' : '')
        + '<ACCOUNTINGALLOCATIONS.LIST>'
        + `<LEDGERNAME>${esc(i.accountingLedger)}</LEDGERNAME>`
        + `<ISDEEMEDPOSITIVE>${i.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<AMOUNT>${i.amount.toFixed(2)}</AMOUNT>`
        + '</ACCOUNTINGALLOCATIONS.LIST>'
        + '</ALLINVENTORYENTRIES.LIST>').join('');
    const staticVars = v.company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(v.company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
    return '<ENVELOPE>'
        + '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA>'
        + `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${staticVars}</REQUESTDESC>`
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<VOUCHER ACTION="${action}" VCHTYPE="${esc(v.voucherType)}" OBJVIEW="${esc(objView)}">`
        + `<DATE>${esc(v.date)}</DATE>`
        + `<EFFECTIVEDATE>${esc(v.date)}</EFFECTIVEDATE>`
        + `<VOUCHERTYPENAME>${esc(v.voucherType)}</VOUCHERTYPENAME>`
        + (v.voucherNumber ? `<VOUCHERNUMBER>${esc(v.voucherNumber)}</VOUCHERNUMBER>` : '')
        + (v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : '')
        + (v.partyLedger ? `<PARTYLEDGERNAME>${esc(v.partyLedger)}</PARTYLEDGERNAME>` : '')
        + (v.narration ? `<NARRATION>${esc(v.narration)}</NARRATION>` : '')
        // Ship-to (consignee) details — emitted only when a customer shipping address is present, so
        // vouchers without one stay byte-identical. PLACEOFSUPPLY is GST metadata; the intra/inter
        // tax split itself is computed by the connector from the ship-to state (sfAgent).
        + (v.consigneeName ? `<BASICBUYERNAME>${esc(v.consigneeName)}</BASICBUYERNAME>` : '')
        + (v.placeOfSupply ? `<PLACEOFSUPPLY>${esc(v.placeOfSupply)}</PLACEOFSUPPLY>` : '')
        + ((v.shipToAddress && v.shipToAddress.length)
            ? '<BASICBUYERADDRESS.LIST>' + v.shipToAddress.map(l => `<BASICBUYERADDRESS>${esc(l)}</BASICBUYERADDRESS>`).join('') + '</BASICBUYERADDRESS.LIST>'
            : '')
        + entries
        + inventory
        + '</VOUCHER></TALLYMESSAGE></REQUESTDATA>'
        + '</IMPORTDATA></BODY></ENVELOPE>';
}
/** Validate a voucher before posting: entries present and debits == credits. */
export function validateVoucher(v) {
    if (!v.date || !/^\d{8}$/.test(v.date))
        return 'date must be YYYYMMDD';
    if (!v.voucherType)
        return 'voucherType required';
    const inv = v.inventoryEntries || [];
    const entries = v.entries || [];
    // Order vouchers (inventory only, no accounting) legitimately have zero ledger entries.
    const orderStyle = entries.length === 0 && inv.length > 0;
    if (!orderStyle) {
        if (entries.length < 1)
            return 'at least one ledger entry required';
        if (entries.length < 2 && !inv.length)
            return 'at least two ledger entries required (or ledger + inventory)';
    }
    for (const e of entries) {
        if (!e.ledger)
            return 'ledger entry missing ledger name';
        if (typeof e.amount !== 'number' || isNaN(e.amount))
            return `bad amount for ${e.ledger}`;
    }
    for (const i of inv) {
        if (!i.stockItem)
            return 'inventory line missing stock item';
        if (!i.unit)
            return `inventory line ${i.stockItem} missing unit`;
        if (isNaN(i.amount))
            return `bad amount for ${i.stockItem}`;
    }
    // balance = ledger postings + inventory accounting allocations must net to 0 (skip for order-only vouchers)
    if (!orderStyle) {
        const sum = entries.reduce((s, e) => s + e.amount, 0) + inv.reduce((s, i) => s + i.amount, 0);
        if (Math.abs(sum) > 0.005)
            return `voucher does not balance (sum ${sum.toFixed(2)}; debits must equal credits)`;
    }
    return null;
}
const num = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? parseInt(m[1], 10) || 0 : 0; };
/** Post a voucher to Tally. dryRun builds + validates + returns the XML without sending. */
export async function postVoucher(server, port, v, opts = {}) {
    const log = opts.log || (() => { });
    const err = validateVoucher(v);
    if (err) {
        log(`voucher invalid: ${err}`, true);
        return { ok: false, created: 0, altered: 0, errors: 1, message: err, raw: '' };
    }
    const xml = buildVoucherImportXml(v, opts.action || 'Create');
    if (opts.dryRun) {
        log(`[dry-run] would post ${v.voucherType} ${v.voucherNumber || ''} (${v.entries.length} entries):\n${xml}`);
        return { ok: true, created: 0, altered: 0, errors: 0, message: 'dry-run', raw: xml };
    }
    const resp = await postTallyXml(server, port, xml, 60000);
    const created = num(resp, 'CREATED'), altered = num(resp, 'ALTERED'), errors = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = errors === 0 && (created > 0 || altered > 0);
    log(`voucher import: created=${created} altered=${altered} errors=${errors}${lineErr ? ' — ' + lineErr : ''}`, !ok);
    return { ok, created, altered, errors, message: lineErr || (ok ? 'ok' : 'no voucher created'), raw: resp };
}
// --- master prerequisite: ensure a ledger exists before a voucher references it ---
export async function ledgerExists(server, port, name) {
    try {
        const xml = buildFetchXmlFiltered('ledger', 'NAME', nameFilter([name]), {});
        const { rows } = parseCollection(await postTallyXml(server, port, xml, 20000), 'ledger');
        return rows.some(r => (r.name || '').toLowerCase() === name.toLowerCase());
    }
    catch {
        return false;
    }
}
/** Create a ledger under a group via Import (masters). */
export async function createLedger(server, port, name, parentGroup) {
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(parentGroup)}</PARENT></LEDGER>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const created = num(resp, 'CREATED'), errors = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    return { ok: errors === 0 && created > 0, created, altered: 0, errors, message: lineErr || 'ok', raw: resp };
}
/** Ensure a ledger exists (create under parentGroup if missing). Returns true if present/created. */
export async function ensureLedger(server, port, name, parentGroup, log) {
    if (await ledgerExists(server, port, name))
        return true;
    log === null || log === void 0 ? void 0 : log(`ledger '${name}' missing — creating under '${parentGroup}'`);
    const r = await createLedger(server, port, name, parentGroup);
    if (!r.ok)
        log === null || log === void 0 ? void 0 : log(`failed to create ledger '${name}': ${r.message}`, true);
    return r.ok;
}
//# sourceMappingURL=tallyImport.mjs.map