import { loadMappings, applyMapping } from './sfMapping.mjs';
import { sfQuery, sfUpdate, sfUpsert, sfInsert } from './sfClient.mjs';
import { postVoucher, ensureLedger, type VoucherInput } from './tallyImport.mjs';
import { ensureStockItem, readStockItemKeys, resolveDefaultGodown, upsertLedgerWithSapId, upsertStockItemWithSapId } from './tallyMaster.mjs';
import { computeGstEntries, ensureGstLedgers, loadGstConfig, loadProductGstRates, loadDistributorState, loadPartyStates, type GstLedgerConfig } from './gst.mjs';
import { stateNameFromCode, canonStateCode } from './stateCodes.mjs';
import { fetchFilteredCollection, postTallyXml, describeError } from './tallyLive.mjs';
import { logToTrigger } from './sfLog.mjs';
import { saveWatermark, stampRun, type SyncConfig, type AccountRef } from './sfConfig.mjs';

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
    voucherTypes: string[];  // Tally voucher type name(s) this staging object collects
    noteType?: boolean;      // Note object: stamp Note_Type__c (Credit/Debit) from the voucher type
    lineObject?: string;     // child object for inventory line items
    lineParentRel?: string;  // parent relationship (by external id) on the line, e.g. 'Invoice__r'
}
export const SPECS: Record<string, ObjectSpec> = {
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
const splitMulti = (v: any): string[] => (v == null || v === '') ? [] : String(v).split('; ');
const toNum = (v: any): number | null => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; };
/** "90.00 MT" -> { qty: 90, unit: 'MT' }; "35000.00/MT" (rate) -> 35000 via toRate. */
function parseQty(v: string): { qty: number | null; unit: string } {
    const s = String(v || '').trim(); const m = s.match(/^(-?[\d.,]+)\s*(.*)$/);
    return m ? { qty: toNum(m[1]), unit: (m[2] || '').trim() } : { qty: null, unit: '' };
}
const toRate = (v: string): number | null => toNum(String(v || '').split('/')[0]);

/**
 * Read the Stock Item master and build a `stock item name -> Morde SAP Id` map. The SAP Id
 * lives on the stock item master (Part Number by default), NOT on the voucher line, so we read
 * it each cycle and join by name. Which Tally field holds it is mapping-driven (editable per
 * distributor): a Field_Mapping row Object_Type='StockItem', target 'Product_SAP_Id__c'.
 */
export async function loadStockItemSapIds(server: string, port: number, sapId: string, log: LogFn): Promise<Map<string, string>> {
    // SAP Id lives in the MordeSAPID UDF (the standard), which only projects via COMPUTE — a plain
    // FETCH silently drops it. readStockItemKeys reads it correctly. Only SAP-tagged items matter.
    const out = new Map<string, string>();
    try {
        const keys = await readStockItemKeys(server, port, { sapTaggedOnly: true });
        for (const k of keys) if (k.name && k.sapId) out.set(k.name.toLowerCase(), k.sapId);
        log(`  stock-item SAP ids: ${out.size} mapped (from MordeSAPID UDF)`);
    } catch (e: any) { log(`  stock-item master read failed — ${e?.message || e}`, true); }
    return out;
}

/** Build child line records for one voucher row (empty if no inventory). Parent set by external id. */
function buildLines(spec: ObjectSpec, row: Record<string, string>, sapId: string, companyCode: string, itemSap: Map<string, string>): Record<string, any>[] {
    const names = splitMulti(row[`${INV}.stockitemname`]);
    if (!names.length) return [];
    const qty = splitMulti(row[`${INV}.actualqty`]);
    const rate = splitMulti(row[`${INV}.rate`]);
    const disc = splitMulti(row[`${INV}.discount`]);
    const amt = splitMulti(row[`${INV}.amount`]);
    const ledger = splitMulti(row[`${INV}.accountingallocations.list.ledgername`]);
    // Warehouse/godown is now a HEADER concept (Warehouse_Address__c -> Tally_Shipping_Address__c),
    // not a per-line field, so inbound no longer captures godown onto the line. (Inbound header
    // warehouse resolution — matching the voucher's godown name back to a warehouse address record —
    // is a deliberate TODO; the central sales flow is SF->Tally.)
    return names.map((name, i) => {
        const q = parseQty(qty[i]);
        return {
            Tally_Line_Key__c: `${row.guid}#${i + 1}`,
            [spec.lineParentRel!]: { [spec.externalId]: row.guid },
            Stock_Item__c: name,
            Product_SAP_Id__c: itemSap.get(name.toLowerCase()) || '', // Morde SAP Id from stock-item master
            Quantity__c: q.qty, Unit__c: q.unit,
            Rate__c: toRate(rate[i]), Discount__c: toNum(disc[i]), Amount__c: toNum(amt[i]),
            Accounting_Ledger__c: ledger[i] || '',
            Line_No__c: i + 1, SAP_Id__c: sapId, SAP_Company_Code__c: companyCode,
        };
    });
}

// ============================ Tally -> Salesforce (read) ============================

export interface ToSfResult { fetched: number; upserted: number; failed: number; newWatermark: number; errors: string[] }

