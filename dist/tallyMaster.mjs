import { postTallyXml, buildFetchXmlFiltered, parseCollection } from './tallyLive.mjs';
import { ledgerExists } from './tallyImport.mjs';
// Master-data helpers for the Account/Product key-exchange (SF <-> Tally).
//  * write the Morde SAP Id onto a Tally master via the DECLARED-UDF plain tag <MORDESAPID>
//    (NOT the <UDF:..LIST DESC=`..`> namespaced form, which silently no-ops for a declared UDF)
//  * read Name + $Guid + $MordeSAPID (+ $AlterId) back via a COMPUTE collection (a bare FETCH
//    drops UDFs). Verified against live TallyPrime. Requires MordeSAPID.tdl loaded.
//
// Identity is the Tally GUID: it is permanent and survives rename, so once SF holds the GUID we
// address the ledger by GUID (look up its current name) and never create a second one on rename.
function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function q(s) { return (s || '').replace(/"/g, ''); } // for inside Tally "..." filter literals
const num = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? parseInt(m[1], 10) || 0 : 0; };
/** GST registration details. The UI reads these from <LEDGSTREGDETAILS.LIST> (a DATED sub-record,
 *  like the mailing address) — the flat <PARTYGSTIN> scalar stores but is never shown, which is why
 *  a ledger could hold a GSTIN that Tally's own GST screens and returns did not see. Confirmed by
 *  entering GST details in the UI and exporting the ledger back. */
function ledgerGstXml(gstin, registrationType, stateName, applicableFrom) {
    if (!gstin && !registrationType)
        return '';
    return '<LEDGSTREGDETAILS.LIST>'
        + `<APPLICABLEFROM>${esc(applicableFrom)}</APPLICABLEFROM>`
        + `<GSTREGISTRATIONTYPE>${esc(registrationType || 'Regular')}</GSTREGISTRATIONTYPE>`
        + (stateName ? `<PLACEOFSUPPLY>${esc(stateName)}</PLACEOFSUPPLY>` : '')
        + (gstin ? `<GSTIN>${esc(gstin)}</GSTIN>` : '')
        + '<ISOTHTERRITORYASSESSEE>No</ISOTHTERRITORYASSESSEE>'
        + '</LEDGSTREGDETAILS.LIST>';
}
/** The ledger's commercial details block. */
function ledgerProfileXml(p, ledgerName) {
    // Party Bank Details live in <PAYMENTDETAILS.LIST> — confirmed by filling the fields in the
    // TallyPrime UI and exporting the ledger back ("List of Accounts"). The flat <BANKDETAILS> /
    // <IFSCODE> / <BANKACCHOLDERNAME> scalars DO store but the UI never reads them, and a
    // <LEDBANKDETAILS.LIST> block is discarded outright — both look like success and show nothing.
    // TRANSACTIONNAME names the entry ('Primary'); it is what distinguishes multiple beneficiaries.
    const b = p.bank;
    const bankXml = (b && (b.name || b.accountNumber || b.ifsc || b.branch || b.upi))
        ? '<PAYMENTDETAILS.LIST>'
            + `<TRANSACTIONNAME>${esc(b.entryName || 'Primary')}</TRANSACTIONNAME>`
            + (b.name ? `<BANKNAME>${esc(b.name)}</BANKNAME>` : '')
            + (b.accountNumber ? `<ACCOUNTNUMBER>${esc(b.accountNumber)}</ACCOUNTNUMBER>` : '')
            + (b.ifsc ? `<IFSCODE>${esc(b.ifsc)}</IFSCODE>` : '')
            + (b.branch ? `<BRANCHNAME>${esc(b.branch)}</BRANCHNAME>` : '')
            + (b.upi ? `<VIRTUALPAYMENTADDRESS>${esc(b.upi)}</VIRTUALPAYMENTADDRESS>` : '')
            + `<PAYMENTFAVOURING>${esc(b.holder || ledgerName)}</PAYMENTFAVOURING>`
            + '</PAYMENTDETAILS.LIST>'
        : '';
    return (typeof p.creditLimit === 'number' ? `<CREDITLIMIT>${p.creditLimit}</CREDITLIMIT>` : '')
        + (typeof p.creditPeriodDays === 'number' && p.creditPeriodDays > 0 ? `<BILLCREDITPERIOD>${Math.round(p.creditPeriodDays)} Days</BILLCREDITPERIOD>` : '')
        + (p.pan ? `<INCOMETAXNUMBER>${esc(p.pan)}</INCOMETAXNUMBER>` : '')
        + (p.gstRegistrationType ? `<GSTREGISTRATIONTYPE>${esc(p.gstRegistrationType)}</GSTREGISTRATIONTYPE>` : '')
        + (p.contactPerson ? `<LEDGERCONTACT>${esc(p.contactPerson)}</LEDGERCONTACT>` : '')
        + (p.mobile ? `<LEDGERMOBILE>${esc(p.mobile)}</LEDGERMOBILE>` : '')
        + bankXml;
}
const hasProfile = (p) => !!p && (typeof p.creditLimit === 'number' || typeof p.creditPeriodDays === 'number' || !!p.pan
    || !!p.gstRegistrationType || !!p.contactPerson || !!p.mobile
    || !!(p.bank && (p.bank.name || p.bank.accountNumber || p.bank.ifsc || p.bank.branch)));
const hasAddr = (a) => !!a && !!((a.lines && a.lines.filter(Boolean).length) || a.city || a.state || a.pincode || a.gstin || a.phone || a.email);
/** The <ADDRESS.LIST> block (street lines plus a trailing "City Pincode" line when present). */
function addressLinesXml(a) {
    const lines = [...(a.lines || []).filter(Boolean)];
    // Only synthesise a trailing "City Pincode" line for addresses WE built from Salesforce. Lines
    // read back from Tally already contain it, and re-appending on every read-merge-write cycle
    // grows the address without bound (observed: "Panjim 403001 / 403001 / 403001").
    if (!a.linesAreComplete) {
        const cityLine = [a.city, a.pincode].filter(Boolean).join(' ').trim();
        if (cityLine)
            lines.push(cityLine);
    }
    if (!lines.length)
        return '';
    return '<ADDRESS.LIST TYPE="String">' + lines.map(l => `<ADDRESS>${esc(l)}</ADDRESS>`).join('') + '</ADDRESS.LIST>';
}
/** Mailing address for a ledger. TallyPrime stores this in <LEDMAILINGDETAILS.LIST> — a flat
 *  <ADDRESS.LIST> on the LEDGER is accepted by the import but SILENTLY DISCARDED (verified live),
 *  which is why ledgers were landing in Tally with no address at all. */
function ledgerMailingXml(a, ledgerName, applicableFrom) {
    const body = addressLinesXml(a)
        + `<MAILINGNAME>${esc(a.mailingName || ledgerName)}</MAILINGNAME>`
        + (a.state ? `<STATE>${esc(a.state)}</STATE>` : '')
        + `<COUNTRY>${esc(a.country || 'India')}</COUNTRY>`
        + (a.pincode ? `<PINCODE>${esc(a.pincode)}</PINCODE>` : '');
    return `<LEDMAILINGDETAILS.LIST><APPLICABLEFROM>${esc(applicableFrom)}</APPLICABLEFROM>${body}</LEDMAILINGDETAILS.LIST>`
        + (a.gstin ? `<PARTYGSTIN>${esc(a.gstin)}</PARTYGSTIN>` : '')
        + (a.phone ? `<LEDGERPHONE>${esc(a.phone)}</LEDGERPHONE>` : '')
        + (a.email ? `<EMAIL>${esc(a.email)}</EMAIL>` : '')
        + (a.state ? `<LEDGERSTATENAME>${esc(a.state)}</LEDGERSTATENAME>` : '');
}
/** Build the Tally FILTER formula for a scoped/incremental read. The scope clauses
 *  (names / guids / sapTagged) are OR-ed (a union); group and sinceAlterId are AND-ed on top. */
function buildKeyFilter(o) {
    const scope = [];
    if (o.names && o.names.length)
        scope.push('(' + o.names.map(n => `$Name = "${q(n)}"`).join(' OR ') + ')');
    if (o.guids && o.guids.length)
        scope.push('(' + o.guids.map(g => `$Guid = "${q(g)}"`).join(' OR ') + ')');
    if (o.sapTaggedOnly)
        scope.push('(NOT $$IsEmpty:$MordeSAPID)');
    const and = [];
    and.push(scope.length ? '(' + scope.join(' OR ') + ')' : 'Yes');
    if (o.group)
        and.push(`$Parent = "${q(o.group)}"`);
    if (typeof o.sinceAlterId === 'number' && o.sinceAlterId > 0)
        and.push(`$AlterId > ${Math.floor(o.sinceAlterId)}`);
    return and.join(' AND ');
}
/** Read Name + GUID + SAP Id + AlterID for ledgers, via a COMPUTE collection (the only reliable
 *  way to project a UDF). Pass scope via opts; with no scope clause it reads every ledger. */
export async function readLedgerKeys(server, port, opts = {}) {
    const filterFormula = buildKeyFilter(opts);
    const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MordeLedKeys</ID></HEADER>'
        + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>'
        + '<TDL><TDLMESSAGE>'
        + '<COLLECTION NAME="MordeLedKeys" ISMODIFY="No" ISINITIALIZE="Yes">'
        + '<TYPE>Ledger</TYPE><FILTER>mordeFlt</FILTER>'
        + '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD>'
        + '<COMPUTE>SapId : $MordeSAPID</COMPUTE>'
        + '<COMPUTE>TallyGuid : $Guid</COMPUTE>'
        + '<COMPUTE>LedState : $LedStateName</COMPUTE>'
        + '<COMPUTE>Gstin : $PartyGSTIN</COMPUTE>'
        + '</COLLECTION>'
        + `<SYSTEM TYPE="Formula" NAME="mordeFlt">${filterFormula}</SYSTEM>`
        + '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 60000);
    return parseMasterKeys(resp, 'LEDGER');
}
/** Resolve a ledger's CURRENT name by its permanent GUID (empty string if not found). */
export async function ledgerNameByGuid(server, port, guid) {
    var _a;
    if (!guid)
        return '';
    const keys = await readLedgerKeys(server, port, { guids: [guid] });
    return ((_a = keys[0]) === null || _a === void 0 ? void 0 : _a.name) || '';
}
/** Parse a COMPUTE-collection export into MasterKey rows, for any master item tag. */
function parseMasterKeys(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*\\bNAME="([^"]*)"[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    const pick = (blk, tag) => { const mm = blk.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i')); return mm ? mm[1].trim() : ''; };
    const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    while ((m = re.exec(xml))) {
        const blk = m[2];
        out.push({
            name: unesc(m[1]),
            guid: pick(blk, 'TALLYGUID'),
            sapId: pick(blk, 'SAPID'),
            parent: pick(blk, 'PARENT'),
            alterId: parseInt(pick(blk, 'ALTERID'), 10) || 0,
            unit: pick(blk, 'BASEUNITS') || undefined,
            state: unesc(pick(blk, 'LEDSTATE')) || undefined,
            gstin: pick(blk, 'GSTIN') || undefined,
        });
    }
    return out;
}
/** Create (if missing) or alter a ledger, writing the Morde SAP Id into the MordeSAPID UDF.
 *  Identity is GUID-first: pass knownGuid when SF already holds one — we then address the
 *  EXISTING ledger (by its current name, resolved from the GUID) and rename it if the desired
 *  name changed, instead of creating a duplicate. Returns the ledger's GUID on success. */
