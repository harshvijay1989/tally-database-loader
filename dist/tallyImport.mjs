import { postTallyXml } from './tallyLive.mjs';
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
    const entries = v.entries.map(e => '<ALLLEDGERENTRIES.LIST>'
        + `<LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>`
        + `<ISDEEMEDPOSITIVE>${e.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
        + `<AMOUNT>${e.amount.toFixed(2)}</AMOUNT>`
        + '</ALLLEDGERENTRIES.LIST>').join('');
    const staticVars = v.company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(v.company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
    return '<ENVELOPE>'
        + '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA>'
        + `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${staticVars}</REQUESTDESC>`
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<VOUCHER ACTION="${action}" VCHTYPE="${esc(v.voucherType)}" OBJVIEW="${esc(v.objView || 'Accounting Voucher View')}">`
        + `<DATE>${esc(v.date)}</DATE>`
        + `<EFFECTIVEDATE>${esc(v.date)}</EFFECTIVEDATE>`
        + `<VOUCHERTYPENAME>${esc(v.voucherType)}</VOUCHERTYPENAME>`
        + (v.voucherNumber ? `<VOUCHERNUMBER>${esc(v.voucherNumber)}</VOUCHERNUMBER>` : '')
        + (v.partyLedger ? `<PARTYLEDGERNAME>${esc(v.partyLedger)}</PARTYLEDGERNAME>` : '')
        + (v.narration ? `<NARRATION>${esc(v.narration)}</NARRATION>` : '')
        + entries
        + '</VOUCHER></TALLYMESSAGE></REQUESTDATA>'
        + '</IMPORTDATA></BODY></ENVELOPE>';
}
/** Validate a voucher before posting: entries present and debits == credits. */
export function validateVoucher(v) {
    if (!v.date || !/^\d{8}$/.test(v.date))
        return 'date must be YYYYMMDD';
    if (!v.voucherType)
        return 'voucherType required';
    if (!v.entries || v.entries.length < 2)
        return 'at least two ledger entries required';
    for (const e of v.entries) {
        if (!e.ledger)
            return 'ledger entry missing ledger name';
        if (typeof e.amount !== 'number' || isNaN(e.amount))
            return `bad amount for ${e.ledger}`;
    }
    const sum = v.entries.reduce((s, e) => s + e.amount, 0);
    if (Math.abs(sum) > 0.005)
        return `voucher does not balance (sum ${sum.toFixed(2)}; debits must equal credits)`;
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
//# sourceMappingURL=tallyImport.mjs.map