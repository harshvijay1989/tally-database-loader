import { sfQuery } from './sfClient.mjs';
import { loadMappings } from './sfMapping.mjs';
import { postTallyXml, buildFetchXmlFiltered, nameFilter, parseCollection } from './tallyLive.mjs';

// Universal GST engine. Nothing here is hardcoded to a company: the tax RATE comes from each
// distributor's product data, INTRA vs INTER-state comes from the two parties' state codes, and
// the GST LEDGER NAMES come from a per-distributor config (so each book's own correctly-classified
// ledgers are used). Only the GST LAW is fixed — intra-state splits into CGST+SGST (half each),
// inter-state is a single IGST — which is uniform across India. We compute the amounts (Tally does
// not auto-calc on XML import) and post them into that company's ledgers.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Per-distributor GST ledger names (output = sales side, input = purchase side). */
export interface GstLedgerConfig {
    outputCgst?: string; outputSgst?: string; outputIgst?: string;
    inputCgst?: string; inputSgst?: string; inputIgst?: string;
}
export interface GstLine { base: number; rate: number; } // rate = total GST % for the item (e.g. 18)
export interface GstEntry { ledger: string; amount: number; } // signed: <0 debit, >0 credit
export interface GstResult { entries: GstEntry[]; totalTax: number; error?: string; }

/** Compute the GST ledger postings for a set of line bases + rates. Pure + deterministic.
 *  isPurchase → Input GST (debit); sale → Output GST (credit). intra → CGST+SGST; inter → IGST. */
export function computeGstEntries(lines: GstLine[], opts: { intra: boolean; isPurchase: boolean; cfg: GstLedgerConfig }): GstResult {
    let cgst = 0, sgst = 0, igst = 0;
    for (const ln of lines) {
        const rate = Number(ln.rate) || 0;
        const base = Number(ln.base) || 0;
        if (rate <= 0 || base === 0) continue;
        const tax = r2(base * rate / 100);
        if (opts.intra) { const half = r2(tax / 2); cgst += half; sgst += r2(tax - half); }
        else { igst += tax; }
    }
    cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst);
    const sign = opts.isPurchase ? -1 : 1; // purchase tax = debit (<0); sales tax = credit (>0)
    const out = opts.isPurchase
        ? { cgst: opts.cfg.inputCgst, sgst: opts.cfg.inputSgst, igst: opts.cfg.inputIgst }
        : { cgst: opts.cfg.outputCgst, sgst: opts.cfg.outputSgst, igst: opts.cfg.outputIgst };
    const entries: GstEntry[] = [];
    if (opts.intra) {
        if (cgst > 0) { if (!out.cgst) return { entries: [], totalTax: 0, error: 'no CGST ledger configured for this distributor' }; entries.push({ ledger: out.cgst, amount: sign * cgst }); }
        if (sgst > 0) { if (!out.sgst) return { entries: [], totalTax: 0, error: 'no SGST ledger configured for this distributor' }; entries.push({ ledger: out.sgst, amount: sign * sgst }); }
    } else if (igst > 0) {
        if (!out.igst) return { entries: [], totalTax: 0, error: 'no IGST ledger configured for this distributor' };
        entries.push({ ledger: out.igst, amount: sign * igst });
    }
    return { entries, totalTax: r2(cgst + sgst + igst) };
}

// Our own standard, rate-agnostic GST ledgers. Used on every company so names are predictable;
// the connector creates them (correctly classified) if absent. A distributor can override any of
// these via Field_Mapping__c (Object_Type='GST') to point at their own existing ledgers instead.
export const DEFAULT_GST_LEDGERS: GstLedgerConfig = {
    outputCgst: 'Output CGST', outputSgst: 'Output SGST', outputIgst: 'Output IGST',
    inputCgst: 'Input CGST', inputSgst: 'Input SGST', inputIgst: 'Input IGST',
};
// The GST tax type (duty head) each config slot must be classified as.
const SUBTAX: Record<keyof GstLedgerConfig, string> = {
    outputCgst: 'CGST', outputSgst: 'SGST/UTGST', outputIgst: 'IGST',
    inputCgst: 'CGST', inputSgst: 'SGST/UTGST', inputIgst: 'IGST',
};