export async function upsertLedgerWithSapId(server, port, name, parentGroup, sapId, opts = {}) {
    var _a, _b, _c, _d;
    const log = opts.log || (() => { });
    // GUID-first identity: if SF already has a GUID, find the ledger's current name by it.
    let currentName = '';
    if (opts.knownGuid)
        currentName = await ledgerNameByGuid(server, port, opts.knownGuid);
    let action;
    let identityName; // the NAME attribute that identifies the ledger in the request
    let renameTo = '';
    if (currentName) {
        action = 'Alter';
        identityName = currentName;
        if (currentName !== name)
            renameTo = name; // SF renamed it -> rename, don't duplicate
    }
    else if (await ledgerExists(server, port, name)) {
        action = 'Alter';
        identityName = name;
    }
    else {
        action = 'Create';
        identityName = name;
    }
    const nameListXml = action === 'Create'
        ? `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>`
        : (renameTo ? `<NAME.LIST TYPE="String"><NAME>${esc(renameTo)}</NAME></NAME.LIST>` : '');
    const parentXml = action === 'Create' ? `<PARENT>${esc(parentGroup)}</PARENT>` : '';
    const sapXml = sapId ? `<MORDESAPID>${esc(sapId)}</MORDESAPID>` : '';
    // Mailing address (street/city/state/pincode + GSTIN/phone/email). Emitted on Alter as well as
    // Create so an address added or corrected in Salesforce reaches an already-synced ledger.
    const addrXml = hasAddr(opts.address)
        ? ledgerMailingXml(opts.address, renameTo || name, opts.applicableFrom || '20000401') : '';
    // Commercial details (credit limit/period, PAN, GST reg type, contact, mobile, bank). Emitted on
    // Alter too, so values added in Salesforce later reach a ledger that already exists.
    const profileXml = hasProfile(opts.profile) ? ledgerProfileXml(opts.profile, renameTo || name) : '';
    // GST registration details, assembled from the address (GSTIN + state) and the profile
    // (registration type) — they belong together in one dated LEDGSTREGDETAILS record.
    const gstXml = ledgerGstXml(((_a = opts.address) === null || _a === void 0 ? void 0 : _a.gstin) || '', ((_b = opts.profile) === null || _b === void 0 ? void 0 : _b.gstRegistrationType) || '', ((_c = opts.address) === null || _c === void 0 ? void 0 : _c.state) || '', opts.applicableFrom || '20000401');
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(identityName)}" ACTION="${action}">${nameListXml}${parentXml}${sapXml}${addrXml}${profileXml}${gstXml}</LEDGER>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const created = num(resp, 'CREATED'), altered = num(resp, 'ALTERED'), errors = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = errors === 0 && (created > 0 || altered > 0);
    log(`ledger ${action} '${identityName}'${renameTo ? ` -> rename '${renameTo}'` : ''} sap='${sapId}': created=${created} altered=${altered} errors=${errors}${lineErr ? ' — ' + lineErr : ''}`, !ok);
    if (!ok)
        return { ok, created, altered, errors, message: lineErr || 'no change' };
    const finalName = renameTo || name;
    const keys = await readLedgerKeys(server, port, { names: [finalName] });
    return { ok, created, altered, errors, message: 'ok', guid: ((_d = keys[0]) === null || _d === void 0 ? void 0 : _d.guid) || opts.knownGuid, renamedFrom: renameTo ? currentName : undefined };
}
/** Add/replace ONE named address in a ledger's "multiple addresses" list. This is where a CUSTOMER's
 *  ship-to / billing address belongs — a customer address is NOT a godown (a godown is one of the
 *  distributor's OWN stock locations). Turns the multi-address feature on for the ledger, then adds
 *  the entry keyed by ADDRESSNAME (re-sending the same name updates it). Verified against live
 *  TallyPrime. Returns true on success. */
