import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfQuery, sfUpdate, sfUpsert } from './sfClient.mjs';
import { postVoucher, ensureLedger } from './tallyImport.mjs';
import { ensureStockItem, readStockItemKeys, resolveDefaultGodown } from './tallyMaster.mjs';
import { computeGstEntries, ensureGstLedgers, loadGstConfig, loadProductGstRates, loadDistributorState, loadPartyStates } from './gst.mjs';
import { fetchFilteredCollection, postTallyXml, describeError } from './tallyLive.mjs';
import { logToTrigger } from './sfLog.mjs';
import { saveWatermark, stampRun } from './sfConfig.mjs';
export const SPECS = {
    Invoice: { objectType: 'Invoice', stagingObject: 'Tally_Invoice__c', externalId: 'Tally_Guid__c', voucherTypes: ['Sales'], lineObject: 'Tally_Invoice_Line__c', lineParentRel: 'Invoice__r' },
    Purchase: { objectType: 'Purchase', stagingObject: 'Tally_Purchase__c', externalId: 'Tally_Guid__c', voucherTypes: ['Purchase'], lineObject: 'Tally_Purchase_Line__c', lineParentRel: 'Purchase__r' },
    Order: { objectType: 'Order', stagingObject: 'Tally_Order__c', externalId: 'Tally_Guid__c', voucherTypes: ['Sales Order', 'Purchase Order'], lineObject: 'Tally_Order_Line__c', lineParentRel: 'Order__r' },
    Note: { objectType: 'Note', stagingObject: 'Tally_Note__c', externalId: 'Tally_Guid__c', voucherTypes: ['Credit Note', 'Debit Note'], noteType: true, lineObject: 'Tally_Note_Line__c', lineParentRel: 'Note__r' },
    // Primary purchase order (Morde -> distributor). Dedicated object, kept apart from the
    // secondary sales-order machinery on Tally_Order__c (which has its own writeback trigger).
    PurchaseOrder: { objectType: 'PurchaseOrder', stagingObject: 'Tally_Purchase_Order__c', externalId: 'Tally_Guid__c', voucherTypes: ['Purchase Order'], lineObject: 'Tally_Purchase_Order_Line__c', lineParentRel: 'Purchase_Order__r' },
};
// ---- Inventory line-item parsing ----
// Tally returns inventory lines as parallel, '; '-joined values on the parent voucher row
// (e.g. stockitemname="A; B", actualqty="10 MT; 5 MT"). We split them back into one row per item.
const INV = 'allinventoryentries.list';
const splitMulti = (v) => (v == null || v === '') ? [] : String(v).split('; ');
const toNum = (v) => { if (v == null || v === '')
    return null; const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; };
/** "90.00 MT" -> { qty: 90, unit: 'MT' }; "35000.00/MT" (rate) -> 35000 via toRate. */
function parseQty(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(-?[\d.,]+)\s*(.*)$/);
    return m ? { qty: toNum(m[1]), unit: (m[2] || '').trim() } : { qty: null, unit: '' };
}
const toRate = (v) => toNum(String(v || '').split('/')[0]);
/**
 * Read the Stock Item master and build a `stock item name -> Morde SAP Id` map. The SAP Id
 * lives on the stock item master (Part Number by default), NOT on the voucher line, so we read
 * it each cycle and join by name. Which Tally field holds it is mapping-driven (editable per
 * distributor): a Field_Mapping row Object_Type='StockItem', target 'Product_SAP_Id__c'.
 */