function escXml(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** Ensure one GST ledger exists and is correctly classified (Duties & Taxes / GST / <subTaxType>).
 *  An already-existing ledger is trusted (the accountant configured it). A newly created one is
 *  read back and verified — if it is NOT classified as GST/<subTaxType>, we return false rather
 *  than risk posting tax into a mis-classified ledger (which would break GST returns). */
async function ensureGstLedger(server: string, port: number, name: string, subTaxType: string,
    log?: (m: string, e?: boolean) => void): Promise<boolean> {
    try {
        const { rows } = parseCollection(await postTallyXml(server, port, buildFetchXmlFiltered('ledger', 'NAME', nameFilter([name]), {}), 15000), 'ledger');
        if (rows.some(r => (r.name || '').toLowerCase() === name.toLowerCase())) return true;
    } catch { /* treat as missing */ }
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE>'
        + `<LEDGER NAME="${escXml(name)}" ACTION="Create"><NAME.LIST><NAME>${escXml(name)}</NAME></NAME.LIST>`
        + '<PARENT>Duties &amp; Taxes</PARENT><TAXTYPE>GST</TAXTYPE>'
        + `<SUBTAXTYPE>${escXml(subTaxType)}</SUBTAXTYPE></LEDGER>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const r = await postTallyXml(server, port, xml, 20000);
    const created = /<CREATED>(\d+)/.exec(r)?.[1]; const errs = /<ERRORS>(\d+)/.exec(r)?.[1];
    if (created !== '1' || (errs && errs !== '0')) { log?.(`GST ledger '${name}' create failed`, true); return false; }
    // verify classification
    try {
        const rx = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GL</ID></HEADER>'
            + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>'
            + '<COLLECTION NAME="GL" ISMODIFY="No" ISINITIALIZE="Yes"><TYPE>Ledger</TYPE><FILTER>f</FILTER><FETCH>Name,TaxType,SubTaxType</FETCH></COLLECTION>'
            + `<SYSTEM TYPE="Formula" NAME="f">$Name = "${name.replace(/"/g, '')}"</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
        const rr = await postTallyXml(server, port, rx, 15000);
        const tt = (rr.match(/<TAXTYPE[^>]*>([^<]*)/i) || [])[1]?.trim() || '';
        const st = (rr.match(/<SUBTAXTYPE[^>]*>([^<]*)/i) || [])[1]?.trim() || '';
        const ok = /gst/i.test(tt) && st.toLowerCase() === subTaxType.toLowerCase();
        log?.(`GST ledger '${name}' created (TaxType=${tt}, SubTaxType=${st})${ok ? '' : ' — NOT correctly classified!'}`, !ok);
        return ok;
    } catch { log?.(`GST ledger '${name}' created but could not verify classification`, true); return false; }
}

/** Ensure all configured GST ledgers exist and are correctly classified. Returns '' on success,
 *  or an error message naming the first ledger that could not be ensured. */
export async function ensureGstLedgers(server: string, port: number, cfg: GstLedgerConfig,
    log?: (m: string, e?: boolean) => void): Promise<string> {
    for (const k of Object.keys(cfg) as (keyof GstLedgerConfig)[]) {
        const name = cfg[k];
        if (!name) continue;
        if (!(await ensureGstLedger(server, port, name, SUBTAX[k], log)))
            return `GST ledger '${name}' is missing and could not be created/classified`;
    }
    return '';
}

/** Load this distributor's GST ledger names from Field_Mapping__c (Object_Type='GST'): each row's
 *  Target_Field__c is OutputCGST/OutputSGST/OutputIGST/InputCGST/InputSGST/InputIGST and its
 *  Constant_Value__c is that company's ledger name. Scoped per distributor like other mappings. */
export async function loadGstConfig(sapCode: string): Promise<GstLedgerConfig> {
    const maps = await loadMappings('GST', 'ToTally', sapCode);
    const key: Record<string, keyof GstLedgerConfig> = {
        OutputCGST: 'outputCgst', OutputSGST: 'outputSgst', OutputIGST: 'outputIgst',
        InputCGST: 'inputCgst', InputSGST: 'inputSgst', InputIGST: 'inputIgst',
    };
    const cfg: GstLedgerConfig = { ...DEFAULT_GST_LEDGERS }; // our standard ledgers by default
    for (const m of maps) { const k = key[m.target]; if (k && m.constant) (cfg as any)[k] = String(m.constant); } // per-distributor override
    return cfg;
}

/** Morde-SAP-Id -> GST rate %, from this distributor's product master (Tally_Product__c). */
export async function loadProductGstRates(distAccountId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const rows = await sfQuery(
        `SELECT SAP_ID__c, GST_Percentage__c FROM Tally_Product__c ` +
        `WHERE Account__c = '${distAccountId.replace(/'/g, "\\'")}' AND GST_Percentage__c != null`);
    for (const r of rows) if (r.SAP_ID__c) out.set(String(r.SAP_ID__c).toLowerCase(), Number(r.GST_Percentage__c) || 0);
    return out;
}

/** First 2 digits of an Indian GSTIN are the GST state code (e.g. 27 = Maharashtra).
 *  Both sides of the intra/inter test are derived this way so they compare like-for-like;
 *  anything without a parseable GSTIN returns '' and the caller defaults to intra. */
export function stateFromGstin(gstin: string | null | undefined): string {
    const g = String(gstin || '').trim();
    return /^[0-9]{2}/.test(g) ? g.slice(0, 2) : '';
}

/** The distributor's own state code (for intra/inter determination), from its GSTIN. */
export async function loadDistributorState(distAccountId: string): Promise<string> {
    try {
        const rows = await sfQuery(`SELECT GST__c FROM Account WHERE Id = '${distAccountId.replace(/'/g, "\\'")}' LIMIT 1`);
        return stateFromGstin(rows[0] && rows[0].GST__c);
    } catch { return ''; } // no GSTIN field/value -> unknown -> caller defaults to intra
}

/** Party ledger name -> GST state code, from this distributor's Tally_Account__c GSTINs (to decide intra/inter). */
export async function loadPartyStates(distAccountId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
        const rows = await sfQuery(
            `SELECT Name, GSTIN__c FROM Tally_Account__c ` +
            `WHERE Distributor__c = '${distAccountId.replace(/'/g, "\\'")}' AND GSTIN__c != null`);
        for (const r of rows) { const st = stateFromGstin(r.GSTIN__c); if (r.Name && st) out.set(String(r.Name).trim().toLowerCase(), st); }
    } catch { /* no GSTIN field/value -> empty -> caller defaults to intra */ }
    return out;
}