export async function setLedgerMultiAddress(server, port, ledgerName, addr, log) {
    const label = (addr.addressName || '').trim();
    if (!ledgerName || !label)
        return false;
    // READ-MERGE-WRITE. Tally REPLACES the whole multi-address list on every Alter, so sending one
    // entry silently deletes every other address on the ledger (verified: adding 'AddrB' after
    // 'AddrA' left only AddrB). Read what is there, swap in/append this one by ADDRESSNAME, and
    // send the complete list back.
    const existing = await readLedgerMultiAddresses(server, port, ledgerName);
    const kept = existing.filter(e => (e.addressName || '').trim().toLowerCase() !== label.toLowerCase());
    const merged = [...kept, addr];
    if (kept.length !== existing.length)
        log === null || log === void 0 ? void 0 : log(`  ledger '${ledgerName}': updating existing address '${label}'`);
    const entryXml = (a) => '<LEDMULTIADDRESSLIST.LIST>'
        + `<ADDRESSNAME>${esc((a.addressName || '').trim())}</ADDRESSNAME>`
        + addressLinesXml(a)
        + (a.state ? `<STATE>${esc(a.state)}</STATE>` : '')
        + `<COUNTRY>${esc(a.country || 'India')}</COUNTRY>`
        + (a.pincode ? `<PINCODE>${esc(a.pincode)}</PINCODE>` : '')
        + (a.gstin ? `<PARTYGSTIN>${esc(a.gstin)}</PARTYGSTIN>` : '')
        + (a.phone ? `<PHONENUMBER>${esc(a.phone)}</PHONENUMBER>` : '')
        + (a.email ? `<EMAIL>${esc(a.email)}</EMAIL>` : '')
        + '</LEDMULTIADDRESSLIST.LIST>';
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(ledgerName)}" ACTION="Alter">`
        + '<ISMULTIADDRESSAPPLICABLE>Yes</ISMULTIADDRESSAPPLICABLE>'
        + merged.map(entryXml).join('')
        + '</LEDGER>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = (num(resp, 'ALTERED') + num(resp, 'CREATED')) > 0 && !lineErr;
    log === null || log === void 0 ? void 0 : log(`ledger '${ledgerName}' address '${label}': ${ok ? `set (${merged.length} address(es) on ledger)` : 'FAILED — ' + (lineErr || 'no change')}`, !ok);
    return ok;
}
/** Read a ledger's existing "multiple addresses". Used to merge rather than clobber them. */
export async function readLedgerMultiAddresses(server, port, ledgerName) {
    const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MordeLedAddr</ID></HEADER>'
        + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>'
        + '<TDL><TDLMESSAGE>'
        + '<COLLECTION NAME="MordeLedAddr" ISMODIFY="No" ISINITIALIZE="Yes">'
        + '<TYPE>Ledger</TYPE><FILTER>mordeAddrFlt</FILTER><FETCH>Name</FETCH><FETCH>LedMultiAddressList</FETCH>'
        + '</COLLECTION>'
        + `<SYSTEM TYPE="Formula" NAME="mordeAddrFlt">$Name = "${q(ledgerName)}"</SYSTEM>`
        + '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
    let resp = '';
    try {
        resp = await postTallyXml(server, port, xml, 30000);
    }
    catch {
        return [];
    }
    const out = [];
    const blocks = resp.match(/<LEDMULTIADDRESSLIST\.LIST>[\s\S]*?<\/LEDMULTIADDRESSLIST\.LIST>/gi) || [];
    for (const b of blocks) {
        const one = (tag) => { const m = b.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? m[1].trim() : ''; };
        const name = one('ADDRESSNAME');
        if (!name)
            continue;
        const lines = [...(b.match(/<ADDRESS>([^<]*)<\/ADDRESS>/gi) || [])]
            .map(s => s.replace(/<\/?ADDRESS>/gi, '').trim()).filter(Boolean);
        out.push({
            addressName: name, lines, linesAreComplete: true, state: one('STATE'), pincode: one('PINCODE'),
            country: one('COUNTRY') || 'India', gstin: one('PARTYGSTIN') || undefined,
            phone: one('PHONENUMBER') || undefined, email: one('EMAIL') || undefined,
        });
    }
    return out;
}
/** Ensure a STOCK GROUP (product category) exists, optionally nested under a parent group.
 *  Used to mirror the SF Category__c > SubCategory__c hierarchy into Tally. Idempotent: a
 *  duplicate create is reported by Tally and treated as success. */