export async function loadStockItemSapIds(server, port, sapId, log) {
    // SAP Id lives in the MordeSAPID UDF (the standard), which only projects via COMPUTE — a plain
    // FETCH silently drops it. readStockItemKeys reads it correctly. Only SAP-tagged items matter.
    const out = new Map();
    try {
        const keys = await readStockItemKeys(server, port, { sapTaggedOnly: true });
        for (const k of keys)
            if (k.name && k.sapId)
                out.set(k.name.toLowerCase(), k.sapId);
        log(`  stock-item SAP ids: ${out.size} mapped (from MordeSAPID UDF)`);
    }
    catch (e) {
        log(`  stock-item master read failed — ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
    }
    return out;
}
/** Build child line records for one voucher row (empty if no inventory). Parent set by external id. */
function buildLines(spec, row, sapId, companyCode, itemSap) {
    const names = splitMulti(row[`${INV}.stockitemname`]);
    if (!names.length)
        return [];
    const qty = splitMulti(row[`${INV}.actualqty`]);
    const rate = splitMulti(row[`${INV}.rate`]);
    const disc = splitMulti(row[`${INV}.discount`]);
    const amt = splitMulti(row[`${INV}.amount`]);
    const ledger = splitMulti(row[`${INV}.accountingallocations.list.ledgername`]);
    // Godown/batch per line (inbound capture). NOTE: the flattener joins ALL batch-allocation values
    // across the whole voucher under one path, so these index-align with inventory lines only when
    // every line has exactly one allocation (the one-godown-per-line model). A mixed voucher (some
    // lines with no allocation) would misalign; see the report's inbound caveat.
    const godown = splitMulti(row[`${INV}.batchallocations.list.godownname`]);
    const batch = splitMulti(row[`${INV}.batchallocations.list.batchname`]);
    return names.map((name, i) => {
        const q = parseQty(qty[i]);
        return {
            Tally_Line_Key__c: `${row.guid}#${i + 1}`,
            [spec.lineParentRel]: { [spec.externalId]: row.guid },
            Stock_Item__c: name,
            Product_SAP_Id__c: itemSap.get(name.toLowerCase()) || '', // Morde SAP Id from stock-item master
            Quantity__c: q.qty, Unit__c: q.unit,
            Rate__c: toRate(rate[i]), Discount__c: toNum(disc[i]), Amount__c: toNum(amt[i]),
            Accounting_Ledger__c: ledger[i] || '',
            Godown__c: godown[i] || undefined, Batch__c: batch[i] || undefined,
            Line_No__c: i + 1, SAP_Id__c: sapId, SAP_Company_Code__c: companyCode,
        };
    });
}
/** Fields the connector always reads regardless of mapping (idempotency + watermark + traceability). */
const SYSTEM_FETCH = ['GUID', 'ALTERID', 'VOUCHERNUMBER', 'DATE', 'VOUCHERTYPENAME'];
// Always fetch the per-line godown/batch so inbound vouchers can capture warehouse allocation even
// when a distributor hasn't mapped these fields (they come back flattened as `${INV}.batchallocations.list.*`).
const INV_FETCH = ['ALLINVENTORYENTRIES.LIST.BATCHALLOCATIONS.LIST.GODOWNNAME', 'ALLINVENTORYENTRIES.LIST.BATCHALLOCATIONS.LIST.BATCHNAME'];
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
    const maps = (await loadMappings(spec.objectType, 'ToSalesforce', acct.sapId)).map(m => { var _a; return ({ ...m, source: (_a = m.source) === null || _a === void 0 ? void 0 : _a.toLowerCase() }); });
    if (!maps.length) {
        log(`[agent] no active ToSalesforce mappings for ${spec.objectType} — nothing to do`, true);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', errorMessage: 'no active mappings', startedAt });
        return res;
    }
    const fetchList = [...new Set([...SYSTEM_FETCH, ...INV_FETCH, ...maps.filter(m => m.source).map(m => m.source.toUpperCase())])].join(',');
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
            SAP_Id__c: acct.sapId, // new distributor identity
            SAP_Company_Code__c: acct.companyCode, // deprecated, still populated for existing consumers
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
    // Inventory line items (product / qty / rate) -> child rows, parent linked by external id.
    // Load the stock-item name -> Morde SAP Id map once (from the Tally stock-item master).
    const itemSap = spec.lineObject ? await loadStockItemSapIds(server, port, acct.sapId, log) : new Map();
    const lineRecords = spec.lineObject ? clean.flatMap(row => buildLines(spec, row, acct.sapId, acct.companyCode, itemSap)) : [];
    if (opts.dryRun) {
        log(`[agent] ${spec.objectType}: dry-run — would upsert ${records.length} rows + ${lineRecords.length} line items (watermark -> ${res.newWatermark})`);
        log(`  sample: ${JSON.stringify(records[0]).slice(0, 500)}`);
        if (lineRecords.length)
            log(`  line sample: ${JSON.stringify(lineRecords[0]).slice(0, 400)}`);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', responseBody: `dry-run ${records.length} rows, ${lineRecords.length} lines`, startedAt });
        return res;
    }
    const up = await sfUpsert(spec.stagingObject, spec.externalId, records, (m, e) => log('  ' + m, e));
    res.upserted = up.success;
    res.failed = up.failed;
    res.errors.push(...up.errors);
    // Write line items after the parent headers exist (parent resolved by external id).
    if (spec.lineObject && lineRecords.length) {
        const lu = await sfUpsert(spec.lineObject, 'Tally_Line_Key__c', lineRecords, (m, e) => log('  ' + m, e));
        if (lu.failed)
            res.errors.push(...lu.errors.map(e => `line: ${e}`));
        log(`  ${spec.lineObject}: upserted ${lu.success} line items, failed ${lu.failed}`);
    }
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
    Invoice: { voucherType: 'Sales', counterLedgerDefault: 'Sales', partySign: -1, qtySign: -1, taxSide: 'output', partyGroup: 'Sundry Debtors', counterGroup: 'Sales Accounts' },
    Purchase: { voucherType: 'Purchase', counterLedgerDefault: 'Purchase', partySign: 1, qtySign: 1, taxSide: 'input', partyGroup: 'Sundry Creditors', counterGroup: 'Purchase Accounts' },
    // Credit Note: a SALES-side document (Output GST, Sales counter) — customer credited (reduce
    // receivable, partySign:1), goods come back in (qtySign:1).
    CreditNote: { voucherType: 'Credit Note', counterLedgerDefault: 'Sales', partySign: 1, qtySign: 1, taxSide: 'output', partyGroup: 'Sundry Debtors', counterGroup: 'Sales Accounts' },
    // Debit Note: a PURCHASE-side document (Input GST, Purchase counter) — supplier debited (reduce
    // payable, partySign:-1), goods go back out (qtySign:-1).
    DebitNote: { voucherType: 'Debit Note', counterLedgerDefault: 'Purchase', partySign: -1, qtySign: -1, taxSide: 'input', partyGroup: 'Sundry Creditors', counterGroup: 'Purchase Accounts' },
    // Sales Order: inventory-only order voucher, NO accounting impact (needs Order Processing in Tally).
    Order: { voucherType: 'Sales Order', counterLedgerDefault: 'Sales', partySign: -1, qtySign: 1, taxSide: 'output', partyGroup: 'Sundry Debtors', counterGroup: 'Sales Accounts', order: true },
    // Primary purchase order (Morde -> distributor): a purchase-side order, party = the Morde
    // supplier ledger. No financial impact (order voucher); just records the commitment so the
    // later primary-purchase invoice can net against it (order tracking).
    PurchaseOrder: { voucherType: 'Purchase Order', counterLedgerDefault: 'Purchase', partySign: 1, qtySign: 1, taxSide: 'input', partyGroup: 'Sundry Creditors', counterGroup: 'Purchase Accounts', order: true },
};
/** Resolve the accounting rule for a staging object; Note branches on its Credit/Debit type. */
function ruleFor(objectType, logical) {
    if (objectType === 'Note')
        return String(logical.noteType || '').toLowerCase().includes('debit') ? TO_TALLY_RULES.DebitNote : TO_TALLY_RULES.CreditNote;
    return TO_TALLY_RULES[objectType];
}
export function assembleVoucher(objectType, logical, lines, itemBySap, gst, defaultGodown = '') {
    const rule = ruleFor(objectType, logical);
    if (!rule)
        return `no ToTally rule for ${objectType} (SF->Tally not supported for this type yet)`;
    if (!logical.party)
        return 'missing party';
    if (!/^\d{8}$/.test(String(logical.date || '')))
        return `bad date '${logical.date}' (need YYYYMMDD)`;
    const party = String(logical.party);
    const num = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
    // The voucher type comes from staging (mapping), so SF->Tally recreates the SAME type that
    // Tally->SF read. For orders, the accounting side follows the type (Purchase Order behaves
    // like a purchase, Sales Order like a sale) rather than a hard-coded default.
    const voucherType = String(logical.voucherType || rule.voucherType);
    // Two INDEPENDENT notions of "purchase side":
    //  - signIsPurchase drives the accounting/stock SIGNS (party debit/credit, inward/outward qty).
    //    For orders it follows the voucher type; otherwise it follows partySign. Preserves the
    //    correct signs for all 5 types (incl. CreditNote:+/+ and DebitNote:-/-).
    //  - docIsPurchase drives the DOCUMENT/TAX side (Input vs Output GST + counter default) via
    //    rule.taxSide. A Credit Note is a sales document (Output) despite partySign:1; a Debit Note
    //    is a purchase document (Input) despite partySign:-1 — so this must NOT be derived from the
    //    sign. For orders both booleans equal the voucher-type test.
    const signIsPurchase = rule.order ? /purchase/i.test(voucherType) : rule.partySign > 0;
    const docIsPurchase = rule.order ? /purchase/i.test(voucherType) : rule.taxSide === 'input';
    const partySign = signIsPurchase ? 1 : -1;
    const qtySign = signIsPurchase ? 1 : -1;
    const counter = String(logical.counterLedger || (docIsPurchase ? 'Purchase' : 'Sales'));
    const inventoryEntries = [];
    const gstLines = [];
    let lineTotal = 0;
    for (const ln of lines) {
        const sap = String(ln.productSapId || '').toLowerCase();
        const resolved = sap && itemBySap.get(sap);
        const stockItem = resolved ? resolved.name : String(ln.stockItem || '');
        if (!stockItem)
            return `line has no resolvable stock item (SAP Id '${ln.productSapId || ''}' not found, no name)`;
        const qty = Math.abs(num(ln.qty));
        const amt = Math.abs(num(ln.amount));
        const unit = String(ln.unit || (resolved ? resolved.unit : '') || '');
        lineTotal += amt;
        if (gst)
            gstLines.push({ base: amt, rate: gst.rateBySap.get(sap) || 0 });
        inventoryEntries.push({
            stockItem, unit, qty: qtySign * qty, rate: num(ln.rate),
            amount: -partySign * amt, // opposite side of the party posting
            accountingLedger: String(ln.ledger || counter),
            // A per-line order number wins; otherwise the voucher-level order reference. Only
            // meaningful on a consuming voucher (not the order itself) — buildVoucherImportXml
            // drops it when isOrder.
            orderNo: ln.orderNo ? String(ln.orderNo) : (logical.orderRef ? String(logical.orderRef) : undefined),
            // Per-line warehouse: explicit Godown__c wins; else the company default (set only when
            // multi-godown is enabled — Tally then REQUIRES an allocation on every line); else ''
            // (single-location company) -> buildVoucherImportXml emits no allocation (unchanged XML).
            // Batch defaults to 'Primary Batch' at XML build time when a godown is present.
            godown: (ln.godown ? String(ln.godown) : (defaultGodown || '')) || undefined,
            batch: ln.batch ? String(ln.batch) : undefined,
        });
    }
    const total = lines.length ? lineTotal : Math.abs(num(logical.amount));
    if (!total)
        return 'missing/zero amount';
    // GST: compute tax on the goods lines and post it into this company's GST ledgers (Output for a
    // sale, Input for a purchase). Orders carry no accounting, so no tax. Tally does NOT auto-calc on
    // XML import, so we add the amounts; the party balance rises by the tax.
    let taxEntries = [];
    let totalTax = 0;
    if (gst && !rule.order && inventoryEntries.length) {
        // Ledger set follows the document/tax side (docIsPurchase); the posting sign follows the
        // accounting side (-partySign) so the tax sits opposite the party, same side as inventory.
        const g = computeGstEntries(gstLines, { intra: gst.intra, isPurchase: docIsPurchase, sign: (-partySign), cfg: gst.cfg });
        if (g.error)
            return `GST: ${g.error}`;
        taxEntries = g.entries;
        totalTax = g.totalTax;
    }
    const partyAmt = partySign * (total + totalTax);
    const entries = [{ ledger: party, amount: partyAmt }, ...taxEntries];
    if (!lines.length)
        entries.push({ ledger: counter, amount: -partyAmt }); // no inventory -> plain 2-line accounting voucher
    return {
        date: String(logical.date), voucherType, partyLedger: party,
        voucherNumber: logical.number ? String(logical.number) : undefined,
        narration: logical.narration ? String(logical.narration) : undefined,
        entries, inventoryEntries: inventoryEntries.length ? inventoryEntries : undefined,
        // Order vouchers need a reference (the order number) + a per-line order due date.
        ...(rule.order ? { isOrder: true, reference: logical.number ? String(logical.number) : undefined, orderDueDate: String(logical.date) } : {}),
    };
}
/** Reverse product map: Morde SAP Id -> the distributor's Tally stock item (name + base unit).
 *  Reads the MordeSAPID UDF (via COMPUTE) like loadStockItemSapIds. */
