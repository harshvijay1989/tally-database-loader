import { postTallyXml, buildFetchXmlFiltered, nameFilter, parseCollection } from './tallyLive.mjs';
import { ledgerExists } from './tallyImport.mjs';

// Master-data helpers for the Account/Product key-exchange (SF <-> Tally).
//  * write the Morde SAP Id onto a Tally master via the DECLARED-UDF plain tag <MORDESAPID>
//    (NOT the <UDF:..LIST DESC=`..`> namespaced form, which silently no-ops for a declared UDF)
//  * read Name + $Guid + $MordeSAPID (+ $AlterId) back via a COMPUTE collection (a bare FETCH
//    drops UDFs). Verified against live TallyPrime. Requires MordeSAPID.tdl loaded.
//
// Identity is the Tally GUID: it is permanent and survives rename, so once SF holds the GUID we
// address the ledger by GUID (look up its current name) and never create a second one on rename.

function esc(s: any): string {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function q(s: string): string { return (s || '').replace(/"/g, ''); } // for inside Tally "..." filter literals
const num = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? parseInt(m[1], 10) || 0 : 0; };

/** A postal address destined for a Tally ledger (mailing address or one multi-address entry). */
export interface TallyAddress {
    lines?: string[];     // street lines (city/pincode are appended as a final line by the caller if wanted)
    city?: string;
    state?: string;       // Tally wants the state NAME ('Maharashtra'), not the SF code ('MH')
    pincode?: string;
    country?: string;     // defaults to 'India'
    gstin?: string;
    phone?: string;
    email?: string;
    mailingName?: string; // defaults to the ledger name
    addressName?: string; // multi-address entries only: the label shown in Tally's address list
}

/** Commercial/identity details that live on a Tally ledger alongside the address. All optional —
 *  each tag is emitted only when we have a value, so a ledger with none is byte-identical to before.
 *  Tag names verified against live TallyPrime (a wrong tag is accepted and silently ignored). */
export interface LedgerProfile {
    creditLimit?: number;       // -> <CREDITLIMIT>
    creditPeriodDays?: number;  // -> <BILLCREDITPERIOD> ('30 Days')
    pan?: string;               // -> <INCOMETAXNUMBER>
    gstRegistrationType?: string; // -> <GSTREGISTRATIONTYPE> (Regular / Composition / Unregistered ...)
    contactPerson?: string;     // -> <LEDGERCONTACT>
    mobile?: string;            // -> <LEDGERMOBILE>
    bank?: { name?: string; accountNumber?: string; ifsc?: string; branch?: string; holder?: string; upi?: string; entryName?: string };
}

/** GST registration details. The UI reads these from <LEDGSTREGDETAILS.LIST> (a DATED sub-record,
 *  like the mailing address) — the flat <PARTYGSTIN> scalar stores but is never shown, which is why
 *  a ledger could hold a GSTIN that Tally's own GST screens and returns did not see. Confirmed by
 *  entering GST details in the UI and exporting the ledger back. */
function ledgerGstXml(gstin: string, registrationType: string, stateName: string, applicableFrom: string): string {
    if (!gstin && !registrationType) return '';
    return '<LEDGSTREGDETAILS.LIST>'
        + `<APPLICABLEFROM>${esc(applicableFrom)}</APPLICABLEFROM>`
        + `<GSTREGISTRATIONTYPE>${esc(registrationType || 'Regular')}</GSTREGISTRATIONTYPE>`
        + (stateName ? `<PLACEOFSUPPLY>${esc(stateName)}</PLACEOFSUPPLY>` : '')
        + (gstin ? `<GSTIN>${esc(gstin)}</GSTIN>` : '')
        + '<ISOTHTERRITORYASSESSEE>No</ISOTHTERRITORYASSESSEE>'
        + '</LEDGSTREGDETAILS.LIST>';
}

/** The ledger's commercial details block. */
function ledgerProfileXml(p: LedgerProfile, ledgerName: string): string {
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

const hasProfile = (p?: LedgerProfile) =>
    !!p && (typeof p.creditLimit === 'number' || typeof p.creditPeriodDays === 'number' || !!p.pan
        || !!p.gstRegistrationType || !!p.contactPerson || !!p.mobile
        || !!(p.bank && (p.bank.name || p.bank.accountNumber || p.bank.ifsc || p.bank.branch)));

const hasAddr = (a?: TallyAddress) =>
    !!a && !!((a.lines && a.lines.filter(Boolean).length) || a.city || a.state || a.pincode || a.gstin || a.phone || a.email);

/** The <ADDRESS.LIST> block (street lines plus a trailing "City Pincode" line when present). */
function addressLinesXml(a: TallyAddress): string {
    const lines = [...(a.lines || []).filter(Boolean)];
    const cityLine = [a.city, a.pincode].filter(Boolean).join(' ').trim();
    if (cityLine) lines.push(cityLine);
    if (!lines.length) return '';
    return '<ADDRESS.LIST TYPE="String">' + lines.map(l => `<ADDRESS>${esc(l)}</ADDRESS>`).join('') + '</ADDRESS.LIST>';
}

/** Mailing address for a ledger. TallyPrime stores this in <LEDMAILINGDETAILS.LIST> — a flat
 *  <ADDRESS.LIST> on the LEDGER is accepted by the import but SILENTLY DISCARDED (verified live),
 *  which is why ledgers were landing in Tally with no address at all. */
function ledgerMailingXml(a: TallyAddress, ledgerName: string, applicableFrom: string): string {
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

export interface MasterKey { name: string; guid: string; sapId: string; parent?: string; alterId: number; unit?: string; state?: string; gstin?: string; }
export interface MasterWriteResult { ok: boolean; created: number; altered: number; errors: number; message: string; guid?: string; renamedFrom?: string; }

export interface ReadKeyOpts {
    names?: string[];        // include ledgers whose name is in this list
    guids?: string[];        // include ledgers whose GUID is in this list
    sapTaggedOnly?: boolean;  // include ledgers that carry a Morde SAP Id
    group?: string;          // restrict to a parent group
    sinceAlterId?: number;   // only ledgers changed after this AlterID (incremental)
}

/** Build the Tally FILTER formula for a scoped/incremental read. The scope clauses
 *  (names / guids / sapTagged) are OR-ed (a union); group and sinceAlterId are AND-ed on top. */
function buildKeyFilter(o: ReadKeyOpts): string {
    const scope: string[] = [];
    if (o.names && o.names.length) scope.push('(' + o.names.map(n => `$Name = "${q(n)}"`).join(' OR ') + ')');
    if (o.guids && o.guids.length) scope.push('(' + o.guids.map(g => `$Guid = "${q(g)}"`).join(' OR ') + ')');
    if (o.sapTaggedOnly) scope.push('(NOT $$IsEmpty:$MordeSAPID)');
    const and: string[] = [];
    and.push(scope.length ? '(' + scope.join(' OR ') + ')' : 'Yes');
    if (o.group) and.push(`$Parent = "${q(o.group)}"`);
    if (typeof o.sinceAlterId === 'number' && o.sinceAlterId > 0) and.push(`$AlterId > ${Math.floor(o.sinceAlterId)}`);
    return and.join(' AND ');
}

/** Read Name + GUID + SAP Id + AlterID for ledgers, via a COMPUTE collection (the only reliable
 *  way to project a UDF). Pass scope via opts; with no scope clause it reads every ledger. */
export async function readLedgerKeys(server: string, port: number, opts: ReadKeyOpts = {}): Promise<MasterKey[]> {
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
export async function ledgerNameByGuid(server: string, port: number, guid: string): Promise<string> {
    if (!guid) return '';
    const keys = await readLedgerKeys(server, port, { guids: [guid] });
    return keys[0]?.name || '';
}

/** Parse a COMPUTE-collection export into MasterKey rows, for any master item tag. */
function parseMasterKeys(xml: string, tag: string): MasterKey[] {
    const out: MasterKey[] = [];
    const re = new RegExp(`<${tag}\\b[^>]*\\bNAME="([^"]*)"[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let m: RegExpExecArray | null;
    const pick = (blk: string, tag: string) => { const mm = blk.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i')); return mm ? mm[1].trim() : ''; };
    const unesc = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
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
export async function upsertLedgerWithSapId(
    server: string, port: number, name: string, parentGroup: string, sapId: string,
    opts: { knownGuid?: string; address?: TallyAddress; profile?: LedgerProfile; applicableFrom?: string; log?: (m: string, e?: boolean) => void } = {},
): Promise<MasterWriteResult> {
    const log = opts.log || (() => { });
    // GUID-first identity: if SF already has a GUID, find the ledger's current name by it.
    let currentName = '';
    if (opts.knownGuid) currentName = await ledgerNameByGuid(server, port, opts.knownGuid);

    let action: 'Create' | 'Alter';
    let identityName: string;   // the NAME attribute that identifies the ledger in the request
    let renameTo = '';
    if (currentName) {
        action = 'Alter'; identityName = currentName;
        if (currentName !== name) renameTo = name;              // SF renamed it -> rename, don't duplicate
    } else if (await ledgerExists(server, port, name)) {
        action = 'Alter'; identityName = name;
    } else {
        action = 'Create'; identityName = name;
    }

    const nameListXml = action === 'Create'
        ? `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>`
        : (renameTo ? `<NAME.LIST TYPE="String"><NAME>${esc(renameTo)}</NAME></NAME.LIST>` : '');
    const parentXml = action === 'Create' ? `<PARENT>${esc(parentGroup)}</PARENT>` : '';
    const sapXml = sapId ? `<MORDESAPID>${esc(sapId)}</MORDESAPID>` : '';
    // Mailing address (street/city/state/pincode + GSTIN/phone/email). Emitted on Alter as well as
    // Create so an address added or corrected in Salesforce reaches an already-synced ledger.
    const addrXml = hasAddr(opts.address)
        ? ledgerMailingXml(opts.address!, renameTo || name, opts.applicableFrom || '20000401') : '';
    // Commercial details (credit limit/period, PAN, GST reg type, contact, mobile, bank). Emitted on
    // Alter too, so values added in Salesforce later reach a ledger that already exists.
    const profileXml = hasProfile(opts.profile) ? ledgerProfileXml(opts.profile!, renameTo || name) : '';
    // GST registration details, assembled from the address (GSTIN + state) and the profile
    // (registration type) — they belong together in one dated LEDGSTREGDETAILS record.
    const gstXml = ledgerGstXml(
        opts.address?.gstin || '', opts.profile?.gstRegistrationType || '',
        opts.address?.state || '', opts.applicableFrom || '20000401');
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
    if (!ok) return { ok, created, altered, errors, message: lineErr || 'no change' };
    const finalName = renameTo || name;
    const keys = await readLedgerKeys(server, port, { names: [finalName] });
    return { ok, created, altered, errors, message: 'ok', guid: keys[0]?.guid || opts.knownGuid, renamedFrom: renameTo ? currentName : undefined };
}

/** Add/replace ONE named address in a ledger's "multiple addresses" list. This is where a CUSTOMER's
 *  ship-to / billing address belongs — a customer address is NOT a godown (a godown is one of the
 *  distributor's OWN stock locations). Turns the multi-address feature on for the ledger, then adds
 *  the entry keyed by ADDRESSNAME (re-sending the same name updates it). Verified against live
 *  TallyPrime. Returns true on success. */
export async function setLedgerMultiAddress(server: string, port: number, ledgerName: string,
    addr: TallyAddress, log?: (m: string, e?: boolean) => void): Promise<boolean> {
    const label = (addr.addressName || '').trim();
    if (!ledgerName || !label) return false;
    const body = `<ADDRESSNAME>${esc(label)}</ADDRESSNAME>`
        + addressLinesXml(addr)
        + (addr.state ? `<STATE>${esc(addr.state)}</STATE>` : '')
        + `<COUNTRY>${esc(addr.country || 'India')}</COUNTRY>`
        + (addr.pincode ? `<PINCODE>${esc(addr.pincode)}</PINCODE>` : '')
        + (addr.gstin ? `<PARTYGSTIN>${esc(addr.gstin)}</PARTYGSTIN>` : '')
        + (addr.phone ? `<PHONENUMBER>${esc(addr.phone)}</PHONENUMBER>` : '')
        + (addr.email ? `<EMAIL>${esc(addr.email)}</EMAIL>` : '');
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(ledgerName)}" ACTION="Alter">`
        + '<ISMULTIADDRESSAPPLICABLE>Yes</ISMULTIADDRESSAPPLICABLE>'
        + `<LEDMULTIADDRESSLIST.LIST>${body}</LEDMULTIADDRESSLIST.LIST>`
        + '</LEDGER>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = (num(resp, 'ALTERED') + num(resp, 'CREATED')) > 0 && !lineErr;
    log?.(`ledger '${ledgerName}' address '${label}': ${ok ? 'set' : 'FAILED — ' + (lineErr || 'no change')}`, !ok);
    return ok;
}

/** Ensure a STOCK GROUP (product category) exists, optionally nested under a parent group.
 *  Used to mirror the SF Category__c > SubCategory__c hierarchy into Tally. Idempotent: a
 *  duplicate create is reported by Tally and treated as success. */
export async function ensureStockGroup(server: string, port: number, name: string,
    parent?: string, log?: (m: string, e?: boolean) => void): Promise<boolean> {
    const n = (name || '').trim();
    if (!n) return false;
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<STOCKGROUP NAME="${esc(n)}" ACTION="Create"><NAME.LIST><NAME>${esc(n)}</NAME></NAME.LIST>`
        + ((parent || '').trim() ? `<PARENT>${esc(parent!.trim())}</PARENT>` : '')
        + '<ISADDABLE>Yes</ISADDABLE></STOCKGROUP>'
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const lineErr = (resp.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i) || [])[1] || '';
    const ok = num(resp, 'CREATED') > 0 || /duplicate|already exist/i.test(lineErr);
    if (!ok) log?.(`stock group '${n}': create failed — ${lineErr}`, true);
    return ok;
}

/** Write only the SAP Id onto an existing ledger (used when SF later assigns a SAP Id). */
export async function setLedgerSapId(server: string, port: number, name: string, sapId: string,
    log?: (m: string, e?: boolean) => void): Promise<boolean> {
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(name)}" ACTION="Alter"><MORDESAPID>${esc(sapId)}</MORDESAPID></LEDGER>`
        + '</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
    const resp = await postTallyXml(server, port, xml, 30000);
    const ok = (num(resp, 'ERRORS') + num(resp, 'EXCEPTIONS')) === 0 && num(resp, 'ALTERED') > 0;
    log?.(`set sap on '${name}' = '${sapId}': ${ok ? 'ok' : 'failed'}`, !ok);
    return ok;
}

// ============================================================================
//  Godown (warehouse/location) — SF <-> Tally, both ways. Identity is GUID + name
//  only (no SAP UDF). Mirrors the ledger master pattern.
// ============================================================================

/** Read Name + GUID + Parent + AlterID for godowns (COMPUTE collection). Pass sinceAlterId for an
 *  incremental read. Reuses parseMasterKeys (SAP/unit stay empty for godowns). */
export async function readGodownKeys(server: string, port: number, opts: ReadKeyOpts = {}): Promise<MasterKey[]> {
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
export async function godownNameByGuid(server: string, port: number, guid: string): Promise<string> {
    if (!guid) return '';
    const keys = await readGodownKeys(server, port, { guids: [guid] });
    return keys[0]?.name || '';
}

/** True if a godown with this exact name already exists. */
async function godownExists(server: string, port: number, name: string): Promise<boolean> {
    if (!name) return false;
    try { return (await readGodownKeys(server, port, { names: [name] })).some(k => k.name.toLowerCase() === name.toLowerCase()); }
    catch { return false; }
}

/** Create (if missing) or alter a godown. GUID-first identity like upsertLedgerWithSapId: when a
 *  knownGuid is supplied we address the EXISTING godown by its current name and rename it if the
 *  desired name changed, rather than creating a duplicate. Returns the godown's GUID on success. */
export async function upsertGodown(
    server: string, port: number, name: string, parent: string,
    opts: { knownGuid?: string; log?: (m: string, e?: boolean) => void } = {},
): Promise<MasterWriteResult> {
    const log = opts.log || (() => { });
    let currentName = '';
    if (opts.knownGuid) currentName = await godownNameByGuid(server, port, opts.knownGuid);

    let action: 'Create' | 'Alter';
    let identityName: string;
    let renameTo = '';
    if (currentName) {
        action = 'Alter'; identityName = currentName;
        if (currentName !== name) renameTo = name;
    } else if (await godownExists(server, port, name)) {
        action = 'Alter'; identityName = name;
    } else {
        action = 'Create'; identityName = name;
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
    if (!ok) return { ok, created, altered, errors, message: lineErr || 'no change' };
    const finalName = renameTo || name;
    const keys = await readGodownKeys(server, port, { names: [finalName] });
    return { ok, created, altered, errors, message: 'ok', guid: keys[0]?.guid || opts.knownGuid, renamedFrom: renameTo ? currentName : undefined };
}

/** True when the active company has MULTIPLE GODOWNS enabled. Confirmed live: the Company native
 *  method `$IsMultiGodownOn` returns a Logical "Yes"/"No" (the `$$PrimaryGodown`/`$$IsGodownOn`
 *  functions returned nothing on this build, so they are NOT used). Returns false on any doubt. */
async function isMultiGodownOn(server: string, port: number): Promise<boolean> {
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
    } catch { return false; }
}

/** Resolve the company's PRIMARY godown name to default inventory lines to — but ONLY when the
 *  company has multiple godowns enabled. Once multi-godown is on, Tally REJECTS an inventory line
 *  that carries no batch/godown allocation, so every line must name a godown. When multi-godown is
 *  OFF (single-location company), returns '' so callers emit no allocation (today's behaviour,
 *  byte-identical XML). Primary is resolved by name: 'Main Location' (Tally's standard default),
 *  then 'Primary', else the first godown. Resilient: any failure -> '' (safe, unchanged behaviour). */
export async function resolveDefaultGodown(server: string, port: number): Promise<string> {
    try {
        if (!(await isMultiGodownOn(server, port))) return '';
        const godowns = await readGodownKeys(server, port, {});
        const names = godowns.map(g => g.name).filter(Boolean);
        if (!names.length) return '';
        const byName = (want: string) => names.find(n => n.toLowerCase() === want.toLowerCase());
        return byName('Main Location') || byName('Primary') || names[0];
    } catch { return ''; }
}

// ============================================================================
//  Stock Item (Product) — SF -> Tally only. Same MordeSAPID UDF + GUID identity
//  as ledgers, but the master is a StockItem which additionally needs base units.
// ============================================================================

/** True if a simple unit with this symbol already exists in Tally. Tally can return a unit's
 *  NAME oddly (e.g. "pcs; pcs"), so each returned name is split on ; and , and trimmed. */
export async function unitExists(server: string, port: number, symbol: string): Promise<boolean> {
    const unit = (symbol || '').trim().toLowerCase();
    if (!unit) return false;
    try {
        const { rows } = parseCollection(await postTallyXml(server, port, buildFetchXmlFiltered('unit', 'NAME', 'Yes', {}), 20000), 'unit');
        for (const r of rows) {
            const parts = String(r.name || '').split(/[;,]/).map(s => s.trim().toLowerCase());
            if (parts.includes(unit)) return true;
        }
    } catch { /* treat as absent */ }
    return false;
}

/** Tally simple-unit symbols reject spaces and slashes (a descriptive UOM like "Carton Box" or a
 *  symbol like "C/B" fails as "BAD UNIT NAME"). Reduce any UOM to a Tally-valid alphanumeric symbol
 *  (letters/digits/%); used for BOTH the unit master and a stock item's base unit so they always
 *  match. Empty -> 'Nos'. "Carton Box" -> "CartonBox", "C/B" -> "CB", "KG" -> "KG". */
export function tallyUnitSymbol(s: string): string {
    return ((s || '').trim().replace(/[^A-Za-z0-9%]+/g, '')) || 'Nos';
}

/** Ensure a simple unit of measure exists in Tally (create if missing). The create uses a plain
 *  <NAME> (a NAME.LIST is rejected as "BAD UNIT NAME" for units). */
export async function ensureUnit(server: string, port: number, symbol: string, log?: (m: string, e?: boolean) => void): Promise<boolean> {
    const unit = tallyUnitSymbol(symbol);
    if (!unit) return false;
    if (await unitExists(server, port, unit)) return true;
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
    log?.(`unit '${unit}': ${num(resp, 'CREATED') > 0 ? 'created' : (ok ? 'already present' : 'create failed — ' + lineErr)}`, !ok);
    return ok;
}

/** Ensure a stock item exists (create a minimal one — name + base unit — if missing). This is the
 *  voucher-time safety net so an inventory line never references a non-existent item; the full
 *  product sync (with SAP Id + GST) is what creates items properly. Returns true if present/created. */
export async function ensureStockItem(server: string, port: number, name: string, baseUnit: string,
    log?: (m: string, e?: boolean) => void): Promise<boolean> {
    if (!name) return false;
    try { if ((await readStockItemKeys(server, port, { names: [name] })).length > 0) return true; } catch { /* treat as missing */ }
    log?.(`stock item '${name}' missing — creating (unit '${baseUnit || 'pcs'}')`);
    const r = await upsertStockItemWithSapId(server, port, name, baseUnit || 'pcs', '', { log });
    if (!r.ok) log?.(`failed to create stock item '${name}': ${r.message}`, true);
    return r.ok;
}

/** Read Name + GUID + SAP Id + AlterID for stock items (COMPUTE collection). */
export async function readStockItemKeys(server: string, port: number, opts: ReadKeyOpts = {}): Promise<MasterKey[]> {
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
export async function stockItemNameByGuid(server: string, port: number, guid: string): Promise<string> {
    if (!guid) return '';
    const keys = await readStockItemKeys(server, port, { guids: [guid] });
    return keys[0]?.name || '';
}

/** Build the GST details block for a stock item from a single total GST rate (e.g. 18).
 *  CGST and SGST each get half; IGST gets the full rate — matching how Tally stores it, so the
 *  distributor's own invoices and GST returns auto-calculate correctly. */
function gstDetailsXml(gstRate: number, hsn?: string): string {
    const half = (gstRate / 2);
    const rd = (head: string, rate: number) =>
        `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD>`
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
export async function upsertStockItemWithSapId(
    server: string, port: number, name: string, baseUnit: string, sapId: string,
    opts: { knownGuid?: string; stockGroup?: string; gstRate?: number; hsn?: string; log?: (m: string, e?: boolean) => void } = {},
): Promise<MasterWriteResult> {
    const log = opts.log || (() => { });
    // Sanitize once so the unit master (ensureUnit) and this item's <BASEUNITS> use the identical
    // Tally-valid symbol — a raw "Carton Box"/"C/B" would fail unit creation with BAD UNIT NAME.
    const unit = tallyUnitSymbol(baseUnit || 'Nos');
    await ensureUnit(server, port, unit, log);

    let currentName = '';
    if (opts.knownGuid) currentName = await stockItemNameByGuid(server, port, opts.knownGuid);

    let action: 'Create' | 'Alter';
    let identityName: string;
    let renameTo = '';
    if (currentName) {
        action = 'Alter'; identityName = currentName;
        if (currentName !== name) renameTo = name;
    } else if ((await readStockItemKeys(server, port, { names: [name] })).length > 0) {
        action = 'Alter'; identityName = name;
    } else {
        action = 'Create'; identityName = name;
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
    if (!ok) return { ok, created, altered, errors, message: lineErr || 'no change' };
    const finalName = renameTo || name;
    const keys = await readStockItemKeys(server, port, { names: [finalName] });
    return { ok, created, altered, errors, message: 'ok', guid: keys[0]?.guid || opts.knownGuid, renamedFrom: renameTo ? currentName : undefined };
}