export async function ensureStockGroup(server, port, name, parent, log) {
    const n = (name || '').trim();
    if (!n)
        return false;
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<STOCKGROUP NAME="${esc(n)}" ACTION="Create"><NAME.LIST><NAME>${esc(n)}</NAME></NAME.LIST>`
        + ((parent || '').trim() ? `<PARENT>${esc(parent.trim())}</PARENT>` : '')
        + '<ISADDABLE>Yes</ISADDABLE></STOCKGROUP>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = num(resp, 'CREATED') > 0 || /duplicate|already exist/i.test(lineErr);
    if (!ok)
        log === null || log === void 0 ? void 0 : log(`stock group '${n}': create failed — ${lineErr}`, true);
    return ok;
}
/** Write only the SAP Id onto an existing ledger (used when SF later assigns a SAP Id). */
export async function setLedgerSapId(server, port, name, sapId, log) {
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(name)}" ACTION="Alter"><MORDESAPID>${esc(sapId)}</MORDESAPID></LEDGER>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const ok = (num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS')) === 0 && num(resp, 'ALTERED') > 0;
    log === null || log === void 0 ? void 0 : log(`set sap on '${name}' = '${sapId}': ${ok ? 'ok' : 'failed'}`, !ok);
    return ok;
}
// ============================================================================
//  Godown (warehouse/location) — SF <-> Tally, both ways. Identity is GUID + name
//  only (no SAP UDF). Mirrors the ledger master pattern.
// ============================================================================
/** Read Name + GUID + Parent + AlterID for godowns (COMPUTE collection). Pass sinceAlterId for an
 *  incremental read. Reuses parseMasterKeys (SAP/unit stay empty for godowns). */
export async function readGodownKeys(server, port, opts = {}) {
    const filterFormula = buildKeyFilter(opts);
    const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MordeGodownKeys</ID></HEADER>'
        + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>'
        + '<TDL><TDLMESSAGE>'
        + '<COLLECTION NAME="MordeGodownKeys" ISMODIFY="No" ISINITIALIZE="Yes">'
        + '<TYPE>Godown</TYPE><FILTER>mordeFlt</FILTER>'
        + '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD>'
        + '<COMPUTE>TallyGuid : $Guid</COMPUTE>'
        + '</COLLECTION>'
        + `<SYSTEM TYPE="Formula" NAME="mordeFlt">${filterFormula}</SYSTEM>`
        + '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 60000);
    return parseMasterKeys(resp, 'GODOWN');
}
/** Resolve a godown's CURRENT name by its permanent GUID (empty if not found). */
export async function godownNameByGuid(server, port, guid) {
    var _a;
    if (!guid)
        return '';
    const keys = await readGodownKeys(server, port, { guids: [guid] });
    return ((_a = keys[0]) === null || _a === void 0 ? void 0 : _a.name) || '';
}
/** True if a godown with this exact name already exists. */
async function godownExists(server, port, name) {
    if (!name)
        return false;
    try {
        return (await readGodownKeys(server, port, { names: [name] })).some(k => k.name.toLowerCase() === name.toLowerCase());
    }
    catch {
        return false;
    }
}
/** Create (if missing) or alter a godown. GUID-first identity like upsertLedgerWithSapId: when a
 *  knownGuid is supplied we address the EXISTING godown by its current name and rename it if the
 *  desired name changed, rather than creating a duplicate. Returns the godown's GUID on success. */
export async function upsertGodown(server, port, name, parent, opts = {}) {
    var _a;
    const log = opts.log || (() => { });
    let currentName = '';
    if (opts.knownGuid)
        currentName = await godownNameByGuid(server, port, opts.knownGuid);
    let action;
    let identityName;
    let renameTo = '';
    if (currentName) {
        action = 'Alter';
        identityName = currentName;
        if (currentName !== name)
            renameTo = name;
    }
    else if (await godownExists(server, port, name)) {
        action = 'Alter';
        identityName = name;
    }
    else {
        action = 'Create';
        identityName = name;
    }
    const nameListXml = action === 'Create'
        ? `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>`
        : (renameTo ? `<NAME.LIST TYPE="String"><NAME>${esc(renameTo)}</NAME></NAME.LIST>` : '');
    // Parent is only meaningful on create (a godown's "Under"); omit when empty.
    const parentXml = (action === 'Create' && parent) ? `<PARENT>${esc(parent)}</PARENT>` : '';
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE>'
        + `<GODOWN NAME="${esc(identityName)}" ACTION="${action}">${nameListXml}${parentXml}</GODOWN>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const created = num(resp, 'CREATED'), altered = num(resp, 'ALTERED'), errors = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = errors === 0 && (created > 0 || altered > 0);
    log(`godown ${action} '${identityName}'${renameTo ? ` -> rename '${renameTo}'` : ''}: created=${created} altered=${altered} errors=${errors}${lineErr ? ' — ' + lineErr : ''}`, !ok);
    if (!ok)
        return { ok, created, altered, errors, message: lineErr || 'no change' };
    const finalName = renameTo || name;
    const keys = await readGodownKeys(server, port, { names: [finalName] });
    return { ok, created, altered, errors, message: 'ok', guid: ((_a = keys[0]) === null || _a === void 0 ? void 0 : _a.guid) || opts.knownGuid, renamedFrom: renameTo ? currentName : undefined };
}
/** True when the active company has MULTIPLE GODOWNS enabled. Confirmed live: the Company native
 *  method `$IsMultiGodownOn` returns a Logical "Yes"/"No" (the `$$PrimaryGodown`/`$$IsGodownOn`
 *  functions returned nothing on this build, so they are NOT used). Returns false on any doubt. */