async function loadStockItemBySap(server, port, sapId, log) {
    const out = new Map();
    try {
        const keys = await readStockItemKeys(server, port, { sapTaggedOnly: true });
        for (const k of keys)
            if (k.sapId && k.name)
                out.set(k.sapId.toLowerCase(), { name: k.name, unit: k.unit || '' });
    }
    catch (e) {
        log(`  stock-item reverse map failed — ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
    }
    return out;
}
/** Read Pending line-item rows for the given header Ids, grouped by parent header Id. */
async function loadPendingLines(spec, headerIds, sapId, log) {
    const out = new Map();
    if (!spec.lineObject || !headerIds.length)
        return out;
    const parentField = spec.lineParentRel.replace('__r', '__c'); // e.g. 'Invoice__r' -> 'Invoice__c'
    const ids = headerIds.map(i => `'${i}'`).join(',');
    try {
        const rows = await sfQuery(`SELECT ${parentField}, Product_SAP_Id__c, Stock_Item__c, Quantity__c, Unit__c, Rate__c, Amount__c, Accounting_Ledger__c, Godown__c, Batch__c ` +
            `FROM ${spec.lineObject} WHERE ${parentField} IN (${ids}) ORDER BY Line_No__c NULLS LAST`);
        for (const r of rows) {
            const pid = r[parentField];
            if (!pid)
                continue;
            const arr = out.get(pid) || [];
            arr.push({ productSapId: r.Product_SAP_Id__c, stockItem: r.Stock_Item__c, qty: r.Quantity__c, unit: r.Unit__c, rate: r.Rate__c, amount: r.Amount__c, ledger: r.Accounting_Ledger__c, godown: r.Godown__c, batch: r.Batch__c });
            out.set(pid, arr);
        }
    }
    catch (e) {
        log(`  line read failed — ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
    }
    return out;
}
/** Best-effort: after a voucher is created, read its Tally GUID back so the staging record carries
 *  the permanent Tally key (hard SF<->Tally identity, alongside the shared reference). Keyed on the
 *  number/reference we sent; short timeout, and NEVER throws — a failed lookup just means no GUID. */
async function lookupVoucherGuid(server, port, spec, v) {
    const key = v.voucherNumber || v.reference;
    if (!key)
        return '';
    try {
        const typeFilter = spec.voucherTypes.map(vt => `$VoucherTypeName = ${qstr(vt)}`).join(' OR ');
        const k = qstr(String(key));
        const filter = `(${typeFilter}) AND ($VoucherNumber = ${k} OR $Reference = ${k})`;
        // Wide date range so the voucher is in scope regardless of the company's current period
        // (a voucher collection otherwise defaults to the current date and misses it).
        const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MordeVGuid</ID></HEADER>'
            + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
            + '<SVFROMDATE>19000101</SVFROMDATE><SVTODATE>29991231</SVTODATE></STATICVARIABLES>'
            + '<TDL><TDLMESSAGE><COLLECTION NAME="MordeVGuid" ISMODIFY="No" ISINITIALIZE="Yes">'
            + '<TYPE>Voucher</TYPE><FILTER>vg</FILTER><FETCH>GUID,VOUCHERNUMBER,REFERENCE</FETCH></COLLECTION>'
            + `<SYSTEM TYPE="Formula" NAME="vg">${filter}</SYSTEM>`
            + '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
        const resp = await postTallyXml(server, port, xml, 15000);
        return (resp.match(/<GUID[^>]*>([^<]+)<\/GUID>/i) || [])[1] || '';
    }
    catch {
        return '';
    }
}
/** One Salesforce -> Tally run for a single object type: create Tally vouchers from
 *  Pending staging rows flagged Direction=ToTally (with their line items), then write status back. */
export async function syncToTally(spec, acct, server, port, opts = {}) {
    const log = opts.log || (() => { });
    const startedAt = new Date();
    log(`[agent] ${spec.objectType} SF->Tally: starting${opts.dryRun ? ' (dry-run)' : ''}`);
    if (!['Invoice', 'Purchase', 'Order', 'Note', 'PurchaseOrder'].includes(spec.objectType)) {
        log(`[agent] SF->Tally not supported for ${spec.objectType} yet`, true);
        return { pending: 0, created: 0, failed: 0, errors: [`no rule for ${spec.objectType}`] };
    }
    const maps = await loadMappings(spec.objectType, 'ToTally', acct.sapId);
    if (!maps.length) {
        log(`[agent] no active ToTally mappings for ${spec.objectType} — nothing to do`, true);
        return { pending: 0, created: 0, failed: 0, errors: ['no mappings'] };
    }
    const sourceFields = [...new Set(maps.filter(m => m.source).map(m => m.source))];
    const soql = `SELECT Id, ${sourceFields.join(', ')} FROM ${spec.stagingObject} ` +
        `WHERE Direction__c = 'ToTally' AND Sync_Status__c = 'Pending' AND SAP_Id__c = '${acct.sapId.replace(/'/g, "\\'")}'`;
    const rows = await sfQuery(soql);
    log(`[agent] ${spec.objectType}: ${rows.length} pending staging rows`);
    const res = { pending: rows.length, created: 0, failed: 0, errors: [] };
    if (!rows.length) {
        await logToTrigger({ operation: `SF->Tally ${spec.objectType}`, objectName: spec.stagingObject, status: 'Success', responseBody: '0 pending', startedAt });
        log(`[agent] ${spec.objectType} SF->Tally: nothing pending`);
        return res;
    }
    // Load line items for these headers (grouped by parent) + the reverse product map.
    const linesByParent = await loadPendingLines(spec, rows.map(r => r.Id), acct.sapId, log);
    const itemBySap = spec.lineObject ? await loadStockItemBySap(server, port, acct.sapId, log) : new Map();
    // Resolve the company's default godown ONCE per run. Non-empty only when multi-godown is enabled
    // (Tally then rejects any inventory line with no allocation); '' leaves single-location companies
    // byte-identical. Only relevant for inventory vouchers (those with line items).
    const defaultGodown = spec.lineObject ? await resolveDefaultGodown(server, port) : '';
    if (defaultGodown)
        log(`[agent] multi-godown company — defaulting un-godowned lines to '${defaultGodown}'`);
    // GST context (per distributor): ledger names + product rates + state codes for intra/inter.
    // Only invoices/purchases/notes carry tax; orders have no accounting side.
    const taxable = ['Invoice', 'Purchase', 'Note'].includes(spec.objectType);
    let gstCfg = {};
    let rateBySap = new Map();
    let distState = '';
    let partyStates = new Map();
    if (taxable) {
        gstCfg = await loadGstConfig(acct.sapId);
        rateBySap = await loadProductGstRates(acct.id);
        distState = await loadDistributorState(acct.id);
        partyStates = await loadPartyStates(acct.id);
        log(`[agent] GST: ${Object.values(gstCfg).filter(Boolean).length} ledger(s), ${rateBySap.size} product rate(s), distributor state '${distState || '?'}'`);
        // BUG 2: a blank distributor state silently forces intra() = true for EVERY voucher (see the
        // intra calc below), so inter-state sales can never emit IGST — a silent mis-taxation risk.
        // Warn once per run; the data fix (set the distributor Account's state) is out of scope here.
        if (!distState)
            log(`[agent] GST WARNING: distributor state is blank — every voucher will be taxed INTRA-state (CGST+SGST); inter-state sales will NOT produce IGST. Set the distributor Account's state.`, true);
        // Ensure our standard GST ledgers exist and are correctly classified (create if missing).
        if (!opts.dryRun) {
            const gErr = await ensureGstLedgers(server, port, gstCfg, (m, e) => log('  ' + m, e));
            if (gErr)
                log(`[agent] GST ledger setup: ${gErr}`, true);
        }
    }
    // BUG 4: collect goods lines on taxable vouchers whose resolved GST rate is 0 (product missing
    // GST_Percentage__c) — those post with NO tax and no signal. Aggregated into one warning per run.
    const zeroRateItems = new Set();
    for (const row of rows) {
        const logical = applyMapping(row, maps);
        let gstCtx;
        if (taxable) {
            const partySt = partyStates.get(String(logical.party || '').trim().toLowerCase()) || '';
            const intra = !distState || !partySt || distState === partySt; // default to intra when a state is unknown
            gstCtx = { rateBySap, intra, cfg: gstCfg };
            for (const ln of (linesByParent.get(row.Id) || [])) {
                const sap = String(ln.productSapId || '').trim().toLowerCase();
                if (!(rateBySap.get(sap) || 0))
                    zeroRateItems.add(String(ln.productSapId || ln.stockItem || '(unknown item)'));
            }
        }
        const built = assembleVoucher(spec.objectType, logical, linesByParent.get(row.Id) || [], itemBySap, gstCtx, defaultGodown);
        if (typeof built === 'string') {
            res.failed++;
            res.errors.push(`${row.Id}: ${built}`);
            if (!opts.dryRun)
                await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: built }).catch(() => { });
            log(`  ${row.Id}: invalid - ${built}`, true);
            continue;
        }
        // Master prerequisites: every ledger and stock item the voucher references MUST exist in
        // this distributor's Tally, or the import fails with a cryptic error. So create any that are
        // missing first (party + accounting/counter ledgers, and each inventory stock item). If a
        // master genuinely cannot be created, fail the voucher cleanly with a clear reason rather
        // than posting a doomed one. (The full account/product master sync creates these properly
        // with SAP Id/GST; this is the per-voucher safety net.)
        const rule = ruleFor(spec.objectType, logical);
        let masterErr = '';
        if (!opts.dryRun) {
            if (built.partyLedger && !(await ensureLedger(server, port, built.partyLedger, rule.partyGroup, log)))
                masterErr = `party ledger '${built.partyLedger}' is missing and could not be created`;
            // Auto-create only the counter/accounting ledgers (Sales/Purchase) — NOT the GST tax
            // ledgers. GST ledgers are accountant-configured (correct tax classification); creating
            // one bare would corrupt GST returns. If a configured GST ledger is missing, let the
            // import fail loudly instead.
            const counters = new Set();
            (built.inventoryEntries || []).forEach(i => { if (i.accountingLedger)
                counters.add(i.accountingLedger); });
            if (!built.inventoryEntries && built.entries[1])
                counters.add(built.entries[1].ledger); // plain 2-line voucher's counter
            for (const c of counters)
                if (!masterErr && c && !(await ensureLedger(server, port, c, rule.counterGroup, log)))
                    masterErr = `ledger '${c}' is missing and could not be created`;
            for (const inv of (built.inventoryEntries || []))
                if (!masterErr && !(await ensureStockItem(server, port, inv.stockItem, inv.unit, log)))
                    masterErr = `stock item '${inv.stockItem}' is missing and could not be created`;
        }
        if (masterErr) {
            res.failed++;
            res.errors.push(`${row.Id}: ${masterErr}`);
            if (!opts.dryRun)
                await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: masterErr }).catch(() => { });
            log(`  ${row.Id}: ${masterErr}`, true);
            continue;
        }
        const pr = await postVoucher(server, port, built, { dryRun: opts.dryRun, log: (m, e) => log('  ' + m, e) });
        if (pr.ok) {
            res.created++;
            if (!opts.dryRun) {
                const guid = await lookupVoucherGuid(server, port, spec, built);
                const fields = { Sync_Status__c: 'Done', Error__c: '', Tally_Voucher_Number__c: built.voucherNumber || '' };
                if (guid)
                    fields.Tally_Guid__c = guid; // permanent Tally key (best-effort)
                await sfUpdate(spec.stagingObject, row.Id, fields).catch(() => { });
            }
        }
        else {
            res.failed++;
            res.errors.push(`${row.Id}: ${pr.message}`);
            if (!opts.dryRun)
                await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: pr.message.slice(0, 32000) }).catch(() => { });
        }
    }
    if (zeroRateItems.size)
        log(`[agent] GST WARNING: ${zeroRateItems.size} item(s) on taxable vouchers resolved to a 0% GST rate (product missing GST_Percentage__c) and posted with NO tax: ${[...zeroRateItems].join(', ')}. Set GST_Percentage__c on these products.`, true);
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