/** Fields the connector always reads regardless of mapping (idempotency + watermark + traceability). */
const SYSTEM_FETCH = ['GUID', 'ALTERID', 'VOUCHERNUMBER', 'DATE', 'VOUCHERTYPENAME'];

/**
 * One incremental Tally->SF pass for a single object type. Reads only vouchers of the
 * spec's voucher type whose $AlterID is past the config watermark (so re-runs are cheap and
 * resumable), maps them with the SF-authored mapping, upserts staging by GUID, and advances
 * the watermark. A bounded field list is used (never FETCH * over the whole collection).
 */
export async function syncToSalesforce(
    spec: ObjectSpec, config: SyncConfig, acct: AccountRef, server: string, port: number,
    opts: { dryRun?: boolean; log?: LogFn } = {},
): Promise<ToSfResult> {
    const log = opts.log || (() => { });
    const startedAt = new Date();
    const res: ToSfResult = { fetched: 0, upserted: 0, failed: 0, newWatermark: config.lastAlterId, errors: [] };
    log(`[agent] ${spec.objectType} Tally->SF: starting (watermark AlterID>${config.lastAlterId})${opts.dryRun ? ' (dry-run)' : ''}`);

    // Tally row keys are lowercased by parseCollection, so match ToSalesforce source (a Tally
    // field name) case-insensitively; the SF-side target stays exactly as authored.
    const maps = (await loadMappings(spec.objectType, 'ToSalesforce', acct.sapId)).map(m => ({ ...m, source: m.source?.toLowerCase() }));
    if (!maps.length) {
        log(`[agent] no active ToSalesforce mappings for ${spec.objectType} — nothing to do`, true);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', errorMessage: 'no active mappings', startedAt });
        return res;
    }
    const fetchList = [...new Set([...SYSTEM_FETCH, ...maps.filter(m => m.source).map(m => m.source!.toUpperCase())])].join(',');
    // Incremental + type-scoped filter. Operators/quotes MUST be XML-escaped (see alterIdRangeFilter).
    const typeFilter = spec.voucherTypes.map(vt => `$VoucherTypeName = ${qstr(vt)}`).join(' OR ');
    const filter = `(${typeFilter}) AND $AlterID &gt; ${config.lastAlterId}`;

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
        const rec: Record<string, any> = {
            ...mapped,
            [spec.externalId]: row.guid,
            Tally_AlterId__c: alterId,
            Tally_Voucher_Number__c: row.vouchernumber || mapped.Tally_Voucher_Number__c || '',
            SAP_Id__c: acct.sapId,                      // new distributor identity
            SAP_Company_Code__c: acct.companyCode,      // deprecated, still populated for existing consumers
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
    const itemSap = spec.lineObject ? await loadStockItemSapIds(server, port, acct.sapId, log) : new Map<string, string>();
    const lineRecords = spec.lineObject ? clean.flatMap(row => buildLines(spec, row, acct.sapId, acct.companyCode, itemSap)) : [];

    if (opts.dryRun) {
        log(`[agent] ${spec.objectType}: dry-run — would upsert ${records.length} rows + ${lineRecords.length} line items (watermark -> ${res.newWatermark})`);
        log(`  sample: ${JSON.stringify(records[0]).slice(0, 500)}`);
        if (lineRecords.length) log(`  line sample: ${JSON.stringify(lineRecords[0]).slice(0, 400)}`);
        await logToTrigger({ operation: `Tally->SF ${spec.objectType}`, objectName: spec.stagingObject, status: 'Info', responseBody: `dry-run ${records.length} rows, ${lineRecords.length} lines`, startedAt });
        return res;
    }

    const up = await sfUpsert(spec.stagingObject, spec.externalId, records, (m, e) => log('  ' + m, e));
    res.upserted = up.success; res.failed = up.failed; res.errors.push(...up.errors);

    // Write line items after the parent headers exist (parent resolved by external id).
    if (spec.lineObject && lineRecords.length) {
        const lu = await sfUpsert(spec.lineObject, 'Tally_Line_Key__c', lineRecords, (m, e) => log('  ' + m, e));
        if (lu.failed) res.errors.push(...lu.errors.map(e => `line: ${e}`));
        log(`  ${spec.lineObject}: upserted ${lu.success} line items, failed ${lu.failed}`);
    }

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

// Double-entry + inventory rules per object type — the accounting lives in code; field mapping
// stays in Salesforce. partySign: sign of the party ledger amount (neg=debit, pos=credit).
// qtySign: inventory movement (-1 outward/sale, +1 inward/purchase). Groups are used to
// auto-create the party / sales-purchase ledgers if they don't exist yet in Tally.
// taxSide: the DOCUMENT/GST side, independent of the accounting signs. 'output' = sales-side doc
// (Output GST + Sales counter default), 'input' = purchase-side doc (Input GST + Purchase counter).
// This MUST be separate from partySign: a Credit Note is a sales-side document (Output GST) yet its
// party posting is a credit (partySign:1), and a Debit Note is purchase-side (Input GST) yet
// partySign:-1 — so deriving the tax/counter side from the sign books notes to the wrong ledgers.
interface ToTallyRule { voucherType: string; counterLedgerDefault: string; partySign: 1 | -1; qtySign: 1 | -1; taxSide: 'output' | 'input'; partyGroup: string; counterGroup: string; order?: boolean; }
const TO_TALLY_RULES: Record<string, ToTallyRule> = {
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
function ruleFor(objectType: string, logical: Record<string, any>): ToTallyRule | undefined {
    if (objectType === 'Note') return String(logical.noteType || '').toLowerCase().includes('debit') ? TO_TALLY_RULES.DebitNote : TO_TALLY_RULES.CreditNote;
    return TO_TALLY_RULES[objectType];
}

export interface LogicalLine { stockItem?: string; productSapId?: string; qty?: any; unit?: string; rate?: any; amount?: any; ledger?: string; orderNo?: string; }

/** Voucher-level extras resolved from the staging HEADER (Invoice/Order only): the warehouse the
 *  goods ship FROM (-> Tally godown on every stock line) and the customer ship-to address. */
export interface ShipTo { name?: string; lines?: string[]; stateName?: string; }
export interface VoucherExtra { defaultGodown?: string; headerGodown?: string; shipTo?: ShipTo; orderRef?: string; }

/**
 * Build a balanced VoucherInput from mapped header fields + line items, or return an error.
 * Line stock items are resolved to the distributor's Tally item name via SAP Id (itemBySap),
 * falling back to the line's own stock item name. When lines exist the party amount is derived
 * from the line total, so the voucher always balances.
 */
export interface GstCtx { rateBySap: Map<string, number>; intra: boolean; cfg: GstLedgerConfig; }
export function assembleVoucher(objectType: string, logical: Record<string, any>, lines: LogicalLine[], itemBySap: Map<string, { name: string; unit: string }>, gst?: GstCtx, extra: VoucherExtra = {}): VoucherInput | string {
    const rule = ruleFor(objectType, logical);
    if (!rule) return `no ToTally rule for ${objectType} (SF->Tally not supported for this type yet)`;
    if (!logical.party) return 'missing party';
    if (!/^\d{8}$/.test(String(logical.date || ''))) return `bad date '${logical.date}' (need YYYYMMDD)`;
    const party = String(logical.party);
    const num = (v: any) => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

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

    // Warehouse/godown is a HEADER concept now: one warehouse per voucher applies to every stock
    // line. Precedence: the header's Warehouse_Address__c (resolved to a Tally godown name) wins;
    // else the company default (set only when multi-godown is enabled — Tally then REQUIRES an
    // allocation on every line); else '' (single-location company -> no allocation, byte-identical
    // XML). ORDER vouchers carry NO godown (no stock movement; Tally rejects an order with a batch
    // allocation). Batch defaults to 'Primary Batch' at XML build time when a godown is present.
    const voucherGodown = rule.order ? undefined : ((extra.headerGodown || extra.defaultGodown || '') || undefined);

    const inventoryEntries = [];
    const gstLines: { base: number; rate: number }[] = [];
    let lineTotal = 0;
    for (const ln of lines) {
        const sap = String(ln.productSapId || '').toLowerCase();
        const resolved = sap && itemBySap.get(sap);
        const stockItem = resolved ? resolved.name : String(ln.stockItem || '');
        if (!stockItem) return `line has no resolvable stock item (SAP Id '${ln.productSapId || ''}' not found, no name)`;
        const qty = Math.abs(num(ln.qty));
        const amt = Math.abs(num(ln.amount));
        const unit = String(ln.unit || (resolved ? resolved.unit : '') || '');
        lineTotal += amt;
        if (gst) gstLines.push({ base: amt, rate: gst.rateBySap.get(sap) || 0 });
        inventoryEntries.push({
            stockItem, unit, qty: qtySign * qty, rate: num(ln.rate),
            amount: -partySign * amt,                 // opposite side of the party posting
            accountingLedger: String(ln.ledger || counter),
            // A per-line order number wins; otherwise the voucher-level order reference. Only
            // meaningful on a consuming voucher (not the order itself) — buildVoucherImportXml
            // drops it when isOrder.
            orderNo: ln.orderNo ? String(ln.orderNo) : (logical.orderRef ? String(logical.orderRef) : undefined),
            // Header warehouse applies to every line (see voucherGodown above). Batch is left to the
            // XML builder's 'Primary Batch' default when a godown is set.
            godown: voucherGodown,
            productSapId: ln.productSapId ? String(ln.productSapId) : undefined, // for the safety-net native-Product2 fallback
        });
    }

    const total = lines.length ? lineTotal : Math.abs(num(logical.amount));
    if (!total) return 'missing/zero amount';

    // GST: compute tax on the goods lines and post it into this company's GST ledgers (Output for a
    // sale, Input for a purchase). Orders carry no accounting, so no tax. Tally does NOT auto-calc on
    // XML import, so we add the amounts; the party balance rises by the tax.
    let taxEntries: { ledger: string; amount: number }[] = [];
    let totalTax = 0;
    if (gst && !rule.order && inventoryEntries.length) {
        // Ledger set follows the document/tax side (docIsPurchase); the posting sign follows the
        // accounting side (-partySign) so the tax sits opposite the party, same side as inventory.
        const g = computeGstEntries(gstLines, { intra: gst.intra, isPurchase: docIsPurchase, sign: (-partySign) as 1 | -1, cfg: gst.cfg });
        if (g.error) return `GST: ${g.error}`;
        taxEntries = g.entries; totalTax = g.totalTax;
    }
    const partyAmt = partySign * (total + totalTax);
    const entries = [{ ledger: party, amount: partyAmt }, ...taxEntries];
    if (!lines.length) entries.push({ ledger: counter, amount: -partyAmt }); // no inventory -> plain 2-line accounting voucher

    const shipTo = extra.shipTo;
    return {
        date: String(logical.date), voucherType, partyLedger: party,
        voucherNumber: logical.number ? String(logical.number) : undefined,
        narration: logical.narration ? String(logical.narration) : undefined,
        entries, inventoryEntries: inventoryEntries.length ? inventoryEntries : undefined,
        // Customer ship-to (Invoice/Order only; additive — absent on other types). PLACEOFSUPPLY is
        // the GST metadata; the actual intra/inter tax split was computed above from the same state.
        ...(shipTo ? {
            consigneeName: shipTo.name || undefined,
            shipToAddress: (shipTo.lines && shipTo.lines.length) ? shipTo.lines : undefined,
            placeOfSupply: shipTo.stateName || undefined,
        } : {}),
        // Order vouchers need a reference (the order number) + a per-line order due date.
        ...(rule.order ? { isOrder: true, reference: (logical.number ? String(logical.number) : (extra.orderRef || undefined)), orderDueDate: String(logical.date) } : {}),
    };
}

/** Reverse product map: Morde SAP Id -> the distributor's Tally stock item (name + base unit).
 *  Reads the MordeSAPID UDF (via COMPUTE) like loadStockItemSapIds. */
async function loadStockItemBySap(server: string, port: number, sapId: string, log: LogFn): Promise<Map<string, { name: string; unit: string }>> {
    const out = new Map<string, { name: string; unit: string }>();
    try {
        const keys = await readStockItemKeys(server, port, { sapTaggedOnly: true });
        for (const k of keys) if (k.sapId && k.name) out.set(k.sapId.toLowerCase(), { name: k.name, unit: k.unit || '' });
    } catch (e: any) { log(`  stock-item reverse map failed — ${e?.message || e}`, true); }
    return out;
}

/** Read Pending line-item rows for the given header Ids, grouped by parent header Id. */
async function loadPendingLines(spec: ObjectSpec, headerIds: string[], sapId: string, log: LogFn): Promise<Map<string, LogicalLine[]>> {
    const out = new Map<string, LogicalLine[]>();
    if (!spec.lineObject || !headerIds.length) return out;
    const parentField = spec.lineParentRel!.replace('__r', '__c'); // e.g. 'Invoice__r' -> 'Invoice__c'
    const ids = headerIds.map(i => `'${i}'`).join(',');
    try {
        const rows = await sfQuery(
            `SELECT ${parentField}, Product_SAP_Id__c, Stock_Item__c, Quantity__c, Unit__c, Rate__c, Amount__c, Accounting_Ledger__c ` +
            `FROM ${spec.lineObject} WHERE ${parentField} IN (${ids}) ORDER BY Line_No__c NULLS LAST`);
        for (const r of rows) {
            const pid = r[parentField]; if (!pid) continue;
            const arr = out.get(pid) || [];
            arr.push({ productSapId: r.Product_SAP_Id__c, stockItem: r.Stock_Item__c, qty: r.Quantity__c, unit: r.Unit__c, rate: r.Rate__c, amount: r.Amount__c, ledger: r.Accounting_Ledger__c });
            out.set(pid, arr);
        }
    } catch (e: any) { log(`  line read failed — ${e?.message || e}`, true); }
    return out;
}

/** Best-effort: after a voucher is created, read its Tally GUID back so the staging record carries
 *  the permanent Tally key (hard SF<->Tally identity, alongside the shared reference). Keyed on the
 *  number/reference we sent; short timeout, and NEVER throws — a failed lookup just means no GUID. */
async function lookupVoucherGuid(server: string, port: number, spec: ObjectSpec, v: VoucherInput): Promise<string> {
    const key = v.voucherNumber || v.reference;
    if (!key) return '';
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
    } catch { return ''; }
}

export interface ToTallyResult { pending: number; created: number; failed: number; errors: string[] }

const soqlEsc = (s: string) => String(s == null ? '' : s).replace(/'/g, "\\'");

/** Ensure a voucher's PARTY LEDGER exists in Tally — richly. Instead of a bare shell, look up the
 *  party's Salesforce bridge row (Tally_Account__c, which the org's trigger populates from the native
 *  Account) and create the ledger with its SAP Id + real Account Group, writing the Tally GUID back.
 *  Falls back to a bare ledger only when there is no bridge row. Returns '' on success, else an error. */
async function ensurePartyLedgerRich(acct: AccountRef, server: string, port: number, partyName: string, fallbackGroup: string, log: LogFn): Promise<string> {
    try {
        const rows = await sfQuery(
            `SELECT Id, SAP_ID__c, Account_Group__c, Tally_Guid__c FROM Tally_Account__c ` +
            `WHERE Distributor__c = '${soqlEsc(acct.id)}' AND Name = '${soqlEsc(partyName)}' LIMIT 1`);
        const r = rows[0];
        if (r && r.SAP_ID__c) {
            const w = await upsertLedgerWithSapId(server, port, partyName, r.Account_Group__c || fallbackGroup, r.SAP_ID__c, { knownGuid: r.Tally_Guid__c || undefined, log });
            if (w.ok) {
                log(`  party ledger '${partyName}' created from SF (sap=${r.SAP_ID__c}, group=${r.Account_Group__c || fallbackGroup})`);
                if (w.guid && w.guid !== r.Tally_Guid__c) await sfUpdate('Tally_Account__c', r.Id, { Tally_Guid__c: w.guid }).catch(() => { });
                return '';
            }
            log(`  party ledger '${partyName}' rich-create failed (${w.message}) — trying native Account`, true);
        }
    } catch (e: any) { log(`  party ledger Tally_Account lookup failed — ${e?.message || e}; trying native Account`, true); }

    // No Tally_Account__c yet — read the native customer Account directly (it already carries the
    // org-generated customer SAP in SAP_ID__c, plus GSTIN + state), create the ledger with it, and
    // create the Tally_Account__c bridge row (distributor + account + SAP + GUID + GSTIN + state).
    try {
        const arows = await sfQuery(
            `SELECT Id, Name, SAP_ID__c, GST__c, BillingStateCode FROM Account ` +
            `WHERE Name = '${soqlEsc(partyName)}' AND SAP_ID__c != null LIMIT 1`);
        const a = arows[0];
        if (a && a.SAP_ID__c) {
            const w = await upsertLedgerWithSapId(server, port, partyName, fallbackGroup, a.SAP_ID__c, { log });
            if (w.ok) {
                log(`  party ledger '${partyName}' created from native Account (sap=${a.SAP_ID__c})`);
                const rec: Record<string, any> = { Distributor__c: acct.id, Account__c: a.Id, Name: partyName.slice(0, 80), SAP_ID__c: a.SAP_ID__c, Sync_Status__c: 'From Tally' };
                if (w.guid) rec.Tally_Guid__c = w.guid;
                if (a.GST__c) rec.GSTIN__c = a.GST__c;
                if (a.BillingStateCode) { rec.BillingAddress__CountryCode__s = 'IN'; rec.BillingAddress__StateCode__s = a.BillingStateCode; }
                await sfInsert('Tally_Account__c', [rec]).then(() => log(`  Tally_Account__c bridge row created for '${partyName}'`)).catch((e: any) => log(`  (Tally_Account__c bridge insert skipped: ${e?.message || e})`, true));
                return '';
            }
            log(`  party ledger '${partyName}' native-Account create failed (${w.message}) — falling back to bare`, true);
        }
    } catch (e: any) { log(`  party native Account lookup failed — ${e?.message || e}; falling back to bare`, true); }

    return (await ensureLedger(server, port, partyName, fallbackGroup, log)) ? '' : `party ledger '${partyName}' is missing and could not be created`;
}

/** Ensure a voucher's STOCK ITEM exists in Tally — richly, so it is never a bare shell:
 *   1. the distributor's Tally_Product__c (the org's mapped output) → SAP Id + UOM + GST% + HSN, or
 *   2. the NATIVE Product2 (the source the org's trigger maps from) → Name + BaseUOM + GST% + HSN,
 *      with the SAP Id rebuilt the same way the org does it: '<distributorSAP>-<productKey>', where
 *      productKey is Product2.SAP_ID__c (falling back to ProductCode). This matches
 *      DistProductMappingHandler, so an item created on-demand is identical to the master sync's.
 *   3. only if neither exists → a bare item (name + unit).
 *  productSapId is the staging line's Product_SAP_Id__c (= Product2.SAP_ID__c, the product key). */
async function ensureStockItemRich(acct: AccountRef, server: string, port: number, name: string, fallbackUnit: string, productSapId: string, log: LogFn): Promise<boolean> {
    // 1) distributor's Tally_Product__c (already carries the merged SAP + GST/HSN).
    try {
        const rows = await sfQuery(
            `SELECT Id, SAP_ID__c, BaseUOM__c, GST_Percentage__c, HSN__c, Tally_Guid__c FROM Tally_Product__c ` +
            `WHERE Account__c = '${soqlEsc(acct.id)}' AND Name = '${soqlEsc(name)}' LIMIT 1`);
        const r = rows[0];
        if (r && r.SAP_ID__c) {
            const w = await upsertStockItemWithSapId(server, port, name, (r.BaseUOM__c || fallbackUnit || 'pcs'), r.SAP_ID__c, {
                gstRate: (r.GST_Percentage__c != null) ? Number(r.GST_Percentage__c) : undefined,
                hsn: r.HSN__c || undefined, knownGuid: r.Tally_Guid__c || undefined, log,
            });
            if (w.ok) {
                log(`  stock item '${name}' created from Tally_Product (sap=${r.SAP_ID__c}, gst=${r.GST_Percentage__c ?? 'n/a'}, hsn=${r.HSN__c || 'n/a'})`);
                if (w.guid && w.guid !== r.Tally_Guid__c) await sfUpdate('Tally_Product__c', r.Id, { Tally_Guid__c: w.guid }).catch(() => { });
                return true;
            }
            log(`  stock item '${name}' Tally_Product create failed (${w.message}) — trying native Product2`, true);
        }
    } catch (e: any) { log(`  stock item Tally_Product lookup failed — ${e?.message || e}; trying native Product2`, true); }

    // 2) native Product2 (no Tally_Product__c for this distributor yet). Match by the product key
    //    (Product2.SAP_ID__c) when we have it, else by name. Rebuild the merged SAP like the org.
    try {
        const psap = String(productSapId || '').trim();
        const conds: string[] = [];
        if (psap) conds.push(`SAP_ID__c = '${soqlEsc(psap)}'`);
        conds.push(`Name = '${soqlEsc(name)}'`);
        const rows = await sfQuery(
            `SELECT Name, BaseUOM__c, GST_Percentage__c, HSN__c, SAP_ID__c, ProductCode FROM Product2 ` +
            `WHERE ${conds.join(' OR ')} LIMIT 1`);
        const p = rows[0];
        if (p) {
            const productKey = String(p.SAP_ID__c || p.ProductCode || psap || '').trim();
            const mergedSap = productKey ? `${acct.sapId}-${productKey}` : '';  // '<distributorSAP>-<productKey>', as DistProductMappingHandler builds it
            const w = await upsertStockItemWithSapId(server, port, name, (p.BaseUOM__c || fallbackUnit || 'pcs'), mergedSap, {
                gstRate: (p.GST_Percentage__c != null) ? Number(p.GST_Percentage__c) : undefined,
                hsn: p.HSN__c || undefined, log,
            });
            if (w.ok) {
                log(`  stock item '${name}' created from native Product2 (sap=${mergedSap || 'n/a'}, gst=${p.GST_Percentage__c ?? 'n/a'}, hsn=${p.HSN__c || 'n/a'})`);
                // Also create the Tally_Product__c bridge row in SF (distributor + merged SAP + GST/HSN
                // + the Tally GUID), so the master now exists on the SF side too, not just in Tally.
                const rec: Record<string, any> = { Account__c: acct.id, Name: name.slice(0, 80), Tally_Guid__c: w.guid || undefined };
                if (mergedSap) rec.SAP_ID__c = mergedSap;
                if (p.BaseUOM__c) rec.BaseUOM__c = p.BaseUOM__c;
                if (p.GST_Percentage__c != null) rec.GST_Percentage__c = Number(p.GST_Percentage__c);
                if (p.HSN__c) rec.HSN__c = p.HSN__c;
                await sfInsert('Tally_Product__c', [rec]).then(() => log(`  Tally_Product__c bridge row created for '${name}'`)).catch((e: any) => log(`  (Tally_Product__c bridge insert skipped: ${e?.message || e})`, true));
                return true;
            }
            log(`  stock item '${name}' native Product2 create failed (${w.message}) — falling back to bare`, true);
        }
    } catch (e: any) { log(`  stock item Product2 lookup failed — ${e?.message || e}; falling back to bare`, true); }

    // 3) last resort: bare item (name + unit).
    return await ensureStockItem(server, port, name, fallbackUnit, log);
}

/** One Salesforce -> Tally run for a single object type: create Tally vouchers from
 *  Pending staging rows flagged Direction=ToTally (with their line items), then write status back. */
export async function syncToTally(spec: ObjectSpec, acct: AccountRef, server: string, port: number, opts: { dryRun?: boolean; log?: LogFn } = {}): Promise<ToTallyResult> {
    const log = opts.log || (() => { });
    const startedAt = new Date();
    log(`[agent] ${spec.objectType} SF->Tally: starting${opts.dryRun ? ' (dry-run)' : ''}`);
    if (!['Invoice', 'Purchase', 'Order', 'Note', 'PurchaseOrder'].includes(spec.objectType)) { log(`[agent] SF->Tally not supported for ${spec.objectType} yet`, true); return { pending: 0, created: 0, failed: 0, errors: [`no rule for ${spec.objectType}`] }; }
    const maps = await loadMappings(spec.objectType, 'ToTally', acct.sapId);
    if (!maps.length) { log(`[agent] no active ToTally mappings for ${spec.objectType} — nothing to do`, true); return { pending: 0, created: 0, failed: 0, errors: ['no mappings'] }; }
    const sourceFields = [...new Set(maps.filter(m => m.source).map(m => m.source!))];
    // Headers carry a warehouse (godown) and/or customer ship-to lookup to Tally_Shipping_Address__c.
    // These are connector-fixed (not mapping-driven). Warehouse exists on Invoice, Order AND Purchase
    // (where it's the godown stock is received INTO); the customer ship-to exists only on the sales
    // side (Invoice/Order). Append whichever apply so the SOQL never references an absent field.
    const hasWarehouse = spec.objectType === 'Invoice' || spec.objectType === 'Order' || spec.objectType === 'Purchase';
    const hasShipTo = spec.objectType === 'Invoice' || spec.objectType === 'Order';
    const addrFields = [
        ...(hasWarehouse ? ['Warehouse_Address__r.Name'] : []),
        ...(hasShipTo ? [
            'Customer_Shipping_Address__r.Name',
            'Customer_Shipping_Address__r.Full_Address__StateCode__s',
            'Customer_Shipping_Address__r.Full_Address__Street__s',
            'Customer_Shipping_Address__r.Full_Address__City__s',
            'Customer_Shipping_Address__r.Full_Address__PostalCode__s',
        ] : []),
    ];
    // Order vouchers REQUIRE a non-empty voucher <REFERENCE>; Tally rejects an order without one
    // as "Bad Order Number in Voucher!". The mapped `number` is frequently blank, so always fetch a
    // fallback order identifier — the Tally order number (Order object), else the record Name.
    const orderRefFields = (spec.objectType === 'Order' || spec.objectType === 'PurchaseOrder')
        ? ['Name', ...(spec.objectType === 'Order' ? ['Order_Number__c'] : [])] : [];
    const selectFields = [...new Set([...sourceFields, ...addrFields, ...orderRefFields])];
    // Distributor scoping by SAP_Id__c. The org stamps a COMPOSITE SAP id on each staging row —
    // '<distributorSAP>-<recordNo>' (e.g. '100273-00020961', '100273-INV-0000020638') — so the
    // distributor is the PREFIX before the first dash, not the whole value. Match the bare id (rows
    // the connector itself stamps on inbound) OR the '<sap>-...' composite (org-stamped rows), which
    // uniformly identifies this distributor across all staging objects (not all have a Distributor__c
    // lookup — only Invoice/Order do).
    const sid = acct.sapId.replace(/'/g, "\\'");
    const soql = `SELECT Id, ${selectFields.join(', ')} FROM ${spec.stagingObject} ` +
        `WHERE Direction__c = 'ToTally' AND Sync_Status__c = 'Pending' AND (SAP_Id__c = '${sid}' OR SAP_Id__c LIKE '${sid}-%')`;
    const rows = await sfQuery(soql);
    log(`[agent] ${spec.objectType}: ${rows.length} pending staging rows`);
    const res: ToTallyResult = { pending: rows.length, created: 0, failed: 0, errors: [] };
    if (!rows.length) {
        await logToTrigger({ operation: `SF->Tally ${spec.objectType}`, objectName: spec.stagingObject, status: 'Success', responseBody: '0 pending', startedAt });
        log(`[agent] ${spec.objectType} SF->Tally: nothing pending`); return res;
    }

    // Load line items for these headers (grouped by parent) + the reverse product map.
    const linesByParent = await loadPendingLines(spec, rows.map(r => r.Id), acct.sapId, log);
    const itemBySap = spec.lineObject ? await loadStockItemBySap(server, port, acct.sapId, log) : new Map();
    // Resolve the company's default godown ONCE per run. Non-empty only when multi-godown is enabled
    // (Tally then rejects any inventory line with no allocation); '' leaves single-location companies
    // byte-identical. Only relevant for inventory vouchers (those with line items).
    const defaultGodown = spec.lineObject ? await resolveDefaultGodown(server, port) : '';
    if (defaultGodown) log(`[agent] multi-godown company — defaulting un-godowned lines to '${defaultGodown}'`);

    // GST context (per distributor): ledger names + product rates + state codes for intra/inter.
    // Only invoices/purchases/notes carry tax; orders have no accounting side.
    const taxable = ['Invoice', 'Purchase', 'Note'].includes(spec.objectType);
    let gstCfg: GstLedgerConfig = {};
    let rateBySap = new Map<string, number>();
    let distState = '';
    let partyStates = new Map<string, string>();
    if (taxable) {
        gstCfg = await loadGstConfig(acct.sapId);
        rateBySap = await loadProductGstRates(acct.id);
        distState = await loadDistributorState(acct.id);
        partyStates = await loadPartyStates(acct.id);
        log(`[agent] GST: ${Object.values(gstCfg).filter(Boolean).length} ledger(s), ${rateBySap.size} product rate(s), distributor state '${distState || '?'}'`);
        // BUG 2: a blank distributor state silently forces intra() = true for EVERY voucher (see the
        // intra calc below), so inter-state sales can never emit IGST — a silent mis-taxation risk.
        // Warn once per run; the data fix (set the distributor Account's state) is out of scope here.
        if (!distState) log(`[agent] GST WARNING: distributor state is blank — every voucher will be taxed INTRA-state (CGST+SGST); inter-state sales will NOT produce IGST. Set the distributor Account's state.`, true);
        // Ensure our standard GST ledgers exist and are correctly classified (create if missing).
        if (!opts.dryRun) { const gErr = await ensureGstLedgers(server, port, gstCfg, (m, e) => log('  ' + m, e)); if (gErr) log(`[agent] GST ledger setup: ${gErr}`, true); }
    }

    // BUG 4: collect goods lines on taxable vouchers whose resolved GST rate is 0 (product missing
    // GST_Percentage__c) — those post with NO tax and no signal. Aggregated into one warning per run.
    const zeroRateItems = new Set<string>();
    for (const row of rows) {
        const logical = applyMapping(row, maps);
        // Header warehouse (Invoice/Order ship-FROM, Purchase receive-INTO) + customer ship-to
        // (sales only), from the Tally_Shipping_Address__c lookups. Ship-to STATE = GST place of supply.
        let headerGodown = ''; let shipTo: ShipTo | undefined; let shipToStateCode = '';
        if (hasWarehouse) headerGodown = row.Warehouse_Address__r?.Name || '';
        if (hasShipTo) {
            const cs = row.Customer_Shipping_Address__r;
            if (cs) {
                shipToStateCode = cs.Full_Address__StateCode__s || '';
                const cityLine = [cs.Full_Address__City__s, cs.Full_Address__PostalCode__s].filter(Boolean).join(' ');
                const lines = [cs.Full_Address__Street__s, cityLine].filter(Boolean).map((s: string) => String(s));
                shipTo = { name: cs.Name || undefined, lines, stateName: stateNameFromCode(shipToStateCode) || undefined };
            }
        }
        let gstCtx: GstCtx | undefined;
        if (taxable) {
            // Place of supply = customer ship-to state when present (Invoice/Order), else the party's
            // billing state. Compared canonically so the two SF code spaces (CT/CG, UT/UK) still match.
            const partySt = partyStates.get(String(logical.party || '').trim().toLowerCase()) || '';
            const posState = shipToStateCode || partySt;
            const intra = !distState || !posState || canonStateCode(distState) === canonStateCode(posState); // default to intra when a state is unknown
            gstCtx = { rateBySap, intra, cfg: gstCfg };
            for (const ln of (linesByParent.get(row.Id) || [])) {
                const sap = String(ln.productSapId || '').trim().toLowerCase();
                if (!(rateBySap.get(sap) || 0)) zeroRateItems.add(String(ln.productSapId || ln.stockItem || '(unknown item)'));
            }
        }
        const orderRef = String(row.Order_Number__c || row.Name || '').trim();
        const built = assembleVoucher(spec.objectType, logical, linesByParent.get(row.Id) || [], itemBySap, gstCtx, { defaultGodown, headerGodown, shipTo, orderRef });
        if (typeof built === 'string') {
            res.failed++; res.errors.push(`${row.Id}: ${built}`);
            if (!opts.dryRun) await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: built }).catch(() => { });
            log(`  ${row.Id}: invalid - ${built}`, true);
            continue;
        }
        // Master prerequisites: every ledger and stock item the voucher references MUST exist in
        // this distributor's Tally, or the import fails with a cryptic error. So create any that are
        // missing first (party + accounting/counter ledgers, and each inventory stock item). If a
        // master genuinely cannot be created, fail the voucher cleanly with a clear reason rather
        // than posting a doomed one. (The full account/product master sync creates these properly
        // with SAP Id/GST; this is the per-voucher safety net.)
        const rule = ruleFor(spec.objectType, logical)!;
        let masterErr = '';
        if (!opts.dryRun) {
            // Party ledger: create it richly from its SF bridge row (SAP Id + real group) when
            // missing, not a bare shell — only falls back to bare if there's no bridge row.
            if (built.partyLedger) masterErr = await ensurePartyLedgerRich(acct, server, port, built.partyLedger, rule.partyGroup, log);
            // Auto-create only the counter/accounting ledgers (Sales/Purchase) — NOT the GST tax
            // ledgers. GST ledgers are accountant-configured (correct tax classification); creating
            // one bare would corrupt GST returns. If a configured GST ledger is missing, let the
            // import fail loudly instead.
            const counters = new Set<string>();
            (built.inventoryEntries || []).forEach(i => { if (i.accountingLedger) counters.add(i.accountingLedger); });
            if (!built.inventoryEntries && built.entries[1]) counters.add(built.entries[1].ledger); // plain 2-line voucher's counter
            for (const c of counters) if (!masterErr && c && !(await ensureLedger(server, port, c, rule.counterGroup, log)))
                masterErr = `ledger '${c}' is missing and could not be created`;
            // Stock items: create richly from the SF bridge row (SAP Id + UOM + GST% + HSN) when
            // missing, not a bare shell — only falls back to bare if there's no bridge row.
            for (const inv of (built.inventoryEntries || [])) if (!masterErr && !(await ensureStockItemRich(acct, server, port, inv.stockItem, inv.unit, inv.productSapId || '', log)))
                masterErr = `stock item '${inv.stockItem}' is missing and could not be created`;
        }
        if (masterErr) {
            res.failed++; res.errors.push(`${row.Id}: ${masterErr}`);
            if (!opts.dryRun) await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: masterErr }).catch(() => { });
            log(`  ${row.Id}: ${masterErr}`, true);
            continue;
        }
        const pr = await postVoucher(server, port, built, { dryRun: opts.dryRun, log: (m, e) => log('  ' + m, e) });
        if (pr.ok) {
            res.created++;
            if (!opts.dryRun) {
                const guid = await lookupVoucherGuid(server, port, spec, built);
                const fields: Record<string, any> = { Sync_Status__c: 'Done', Error__c: '', Tally_Voucher_Number__c: built.voucherNumber || '' };
                if (guid) fields.Tally_Guid__c = guid; // permanent Tally key (best-effort)
                await sfUpdate(spec.stagingObject, row.Id, fields).catch(() => { });
            }
        } else {
            res.failed++; res.errors.push(`${row.Id}: ${pr.message}`);
            if (!opts.dryRun) await sfUpdate(spec.stagingObject, row.Id, { Sync_Status__c: 'Error', Error__c: pr.message.slice(0, 32000) }).catch(() => { });
        }
    }

    if (zeroRateItems.size) log(`[agent] GST WARNING: ${zeroRateItems.size} item(s) on taxable vouchers resolved to a 0% GST rate (product missing GST_Percentage__c) and posted with NO tax: ${[...zeroRateItems].join(', ')}. Set GST_Percentage__c on these products.`, true);

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