async function isMultiGodownOn(server, port) {
    try {
        const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MordeCoGodown</ID></HEADER>'
            + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>'
            + '<TDL><TDLMESSAGE>'
            + '<COLLECTION NAME="MordeCoGodown" ISMODIFY="No" ISINITIALIZE="Yes"><TYPE>Company</TYPE><FILTER>actflt</FILTER>'
            + '<COMPUTE>MultiGodown : $IsMultiGodownOn</COMPUTE></COLLECTION>'
            + '<SYSTEM TYPE="Formula" NAME="actflt">$$IsEqual:$Name:##SVCurrentCompany</SYSTEM>'
            + '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
        const resp = await postTallyXml(server, port, xml, 20000);
        const m = resp.match(/<MULTIGODOWN[^>]*>([^<]*)<\/MULTIGODOWN>/i);
        return !!m && /^\s*yes\s*$/i.test(m[1]);
    }
    catch {
        return false;
    }
}
/** Resolve the company's PRIMARY godown name to default inventory lines to — but ONLY when the
 *  company has multiple godowns enabled. Once multi-godown is on, Tally REJECTS an inventory line
 *  that carries no batch/godown allocation, so every line must name a godown. When multi-godown is
 *  OFF (single-location company), returns '' so callers emit no allocation (today's behaviour,
 *  byte-identical XML). Primary is resolved by name: 'Main Location' (Tally's standard default),
 *  then 'Primary', else the first godown. Resilient: any failure -> '' (safe, unchanged behaviour). */
