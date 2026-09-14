import { postTallyXml, buildFetchXmlFiltered, nameFilter, parseCollection } from './tallyLive.mjs';

// Tally WRITE path (SF -> Tally) — creates/alters vouchers via an Import Data request over
// the same UTF-16LE gateway (docs/salesforce-agent-plan.md). This MODIFIES accounting data,
// so: validate before posting, balance debits==credits, support dry-run, and only ever run
// against a non-production company. Referenced masters (ledgers, voucher type) must already
// exist — that is guaranteed by the master-data-sync step in the full agent.

function esc(s: any): string {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface LedgerEntry { ledger: string; amount: number; } // amount<0 = debit, amount>0 = credit
export interface InventoryEntry {
    stockItem: string;       // must exist in Tally
    unit: string;            // base unit, e.g. 'MT', 'pcs'
    qty: number;             // >0 inward (purchase), <0 outward (sale)
    rate: number;
    amount: number;          // <0 = debit (purchase side)
    accountingLedger: string;// GL ledger the stock value posts to, e.g. 'Purchase'
}
export interface VoucherInput {
    date: string;            // YYYYMMDD
    voucherType: string;     // must exist in Tally, e.g. 'Sales'
    partyLedger?: string;    // must exist
    voucherNumber?: string;  // optional (Salesforce-generated, for traceability)
    narration?: string;
    entries: LedgerEntry[];          // party/tax ledger postings
    inventoryEntries?: InventoryEntry[]; // stock lines (Purchase/Sales with goods)
    company?: string;        // omit to target the currently open company
    objView?: string;        // 'Accounting Voucher View' (default) or 'Invoice Voucher View'
    isOrder?: boolean;       // order voucher (Sales/Purchase Order): inventory-only, no accounting, needs order due date
    orderDueDate?: string;   // YYYYMMDD; defaults to the voucher date
}

export interface ImportResult { ok: boolean; created: number; altered: number; errors: number; message: string; raw: string; }

/** Build the Import Data XML for one voucher. ISDEEMEDPOSITIVE is derived from the amount
 *  sign (negative = debit = deemed positive), matching Tally's convention. */
export function buildVoucherImportXml(v: VoucherInput, action: 'Create' | 'Alter' = 'Create'): string {
    const hasInv = (v.inventoryEntries || []).length > 0;
    // KEY Tally rule: Invoice Voucher View (inventory vouchers) uses <LEDGERENTRIES.LIST>
    // for party/tax postings; Accounting Voucher View uses <ALLLEDGERENTRIES.LIST>. Using
    // the wrong tag makes Tally reject the voucher with a bare EXCEPTION (no line error).
    const ledgerTag = hasInv ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
    const objView = v.objView || (hasInv ? 'Invoice Voucher View' : 'Accounting Voucher View');
    const entries = v.entries.map(e =>
        `<${ledgerTag}>`
        + `<LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>`
        + `<ISDEEMEDPOSITIVE>${e.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<AMOUNT>${e.amount.toFixed(2)}</AMOUNT>`
        + `</${ledgerTag}>`).join('');
    const dueDate = v.orderDueDate || v.date;
    const inventory = (v.inventoryEntries || []).map(i =>
        '<ALLINVENTORYENTRIES.LIST>'
        + `<STOCKITEMNAME>${esc(i.stockItem)}</STOCKITEMNAME>`
        + `<ISDEEMEDPOSITIVE>${i.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<RATE>${i.rate.toFixed(2)}/${esc(i.unit)}</RATE>`
        + `<AMOUNT>${i.amount.toFixed(2)}</AMOUNT>`
        + `<ACTUALQTY>${i.qty.toFixed(2)} ${esc(i.unit)}</ACTUALQTY>`
        + `<BILLEDQTY>${i.qty.toFixed(2)} ${esc(i.unit)}</BILLEDQTY>`
        // Order vouchers: order due date + order allocation, and NO accounting allocation.
        + (v.isOrder
            ? `<ORDERDUEDATE>${esc(dueDate)}</ORDERDUEDATE>`
            + '<BASICORDERALLOCATIONS.LIST>'
            + `<ORDERDUEDATE>${esc(dueDate)}</ORDERDUEDATE>`
            + `<ACTUALQTY>${i.qty.toFixed(2)} ${esc(i.unit)}</ACTUALQTY>`
            + `<BILLEDQTY>${i.qty.toFixed(2)} ${esc(i.unit)}</BILLEDQTY>`
            + `<RATE>${i.rate.toFixed(2)}/${esc(i.unit)}</RATE>`
            + `<AMOUNT>${i.amount.toFixed(2)}</AMOUNT>`
            + '</BASICORDERALLOCATIONS.LIST>'
            : '<ACCOUNTINGALLOCATIONS.LIST>'
            + `<LEDGERNAME>${esc(i.accountingLedger)}</LEDGERNAME>`
            + `<ISDEEMEDPOSITIVE>${i.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
            + `<AMOUNT>${i.amount.toFixed(2)}</AMOUNT>`
            + '</ACCOUNTINGALLOCATIONS.LIST>')
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
        + (v.partyLedger ? `<PARTYLEDGERNAME>${esc(v.partyLedger)}</PARTYLEDGERNAME>` : '')
        + (v.narration ? `<NARRATION>${esc(v.narration)}</NARRATION>` : '')
        + entries
        + inventory
        + '</VOUCHER></TALLYMESSAGE></REQUESTDATA>'
        + '</IMPORTDATA></BODY></ENVELOPE>';
}

/** Validate a voucher before posting: entries present and debits == credits. */
export function validateVoucher(v: VoucherInput): string | null {
    if (!v.date || !/^\d{8}$/.test(v.date)) return 'date must be YYYYMMDD';
    if (!v.voucherType) return 'voucherType required';
    const inv = v.inventoryEntries || [];
    const entries = v.entries || [];
    // Order vouchers (inventory only, no accounting) legitimately have zero ledger entries.
    const orderStyle = entries.length === 0 && inv.length > 0;
    if (!orderStyle) {
        if (entries.length < 1) return 'at least one ledger entry required';
        if (entries.length < 2 && !inv.length) return 'at least two ledger entries required (or ledger + inventory)';
    }
    for (const e of entries) { if (!e.ledger) return 'ledger entry missing ledger name'; if (typeof e.amount !== 'number' || isNaN(e.amount)) return `bad amount for ${e.ledger}`; }
    for (const i of inv) { if (!i.stockItem) return 'inventory line missing stock item'; if (!i.unit) return `inventory line ${i.stockItem} missing unit`; if (isNaN(i.amount)) return `bad amount for ${i.stockItem}`; }
    // balance = ledger postings + inventory accounting allocations must net to 0 (skip for order-only vouchers)
    if (!orderStyle) {
        const sum = entries.reduce((s, e) => s + e.amount, 0) + inv.reduce((s, i) => s + i.amount, 0);
        if (Math.abs(sum) > 0.005) return `voucher does not balance (sum ${sum.toFixed(2)}; debits must equal credits)`;
    }
    return null;
}

const num = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? parseInt(m[1], 10) || 0 : 0; };

/** Post a voucher to Tally. dryRun builds + validates + returns the XML without sending. */
export async function postVoucher(server: string, port: number, v: VoucherInput,
    opts: { action?: 'Create' | 'Alter'; dryRun?: boolean; log?: (m: string, e?: boolean) => void } = {}): Promise<ImportResult> {
    const log = opts.log || (() => { });
    const err = validateVoucher(v);
    if (err) { log(`voucher invalid: ${err}`, true); return { ok: false, created: 0, altered: 0, errors: 1, message: err, raw: '' }; }
    const xml = buildVoucherImportXml(v, opts.action || 'Create');
    if (opts.dryRun) { log(`[dry-run] would post ${v.voucherType} ${v.voucherNumber || ''} (${v.entries.length} entries):\n${xml}`); return { ok: true, created: 0, altered: 0, errors: 0, message: 'dry-run', raw: xml }; }
    const resp = await postTallyXml(server, port, xml, 60000);
    const created = num(resp, 'CREATED'), altered = num(resp, 'ALTERED'), errors = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = errors === 0 && (created > 0 || altered > 0);
    log(`voucher import: created=${created} altered=${altered} errors=${errors}${lineErr ? ' — ' + lineErr : ''}`, !ok);
    return { ok, created, altered, errors, message: lineErr || (ok ? 'ok' : 'no voucher created'), raw: resp };
}

// --- master prerequisite: ensure a ledger exists before a voucher references it ---
export async function ledgerExists(server: string, port: number, name: string): Promise<boolean> {
    try {
        const xml = buildFetchXmlFiltered('ledger', 'NAME', nameFilter([name]), {});
        const { rows } = parseCollection(await postTallyXml(server, port, xml, 20000), 'ledger');
        return rows.some(r => (r.name || '').toLowerCase() === name.toLowerCase());
    } catch { return false; }
}

/** Create a ledger under a group via Import (masters). */
export async function createLedger(server: string, port: number, name: string, parentGroup: string): Promise<ImportResult> {
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
export async function ensureLedger(server: string, port: number, name: string, parentGroup: string, log?: (m: string, e?: boolean) => void): Promise<boolean> {
    if (await ledgerExists(server, port, name)) return true;
    log?.(`ledger '${name}' missing — creating under '${parentGroup}'`);
    const r = await createLedger(server, port, name, parentGroup);
    if (!r.ok) log?.(`failed to create ledger '${name}': ${r.message}`, true);
    return r.ok;
}
