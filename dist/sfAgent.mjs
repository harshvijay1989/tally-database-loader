import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfQuery, sfUpdate, sfUpsert } from './sfClient.mjs';
import { postVoucher, ensureLedger } from './tallyImport.mjs';
import { ensureStockItem } from './tallyMaster.mjs';
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
export async function loadStockItemSapIds(server, port, sapCode, log) {
    const maps = await loadMappings('StockItem', 'ToSalesforce', sapCode);
    const m = maps.find(x => x.target === 'Product_SAP_Id__c' && x.source);
    const sourceField = ((m === null || m === void 0 ? void 0 : m.source) || 'partno').toLowerCase(); // default: Tally Part Number
    const out = new Map();
    try {
        const { rows } = await fetchFilteredCollection(server, port, 'StockItem', `NAME,${sourceField.toUpperCase()}`, '$AlterID &gt; 0', {}, 60000);
        for (const r of rows) {
            const name = String(r.name || '').trim();
            const sap = String(r[sourceField] || '').trim();
            if (name && sap)
                out.set(name.toLowerCase(), sap);
        }
        log(`  stock-item SAP ids: ${out.size} mapped (from '${sourceField}')`);
    }
    catch (e) {
        log(`  stock-item master read failed — ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
    }
    return out;
}
/** Build child line records for one voucher row (empty if no inventory). Parent set by external id. */
function buildLines(spec, row, sapCode, itemSap) {
    const names = splitMulti(row[`${INV}.stockitemname`]);
    if (!names.length)
        return [];
    const qty = splitMulti(row[`${INV}.actualqty`]);
    const rate = splitMulti(row[`${INV}.rate`]);
    const disc = splitMulti(row[`${INV}.discount`]);
    const amt = splitMulti(row[`${INV}.amount`]);
    const ledger = splitMulti(row[`${INV}.accountingallocations.list.ledgername`]);
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
            Line_No__c: i + 1, SAP_Company_Code__c: sapCode,
        };
    });
}
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
    const maps = (await loadMappings(spec.objectType, 'ToSalesforce', acct.sapCode)).map(m => { var _a; return ({ ...m, source: (_a = m.source) === null || _a === void 0 ? void 0 : _a.toLowerCase() }); });
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
    // Inventory line items (product / qty / rate) -> child rows, parent linked by external id.
    // Load the stock-item name -> Morde SAP Id map once (from the Tally stock-item master).
    const itemSap = spec.lineObject ? await loadStockItemSapIds(server, port, acct.sapCode, log) : new Map();
    const lineRecords = spec.lineObject ? clean.flatMap(row => buildLines(spec, row, acct.sapCode, itemSap)) : [];
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
    Invoice: { voucherType: 'Sales', counterLedgerDefault: 'Sales', partySign: -1, qtySign: -1, partyGroup: 'Sundry Debtors', counterGroup: 'Sales Accounts' },
    Purchase: { voucherType: 'Purchase', counterLedgerDefault: 'Purchase', partySign: 1, qtySign: 1, partyGroup: 'Sundry Creditors', counterGroup: 'Purchase Accounts' },
    // Credit Note: customer credited (reduce receivable), goods come back in.
    CreditNote: { voucherType: 'Credit Note', counterLedgerDefault: 'Sales', partySign: 1, qtySign: 1, partyGroup: 'Sundry Debtors', counterGroup: 'Sales Accounts' },
    // Debit Note: supplier debited (reduce payable), goods go back out.
    DebitNote: { voucherType: 'Debit Note', counterLedgerDefault: 'Purchase', partySign: -1, qtySign: -1, partyGroup: 'Sundry Creditors', counterGroup: 'Purchase Accounts' },
    // Sales Order: inventory-only order voucher, NO accounting impact (needs Order Processing in Tally).
    Order: { voucherType: 'Sales Order', counterLedgerDefault: 'Sales', partySign: -1, qtySign: 1, partyGroup: 'Sundry Debtors', counterGroup: 'Sales Accounts', order: true },
    // Primary purchase order (Morde -> distributor): a purchase-side order, party = the Morde
    // supplier ledger. No financial impact (order voucher); just records the commitment so the
    // later primary-purchase invoice can net against it (order tracking).
    PurchaseOrder: { voucherType: 'Purchase Order', counterLedgerDefault: 'Purchase', partySign: 1, qtySign: 1, partyGroup: 'Sundry Creditors', counterGroup: 'Purchase Accounts', order: true },
};
/** Resolve the accounting rule for a staging object; Note branches on its Credit/Debit type. */
function ruleFor(objectType, logical) {
    if (objectType === 'Note')
        return String(logical.noteType || '').toLowerCase().includes('debit') ? TO_TALLY_RULES.DebitNote : TO_TALLY_RULES.CreditNote;
    return TO_TALLY_RULES[objectType];
}
/**
 * Build a balanced VoucherInput from mapped header fields + line items, or return an error.
 * Line stock items are resolved to the distributor's Tally item name via SAP Id (itemBySap),
 * falling back to the line's own stock item name. When lines exist the party amount is derived
 * from the line total, so the voucher always balances.
 */
export function assembleVoucher(objectType, logical, lines, itemBySap) {
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
    const isPurchaseSide = rule.order ? /purchase/i.test(voucherType) : rule.partySign > 0;
    const partySign = isPurchaseSide ? 1 : -1;
    const qtySign = isPurchaseSide ? 1 : -1;
    const counter = String(logical.counterLedger || (isPurchaseSide ? 'Purchase' : 'Sales'));
    const inventoryEntries = [];
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
        inventoryEntries.push({
            stockItem, unit, qty: qtySign * qty, rate: num(ln.rate),
            amount: -partySign * amt, // opposite side of the party posting
            accountingLedger: String(ln.ledger || counter),
            // A per-line order number wins; otherwise the voucher-level order reference. Only
            // meaningful on a consuming voucher (not the order itself) — buildVoucherImportXml
            // drops it when isOrder.
            orderNo: ln.orderNo ? String(ln.orderNo) : (logical.orderRef ? String(logical.orderRef) : undefined),
        });
    }
    const total = lines.length ? lineTotal : Math.abs(num(logical.amount));
    if (!total)
        return 'missing/zero amount';
    const partyAmt = partySign * total;
    const entries = [{ ledger: party, amount: partyAmt }];
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
 *  Mirror of loadStockItemSapIds — same mapping-driven source field (Part Number by default). */
async function loadStockItemBySap(server, port, sapCode, log) {
    const maps = await loadMappings('StockItem', 'ToSalesforce', sapCode);
    const m = maps.find(x => x.target === 'Product_SAP_Id__c' && x.source);
    const src = ((m === null || m === void 0 ? void 0 : m.source) || 'partno').toLowerCase();
    const out = new Map();
    try {
        const { rows } = await fetchFilteredCollection(server, port, 'StockItem', `NAME,BASEUNITS,${src.toUpperCase()}`, '$AlterID &gt; 0', {}, 60000);
        for (const r of rows) {
            const sap = String(r[src] || '').trim();
            if (r.name && sap)
                out.set(sap.toLowerCase(), { name: String(r.name).trim(), unit: String(r.baseunits || '').trim() });
        }
    }
    catch (e) {
        log(`  stock-item reverse map failed — ${(e === null || e === void 0 ? void 0 : e.message) || e}`, true);
    }
    return out;
}
/** Read Pending line-item rows for the given header Ids, grouped by parent header Id. */
async function loadPendingLines(spec, headerIds, sapCode, log) {
    const out = new Map();
    if (!spec.lineObject || !headerIds.length)
        return out;
    const parentField = spec.lineParentRel.replace('__r', '__c'); // e.g. 'Invoice__r' -> 'Invoice__c'
    const ids = headerIds.map(i => `'${i}'`).join(',');
    try {
        const rows = await sfQuery(`SELECT ${parentField}, Product_SAP_Id__c, Stock_Item__c, Quantity__c, Unit__c, Rate__c, Amount__c, Accounting_Ledger__c ` +
            `FROM ${spec.lineObject} WHERE ${parentField} IN (${ids}) ORDER BY Line_No__c NULLS LAST`);
        for (const r of rows) {
            const pid = r[parentField];
            if (!pid)
                continue;
            const arr = out.get(pid) || [];
            arr.push({ productSapId: r.Product_SAP_Id__c, stockItem: r.Stock_Item__c, qty: r.Quantity__c, unit: r.Unit__c, rate: r.Rate__c, amount: r.Amount__c, ledger: r.Accounting_Ledger__c });
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
    if (!rows.length) {
        await logToTrigger({ operation: `SF->Tally ${spec.objectType}`, objectName: spec.stagingObject, status: 'Success', responseBody: '0 pending', startedAt });
        log(`[agent] ${spec.objectType} SF->Tally: nothing pending`);
        return res;
    }
    // Load line items for these headers (grouped by parent) + the reverse product map.
    const linesByParent = await loadPendingLines(spec, rows.map(r => r.Id), acct.sapCode, log);
    const itemBySap = spec.lineObject ? await loadStockItemBySap(server, port, acct.sapCode, log) : new Map();
    for (const row of rows) {
        const logical = applyMapping(row, maps);
        const built = assembleVoucher(spec.objectType, logical, linesByParent.get(row.Id) || [], itemBySap);
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
            const counters = new Set((built.inventoryEntries || []).map(i => i.accountingLedger).concat(built.entries.length > 1 ? [built.entries[1].ledger] : []));
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