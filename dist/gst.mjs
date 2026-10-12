import { sfQuery } from './sfClient.mjs';
import { loadMappings } from './sfMapping.mjs';
// Universal GST engine. Nothing here is hardcoded to a company: the tax RATE comes from each
// distributor's product data, INTRA vs INTER-state comes from the two parties' state codes, and
// the GST LEDGER NAMES come from a per-distributor config (so each book's own correctly-classified
// ledgers are used). Only the GST LAW is fixed — intra-state splits into CGST+SGST (half each),
// inter-state is a single IGST — which is uniform across India. We compute the amounts (Tally does
// not auto-calc on XML import) and post them into that company's ledgers.
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Compute the GST ledger postings for a set of line bases + rates. Pure + deterministic.
 *  isPurchase → Input GST (debit); sale → Output GST (credit). intra → CGST+SGST; inter → IGST. */
export function computeGstEntries(lines, opts) {
    let cgst = 0, sgst = 0, igst = 0;
    for (const ln of lines) {
        const rate = Number(ln.rate) || 0;
        const base = Number(ln.base) || 0;
        if (rate <= 0 || base === 0)
            continue;
        const tax = r2(base * rate / 100);
        if (opts.intra) {
            const half = r2(tax / 2);
            cgst += half;
            sgst += r2(tax - half);
        }
        else {
            igst += tax;
        }
    }
    cgst = r2(cgst);
    sgst = r2(sgst);
    igst = r2(igst);
    const sign = opts.isPurchase ? -1 : 1; // purchase tax = debit (<0); sales tax = credit (>0)
    const out = opts.isPurchase
        ? { cgst: opts.cfg.inputCgst, sgst: opts.cfg.inputSgst, igst: opts.cfg.inputIgst }
        : { cgst: opts.cfg.outputCgst, sgst: opts.cfg.outputSgst, igst: opts.cfg.outputIgst };
    const entries = [];
    if (opts.intra) {
        if (cgst > 0) {
            if (!out.cgst)
                return { entries: [], totalTax: 0, error: 'no CGST ledger configured for this distributor' };
            entries.push({ ledger: out.cgst, amount: sign * cgst });
        }
        if (sgst > 0) {
            if (!out.sgst)
                return { entries: [], totalTax: 0, error: 'no SGST ledger configured for this distributor' };
            entries.push({ ledger: out.sgst, amount: sign * sgst });
        }
    }
    else if (igst > 0) {
        if (!out.igst)
            return { entries: [], totalTax: 0, error: 'no IGST ledger configured for this distributor' };
        entries.push({ ledger: out.igst, amount: sign * igst });
    }
    return { entries, totalTax: r2(cgst + sgst + igst) };
}
/** Load this distributor's GST ledger names from Field_Mapping__c (Object_Type='GST'): each row's
 *  Target_Field__c is OutputCGST/OutputSGST/OutputIGST/InputCGST/InputSGST/InputIGST and its
 *  Constant_Value__c is that company's ledger name. Scoped per distributor like other mappings. */
export async function loadGstConfig(sapCode) {
    const maps = await loadMappings('GST', 'ToTally', sapCode);
    const key = {
        OutputCGST: 'outputCgst', OutputSGST: 'outputSgst', OutputIGST: 'outputIgst',
        InputCGST: 'inputCgst', InputSGST: 'inputSgst', InputIGST: 'inputIgst',
    };
    const cfg = {};
    for (const m of maps) {
        const k = key[m.target];
        if (k && m.constant)
            cfg[k] = String(m.constant);
    }
    return cfg;
}
/** Morde-SAP-Id -> GST rate %, from this distributor's product master (Tally_Product__c). */
export async function loadProductGstRates(distAccountId) {
    const out = new Map();
    const rows = await sfQuery(`SELECT SAP_ID__c, GST_Percentage__c FROM Tally_Product__c ` +
        `WHERE Account__c = '${distAccountId.replace(/'/g, "\\'")}' AND GST_Percentage__c != null`);
    for (const r of rows)
        if (r.SAP_ID__c)
            out.set(String(r.SAP_ID__c).toLowerCase(), Number(r.GST_Percentage__c) || 0);
    return out;
}
/** The distributor's own state code (for intra/inter determination). */
export async function loadDistributorState(distAccountId) {
    const rows = await sfQuery(`SELECT BillingStateCode, BillingState FROM Account WHERE Id = '${distAccountId.replace(/'/g, "\\'")}' LIMIT 1`);
    const a = rows[0] || {};
    return String(a.BillingStateCode || a.BillingState || '').trim().toLowerCase();
}
/** Party ledger name -> state code, for this distributor's Tally_Account__c rows (to decide intra/inter). */
export async function loadPartyStates(distAccountId) {
    const out = new Map();
    const rows = await sfQuery(`SELECT Name, BillingAddress__StateCode__s FROM Tally_Account__c ` +
        `WHERE Distributor__c = '${distAccountId.replace(/'/g, "\\'")}' AND BillingAddress__StateCode__s != null`);
    for (const r of rows)
        if (r.Name)
            out.set(String(r.Name).trim().toLowerCase(), String(r.BillingAddress__StateCode__s || '').trim().toLowerCase());
    return out;
}
//# sourceMappingURL=gst.mjs.map