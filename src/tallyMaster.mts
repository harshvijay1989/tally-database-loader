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
    opts: { knownGuid?: string; log?: (m: string, e?: boolean) => void } = {},
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
    const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>'
        + '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>'
        + '<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">'
        + `<LEDGER NAME="${esc(identityName)}" ACTION="${action}">${nameListXml}${parentXml}${sapXml}</LEDGER>`
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

/** Ensure a simple unit of measure exists in Tally (create if missing). The create uses a plain
 *  <NAME> (a NAME.LIST is rejected as "BAD UNIT NAME" for units). */
export async function ensureUnit(server: string, port: number, symbol: string, log?: (m: string, e?: boolean) => void): Promise<boolean> {
    const unit = (symbol || '').trim();
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
    const unit = (baseUnit || 'Nos').trim();
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
    const parentXml = action === 'Create' && opts.stockGroup ? `<PARENT>${esc(opts.stockGroup)}</PARENT>` : '';
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