export async function resolveDefaultGodown(server, port) {
    try {
        if (!(await isMultiGodownOn(server, port)))
            return '';
        const godowns = await readGodownKeys(server, port, {});
        const names = godowns.map(g => g.name).filter(Boolean);
        if (!names.length)
            return '';
        const byName = (want) => names.find(n => n.toLowerCase() === want.toLowerCase());
        return byName('Main Location') || byName('Primary') || names[0];
    }
    catch {
        return '';
    }
}
// ============================================================================
//  Stock Item (Product) — SF -> Tally only. Same MordeSAPID UDF + GUID identity
//  as ledgers, but the master is a StockItem which additionally needs base units.
// ============================================================================
/** True if a simple unit with this symbol already exists in Tally. Tally can return a unit's
 *  NAME oddly (e.g. "pcs; pcs"), so each returned name is split on ; and , and trimmed. */
export async function unitExists(server, port, symbol) {
    const unit = (symbol || '').trim().toLowerCase();
    if (!unit)
        return false;
    try {
        const { rows } = parseCollection(await postTallyXml(server, port, buildFetchXmlFiltered('unit', 'NAME', 'Yes', {}), 20000), 'unit');
        for (const r of rows) {
            const parts = String(r.name || '').split(/[;,]/).map(s => s.trim().toLowerCase());
            if (parts.includes(unit))
                return true;
        }
    }
    catch { /* treat as absent */ }
    return false;
}
/** Tally simple-unit symbols reject spaces and slashes (a descriptive UOM like "Carton Box" or a
 *  symbol like "C/B" fails as "BAD UNIT NAME"). Reduce any UOM to a Tally-valid alphanumeric symbol
 *  (letters/digits/%); used for BOTH the unit master and a stock item's base unit so they always
 *  match. Empty -> 'Nos'. "Carton Box" -> "CartonBox", "C/B" -> "CB", "KG" -> "KG". */
