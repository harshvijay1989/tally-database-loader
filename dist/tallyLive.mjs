import http from 'node:http';
import net from 'node:net';
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function decodeEntities(s) {
    return s
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
/** Build a Collection Export request that fetches ALL fields for a Tally object type. */
export function buildFetchXml(tallyType, fetchList, opts = {}) {
    // Distinct collection name per object type — reusing one name across different
    // TYPEs can wedge Tally's TDL engine on repeated/rapid requests.
    const collName = 'Live' + tallyType.replace(/[^a-zA-Z0-9]/g, '');
    let vars = '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>';
    if (opts.company)
        vars += `<SVCURRENTCOMPANY>${escapeHtml(opts.company)}</SVCURRENTCOMPANY>`;
    if (opts.fromDate)
        vars += `<SVFROMDATE>${opts.fromDate}</SVFROMDATE>`;
    if (opts.toDate)
        vars += `<SVTODATE>${opts.toDate}</SVTODATE>`;
    return '<ENVELOPE>'
        + `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${collName}</ID></HEADER>`
        + '<BODY><DESC>'
        + `<STATICVARIABLES>${vars}</STATICVARIABLES>`
        + '<TDL><TDLMESSAGE>'
        + `<COLLECTION NAME="${collName}" ISINITIALIZE="Yes"><TYPE>${escapeHtml(tallyType)}</TYPE><FETCH>${fetchList}</FETCH></COLLECTION>`
        + '</TDLMESSAGE></TDL>'
        + '</DESC></BODY></ENVELOPE>';
}
// Reuse ONE keep-alive connection for all Tally requests. Opening a fresh socket
// per request makes Tally's single-threaded gateway drop connections (ECONNRESET);
// a persistent connection is both stable and much faster.
const tallyAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
/** Build a filter expression by ledger/master Name (batched pagination). */
export function nameFilter(names) {
    return names.map(n => `$Name = "${escapeHtml(n).replace(/"/g, '&quot;')}"`).join(' OR ');
}
/** buildFetchXml variant with an inline FILTER formula (for record pagination). */
export function buildFetchXmlFiltered(tallyType, fetchList, filterFormula, opts = {}) {
    const base = buildFetchXml(tallyType, fetchList, opts);
    if (!filterFormula)
        return base;
    const collName = 'Live' + tallyType.replace(/[^a-zA-Z0-9]/g, '');
    return base
        .replace(`<FETCH>${fetchList}</FETCH></COLLECTION>`, `<FETCH>${fetchList}</FETCH><FILTER>pgflt</FILTER></COLLECTION><SYSTEM TYPE="Formula" NAME="pgflt">${filterFormula}</SYSTEM>`);
}
/** POST an XML payload to Tally using the UTF-16LE transport (same as tally.mts). */
export function postTallyXml(server, port, msg, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        try {
            const req = http.request({
                hostname: server, port, path: '', method: 'POST', agent: tallyAgent,
                headers: {
                    'Content-Length': Buffer.byteLength(msg, 'utf16le'),
                    'Content-Type': 'text/xml;charset=utf-16',
                    'Connection': 'keep-alive'
                }
            }, (res) => {
                let data = '';
                res.setEncoding('utf16le')
                    .on('data', (chunk) => { data += chunk.toString(); })
                    .on('end', () => resolve(data))
                    .on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(timeoutMs, () => { req.destroy(new Error('Tally request timed out')); });
            req.write(msg, 'utf16le');
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}
/**
 * Flatten a Tally collection XML into rows. Every nested element becomes a
 * dot-notation field (e.g. billallocations.list.name); repeated values under the
 * same path are joined with "; " — the same "fetch everything" flattening the
 * reference connector uses. itemTag is the object tag Tally emits (LEDGER, etc.).
 */
export function parseCollection(xml, itemTag) {
    const rows = [];
    const fieldOrder = [];
    const seen = new Set();
    const TAG = itemTag.toUpperCase();
    const blockRe = new RegExp(`<${TAG}(\\s[^>]*)?>([\\s\\S]*?)</${TAG}>`, 'g');
    // one token = an open/close/self-closing tag, or a run of text
    const tok = /<(\/?)([A-Za-z0-9_.]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
    let bm;
    while ((bm = blockRe.exec(xml))) {
        const attrs = bm[1] || '';
        const body = bm[2] || '';
        const cur = {};
        const add = (key, val) => {
            if (!(key in cur))
                cur[key] = val;
            else if (val)
                cur[key] = cur[key] ? cur[key] + '; ' + val : val;
            if (!seen.has(key)) {
                seen.add(key);
                fieldOrder.push(key);
            }
        };
        const nm = /NAME="([^"]*)"/.exec(attrs);
        if (nm)
            add('name', decodeEntities(nm[1]).trim());
        const stack = [];
        const kids = []; // child-tag count per open frame
        const txt = []; // whether a frame saw non-empty text
        let t;
        tok.lastIndex = 0;
        while ((t = tok.exec(body))) {
            const close = t[1], name = t[2], self = t[3], text = t[4];
            if (name) {
                if (close) {
                    const nm2 = stack.pop();
                    const k = kids.pop();
                    const had = txt.pop();
                    if (nm2 !== undefined && !k && !had)
                        add([...stack, nm2].join('.'), ''); // empty leaf
                }
                else if (self) {
                    if (kids.length)
                        kids[kids.length - 1]++;
                    add([...stack, name.toLowerCase()].join('.'), '');
                }
                else {
                    if (kids.length)
                        kids[kids.length - 1]++;
                    stack.push(name.toLowerCase());
                    kids.push(0);
                    txt.push(false);
                }
            }
            else if (text) {
                const v = decodeEntities(text).trim();
                if (v && stack.length) {
                    add(stack.join('.'), v);
                    txt[txt.length - 1] = true;
                }
            }
        }
        rows.push(cur);
    }
    return { rows, fields: fieldOrder };
}
// Tally's XML gateway is single-threaded — overlapping requests (concurrent probes,
// or a retry landing on a still-busy server) can crash it. Funnel EVERY request
// through one global queue so only one is ever in flight.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let tallyChain = Promise.resolve();
// Serialize so only one request is in flight. With the keep-alive connection above
// this no longer needs a cooldown between requests (that was to let a fresh socket
// tear down); batched pagination therefore runs fast.
function serialize(fn) {
    const run = tallyChain.then(fn, fn);
    tallyChain = run.then(() => undefined, () => undefined);
    return run;
}
async function fetchXmlWithRetry(server, port, xml, timeoutMs, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await serialize(() => postTallyXml(server, port, xml, timeoutMs));
        }
        catch (e) {
            lastErr = e;
            await sleep(400);
        } // transient reset — the retry is serialized, so it won't overlap
    }
    throw lastErr;
}
/** Fetch every field of a Tally object type and return flattened rows + field list. */
export async function fetchObject(server, port, tallyType, opts = {}) {
    const xml = await fetchXmlWithRetry(server, port, buildFetchXml(tallyType, '*', opts), 30000);
    return parseCollection(xml, tallyType);
}
/** List record identifiers (Name) for a master object — light FETCH NAME. */
export async function listNames(server, port, tallyType, opts = {}) {
    const xml = await fetchXmlWithRetry(server, port, buildFetchXml(tallyType, 'NAME', opts), 20000, 2);
    const { rows } = parseCollection(xml, tallyType);
    return rows.map(r => r.name).filter((n) => n != null && n !== '');
}
/**
 * Fetch an object in small Name-filtered batches over the keep-alive connection,
 * so Tally never serializes the whole collection at once (the FETCH * crash).
 * Returns the union of fields + all rows. Objects with no Name (e.g. vouchers)
 * fall back to a single fetch bounded by fetchList (+ any date window in opts).
 */
export async function fetchBatched(server, port, tallyType, fetchList, opts = {}) {
    const log = opts.log || (() => { });
    const batchSize = Math.max(1, opts.batchSize || 25);
    let names = [];
    try {
        names = await listNames(server, port, tallyType, opts);
    }
    catch (e) {
        log(`${tallyType}: could not list record names — ${e?.message || e}`, true);
    }
    if (!names.length) {
        log(`${tallyType}: no Name identifiers; single fetch of [${fetchList}]`);
        try {
            const { rows, fields } = parseCollection(await fetchXmlWithRetry(server, port, buildFetchXml(tallyType, fetchList, opts), 60000, 1), tallyType);
            log(`${tallyType}: fetched ${rows.length} rows, ${fields.length} fields`);
            return { rows, fields };
        }
        catch (e) {
            log(`${tallyType}: single fetch FAILED - ${e?.message || e}`, true);
            return { rows: [], fields: [] };
        }
    }
    const cap = (opts.sampleCap && opts.sampleCap > 0) ? Math.min(opts.sampleCap, names.length) : names.length;
    const target = names.slice(0, cap);
    log(`${tallyType}: ${names.length} records${cap < names.length ? ` (sampling ${cap})` : ''}; batches of ${batchSize}`);
    const allRows = [];
    const fieldOrder = [];
    const seen = new Set();
    let batchNo = 0, failed = 0;
    for (let i = 0; i < target.length; i += batchSize) {
        batchNo++;
        const batch = target.slice(i, i + batchSize);
        try {
            const xml = await fetchXmlWithRetry(server, port, buildFetchXmlFiltered(tallyType, fetchList, nameFilter(batch), opts), 30000, 2);
            const { rows, fields } = parseCollection(xml, tallyType);
            for (const f of fields)
                if (!seen.has(f)) {
                    seen.add(f);
                    fieldOrder.push(f);
                }
            // each filtered request can carry one blank/default item — keep only real (named) records
            allRows.push(...rows.filter(r => r.name != null && r.name !== ''));
        }
        catch (e) {
            failed += batch.length;
            log(`${tallyType}: batch ${batchNo} (records ${i + 1}-${i + batch.length}) FAILED - ${e?.message || e}`, true);
        }
    }
    log(`${tallyType}: done - ${allRows.length} rows, ${fieldOrder.length} fields${failed ? `, ${failed} records FAILED` : ''}`);
    return { rows: allRows, fields: fieldOrder };
}
/** Cheap presence/count probe for object discovery (fetches only NAME). */
export async function probePresence(server, port, tallyType, opts = {}, timeoutMs = 8000) {
    try {
        // single attempt (best-effort discovery); retrying every object doubles refresh time
        const xml = await fetchXmlWithRetry(server, port, buildFetchXml(tallyType, 'NAME', opts), timeoutMs, 1);
        const { rows } = parseCollection(xml, tallyType);
        return { present: rows.length > 0, count: rows.length };
    }
    catch {
        return { present: false, count: 0 };
    }
}
/** Quick TCP check that Tally's HTTP gateway is listening. */
export function reachable(server, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ host: server, port });
        let done = false;
        const finish = (ok) => { if (done)
            return; done = true; sock.destroy(); resolve(ok); };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
    });
}
//# sourceMappingURL=tallyLive.mjs.map