export function tallyUnitSymbol(s) {
    return ((s || '').trim().replace(/[^A-Za-z0-9%]+/g, '')) || 'Nos';
}
/** Ensure a simple unit of measure exists in Tally (create if missing). The create uses a plain
 *  <NAME> (a NAME.LIST is rejected as "BAD UNIT NAME" for units). */
export async function ensureUnit(server, port, symbol, log) {
    const unit = tallyUnitSymbol(symbol);
    if (!unit)
        return false;
    if (await unitExists(server, port, unit))
        return true;
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE>'
        + `<UNIT NAME="${esc(unit)}" ACTION="Create"><NAME>${esc(unit)}</NAME>`
        + '<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>2</DECIMALPLACES></UNIT>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    // "duplicate" means it already exists under the hood -> treat as present.
    const ok = (num(resp, 'CREATED') > 0) || /duplicate/i.test(lineErr);
    log === null || log === void 0 ? void 0 : log(`unit '${unit}': ${num(resp, 'CREATED') > 0 ? 'created' : (ok ? 'already present' : 'create failed — ' + lineErr)}`, !ok);
    return ok;
}
/** Ensure a stock item exists (create a minimal one — name + base unit — if missing). This is the
 *  voucher-time safety net so an inventory line never references a non-existent item; the full
 *  product sync (with SAP Id + GST) is what creates items properly. Returns true if present/created. */
export async function ensureStockItem(server, port, name, baseUnit, log) {
    if (!name)
        return false;
    try {
        if ((await readStockItemKeys(server, port, { names: [name] })).length > 0)
            return true;
    }
    catch { /* treat as missing */ }
    log === null || log === void 0 ? void 0 : log(`stock item '${name}' missing — creating (unit '${baseUnit || 'pcs'}')`);
    const r = await upsertStockItemWithSapId(server, port, name, baseUnit || 'pcs', '', { log });
    if (!r.ok)
        log === null || log === void 0 ? void 0 : log(`failed to create stock item '${name}': ${r.message}`, true);
    return r.ok;
}
/** Read Name + GUID + SAP Id + AlterID for stock items (COMPUTE collection). */
export async function readStockItemKeys(server, port, opts = {}) {
    const filterFormula = buildKeyFilter(opts);
    const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MordeItemKeys</ID></HEADER>'
        + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>'
        + '<TDL><TDLMESSAGE>'
        + '<COLLECTION NAME="MordeItemKeys" ISMODIFY="No" ISINITIALIZE="Yes">'
        + '<TYPE>StockItem</TYPE><FILTER>mordeFlt</FILTER>'
        + '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>AlterId</NATIVEMETHOD><NATIVEMETHOD>BaseUnits</NATIVEMETHOD>'
        + '<COMPUTE>SapId : $MordeSAPID</COMPUTE>'
        + '<COMPUTE>TallyGuid : $Guid</COMPUTE>'
        + '</COLLECTION>'
        + `<SYSTEM TYPE="Formula" NAME="mordeFlt">${filterFormula}</SYSTEM>`
        + '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 60000);
    return parseMasterKeys(resp, 'STOCKITEM');
}
/** Resolve a stock item's CURRENT name by its permanent GUID (empty if not found). */
export async function stockItemNameByGuid(server, port, guid) {
    var _a;
    if (!guid)
        return '';
    const keys = await readStockItemKeys(server, port, { guids: [guid] });
    return ((_a = keys[0]) === null || _a === void 0 ? void 0 : _a.name) || '';
}
/** Build the GST details block for a stock item from a single total GST rate (e.g. 18).
 *  CGST and SGST each get half; IGST gets the full rate — matching how Tally stores it, so the
 *  distributor's own invoices and GST returns auto-calculate correctly. */
function gstDetailsXml(gstRate, hsn) {
    const half = (gstRate / 2);
    const rd = (head, rate) => `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD>`
        + `<GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>`
        + `<GSTRATE>${rate}</GSTRATE></RATEDETAILS.LIST>`;
    return '<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>'
        + '<GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>'
        + '<GSTDETAILS.LIST>'
        + '<APPLICABLEFROM>20170701</APPLICABLEFROM>'
        + '<CALCULATIONTYPE>On Value</CALCULATIONTYPE>'
        + (hsn ? `<HSNCODE>${esc(hsn)}</HSNCODE><HSN>${esc(hsn)}</HSN>` : '')
        + '<TAXABILITY>Taxable</TAXABILITY>'
        + '<SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>'
        + '<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>'
        + rd('CGST', half) + rd('SGST/UTGST', half) + rd('IGST', gstRate)
        + '</STATEWISEDETAILS.LIST>'
        + '</GSTDETAILS.LIST>';
}
/** Create (if missing) or alter a stock item, writing the Morde SAP Id into the MordeSAPID UDF.
 *  GUID-first identity (same as ledgers): pass knownGuid to address an existing item by GUID and
 *  rename it instead of creating a duplicate. Ensures the base unit exists first. Pass gstRate (and
 *  optionally hsn) to set GST details so Tally can auto-calculate tax on the distributor's sales. */
export async function upsertStockItemWithSapId(server, port, name, baseUnit, sapId, opts = {}) {
    var _a;
    const log = opts.log || (() => { });
    // Sanitize once so the unit master (ensureUnit) and this item's <BASEUNITS> use the identical
    // Tally-valid symbol — a raw "Carton Box"/"C/B" would fail unit creation with BAD UNIT NAME.
    const unit = tallyUnitSymbol(baseUnit || 'Nos');
    await ensureUnit(server, port, unit, log);
    let currentName = '';
    if (opts.knownGuid)
        currentName = await stockItemNameByGuid(server, port, opts.knownGuid);
    let action;
    let identityName;
    let renameTo = '';
    if (currentName) {
        action = 'Alter';
        identityName = currentName;
        if (currentName !== name)
            renameTo = name;
    }
    else if ((await readStockItemKeys(server, port, { names: [name] })).length > 0) {
        action = 'Alter';
        identityName = name;
    }
    else {
        action = 'Create';
        identityName = name;
    }
    const nameListXml = action === 'Create'
        ? `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>`
        : (renameTo ? `<NAME.LIST TYPE="String"><NAME>${esc(renameTo)}</NAME></NAME.LIST>` : '');
    const baseUnitsXml = action === 'Create' ? `<BASEUNITS>${esc(unit)}</BASEUNITS>` : '';
    // Stock group (product category). Emitted on Alter as well as Create so items that were
    // created before category sync existed get re-grouped instead of staying under the default.
    const parentXml = opts.stockGroup ? `<PARENT>${esc(opts.stockGroup)}</PARENT>` : '';
    const sapXml = sapId ? `<MORDESAPID>${esc(sapId)}</MORDESAPID>` : '';
    const gstXml = (typeof opts.gstRate === 'number' && opts.gstRate >= 0) ? gstDetailsXml(opts.gstRate, opts.hsn) : '';
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<STOCKITEM NAME="${esc(identityName)}" ACTION="${action}">${nameListXml}${parentXml}${baseUnitsXml}${sapXml}${gstXml}</STOCKITEM>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const created = num(resp, 'CREATED'), altered = num(resp, 'ALTERED'), errors = num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS');
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = errors === 0 && (created > 0 || altered > 0);
    log(`stock item ${action} '${identityName}'${renameTo ? ` -> rename '${renameTo}'` : ''} sap='${sapId}' unit='${unit}': created=${created} altered=${altered} errors=${errors}${lineErr ? ' — ' + lineErr : ''}`, !ok);
    if (!ok)
        return { ok, created, altered, errors, message: lineErr || 'no change' };
    const finalName = renameTo || name;
    const keys = await readStockItemKeys(server, port, { names: [finalName] });
    return { ok, created, altered, errors, message: 'ok', guid: ((_a = keys[0]) === null || _a === void 0 ? void 0 : _a.guid) || opts.knownGuid, renamedFrom: renameTo ? currentName : undefined };
}
//# sourceMappingURL=tallyMaster.mjs.map