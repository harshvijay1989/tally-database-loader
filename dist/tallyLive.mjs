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
/** Turn any thrown value into a specific, loggable string. Node network failures are
 *  often an AggregateError (several socket attempts) whose .message is empty — the
 *  useful detail is in .code / .errors[].code — so surface those. */
export function describeError(e) {
    if (e == null)
        return 'unknown error';
    if (Array.isArray(e.errors) && e.errors.length) {
        const codes = [...new Set(e.errors.map((x) => x?.code || x?.message || String(x)))];
        return `${e.message || 'AggregateError'} [${codes.join(', ')}]`;
    }
    const parts = [];
    if (e.code)
        parts.push(String(e.code));
    parts.push(e.message ? String(e.message) : String(e));
    if (e.cause && (e.cause.code || e.cause.message))
        parts.push(`cause: ${e.cause.code || e.cause.message}`);
    return parts.join(' — ');
}
/** A plain-language, actionable hint for a Tally connection failure (or '' if none fits). */
export function tallyErrorHint(e) {
    const s = describeError(e).toLowerCase();
    if (s.includes('econnrefused'))
        return 'Tally is not running, or its HTTP server is OFF. In Tally Prime: F1 → Settings → Connectivity → Client/Server configuration → set "Tally.ERP 9 is acting as" to Both, port 9000.';
    if (s.includes('timed out') || s.includes('timeout') || s.includes('socket hang up') || s.includes('econnreset'))
        return 'Tally accepted the connection but did not respond in time — it is busy or wedged (often after a very heavy request). Wait a moment; if it stays stuck, restart Tally Prime and reopen the company.';
    if (s.includes('enotfound') || s.includes('ehostunreach') || s.includes('etimedout'))
        return 'Cannot reach the Tally machine — check the server address and port in Tally settings.';
    return '';
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
/** Export path: ONE collection request for only the given (bounded) fields across
 *  all records — the approach the original loader uses on large companies. Never
 *  FETCH *; the field set is limited to the mapped columns. */
export async function fetchCollectionFields(server, port, tallyType, fetchList, opts = {}) {
    const log = opts.log || (() => { });
    log(`${tallyType}: fetching [${fetchList}] for all records`);
    try {
        const { rows, fields } = parseCollection(await fetchXmlWithRetry(server, port, buildFetchXml(tallyType, fetchList || 'NAME', opts), 120000, 2), tallyType);
        const clean = rows.filter(r => Object.keys(r).length);
        log(`${tallyType}: fetched ${clean.length} rows, ${fields.length} fields`);
        return { rows: clean, fields };
    }
    catch (e) {
        log(`${tallyType}: fetch failed - ${e?.message || e}`, true);
        return { rows: [], fields: [] };
    }
}
/** Build an AlterID range filter. Operators MUST be XML-escaped (&gt;/&lt;) — a bare
 *  '<' breaks the <SYSTEM> formula element and silently returns nothing (or wedges Tally). */
export function alterIdRangeFilter(lo, hi) {
    return `$AlterID &gt; ${lo} AND $AlterID &lt;= ${hi}`;
}
/**
 * Fetch EVERY field of EVERY record of an object type without ever crashing Tally.
 *
 * A bare FETCH * over a whole collection makes Tally rebuild every record's nested
 * trees in one request and wedges on large companies. Instead we:
 *   1. do one cheap bounded pass (NAME + ALTERID) to get the record count + AlterID of
 *      every record — AlterID is present on every Tally object (master and voucher);
 *   2. slice the sorted AlterIDs into windows of ~windowSize records and FETCH * each
 *      window bounded by `$AlterID > lo AND $AlterID <= hi` — a small, safe request;
 *   3. concatenate the windows (disjoint by AlterID, so no record appears twice) and
 *      union their field names — discovery is a byproduct, so the field set is complete
 *      by construction (all scalars + all nested `.list.` fields, the full FETCH * set);
 *   4. self-check: compare rows returned against the count from step 1.
 *
 * If a window request fails (timeout/transient), it is split in half and retried, so a
 * pathologically heavy slice degrades to smaller requests rather than crashing.
 */
export async function fetchAllWindowed(server, port, tallyType, opts = {}) {
    const log = opts.log || (() => { });
    const t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
    const windowSize = Math.max(1, opts.windowSize || 500);
    // Nested sub-collection paths (e.g. "voucher.allledgerentries", "stockitem.gstdetails.
    // statewisedetails.ratedetails") are NOT standalone Tally collection types — sending
    // one as a <TYPE> wedges the gateway. Their data already comes back as `.list.` columns
    // on the PARENT object's windowed FETCH *, so never query them directly.
    if (tallyType.includes('.')) {
        log(`${tallyType}: nested sub-collection path — not a standalone collection; its fields come from the parent object, skipping`, true);
        return { rows: [], fields: [], expected: 0, got: 0, complete: false, windows: 0 };
    }
    // 1) cheap bounded pass: one row per record with its Name + AlterID (no FETCH *, safe)
    const idPass = parseCollection(await fetchXmlWithRetry(server, port, buildFetchXml(tallyType, 'NAME,ALTERID', opts), 60000, 2), tallyType);
    const idRows = idPass.rows.filter(r => Object.keys(r).length);
    const expected = idRows.length;
    if (!expected) {
        log(`${tallyType}: no records`);
        return { rows: [], fields: [], expected: 0, got: 0, complete: true, windows: 0 };
    }
    const ids = idRows.map(r => parseInt(r.alterid || '0', 10)).filter(n => n > 0).sort((a, b) => a - b);
    // shared accumulators (union field names in first-seen order; concatenate rows)
    const fieldOrder = [];
    const seen = new Set();
    const allRows = [];
    const absorb = (rows, fields) => {
        for (const f of fields)
            if (!seen.has(f)) {
                seen.add(f);
                fieldOrder.push(f);
            }
        allRows.push(...rows);
    };
    let windows = 0, earlyStop = false;
    if (!ids.length) {
        // Some config masters (e.g. cost centres) carry no AlterID. Fall back to
        // NAME-filtered batches using the names we already listed — still bounded,
        // still safe (never a bare FETCH * over the whole collection).
        const names = idRows.map(r => r.name).filter((n) => n != null && n !== '');
        if (!names.length) {
            log(`${tallyType}: ${expected} records but no AlterID or Name to page by — cannot fetch safely; skipping`, true);
            return { rows: [], fields: [], expected, got: 0, complete: false, windows: 0 };
        }
        const batchTotal = Math.ceil(names.length / windowSize);
        log(`${tallyType}: ${expected} records, no AlterID — processing in ${batchTotal} name-batches of ~${windowSize}`);
        let stable = 0, prevFields = 0;
        for (let i = 0; i < names.length; i += windowSize) {
            const chunk = names.slice(i, i + windowSize);
            try {
                const xml = buildFetchXmlFiltered(tallyType, '*', nameFilter(chunk), opts);
                const { rows, fields } = parseCollection(await fetchXmlWithRetry(server, port, xml, 90000, 2), tallyType);
                absorb(rows.filter(r => r.name != null && r.name !== ''), fields); // drop the blank default item
                windows++;
                if (fieldOrder.length === prevFields)
                    stable++;
                else {
                    stable = 0;
                    prevFields = fieldOrder.length;
                }
                log(`${tallyType}: batch ${windows}/${batchTotal} done — ${allRows.length}/${expected} records, ${fieldOrder.length} fields so far`);
                if (opts.stopWhenStableFor && stable >= opts.stopWhenStableFor) {
                    earlyStop = true;
                    log(`${tallyType}: field set stable — stopping after ${allRows.length} sampled records, ${fieldOrder.length} fields`);
                    break;
                }
            }
            catch (e) {
                log(`${tallyType}: name-batch ${i + 1}-${i + chunk.length} FAILED - ${describeError(e)}`, true);
            }
        }
    }
    else {
        // AlterID windows (primary path). Boundaries chosen so each window holds ~windowSize
        // records regardless of how AlterIDs cluster — (lo, hi] slices, lo just below min.
        const bounds = [];
        let prev = ids[0] - 1;
        for (let i = windowSize - 1; i < ids.length; i += windowSize) {
            const hi = ids[Math.min(i, ids.length - 1)];
            if (hi > prev) {
                bounds.push({ lo: prev, hi });
                prev = hi;
            }
        }
        if (prev < ids[ids.length - 1])
            bounds.push({ lo: prev, hi: ids[ids.length - 1] });
        log(`${tallyType}: ${expected} records, AlterID ${ids[0]}..${ids[ids.length - 1]}; ${bounds.length} windows of ~${windowSize}`);
        const fetchWindow = async (lo, hi, depth = 0) => {
            try {
                const xml = buildFetchXmlFiltered(tallyType, '*', alterIdRangeFilter(lo, hi), opts);
                const { rows, fields } = parseCollection(await fetchXmlWithRetry(server, port, xml, 90000, 2), tallyType);
                absorb(rows.filter(r => Object.keys(r).length), fields);
            }
            catch (e) {
                if (hi - lo > 1 && depth < 6) { // split the window and retry the halves
                    const mid = Math.floor((lo + hi) / 2);
                    log(`${tallyType}: window (${lo},${hi}] failed (${describeError(e)}); splitting`, true);
                    await fetchWindow(lo, mid, depth + 1);
                    await fetchWindow(mid, hi, depth + 1);
                }
                else {
                    log(`${tallyType}: window (${lo},${hi}] FAILED - ${describeError(e)}`, true);
                    const hint = tallyErrorHint(e);
                    if (hint)
                        log(`${tallyType}: hint — ${hint}`, true);
                }
            }
        };
        let done = 0, stable = 0, prevFields = 0;
        for (const b of bounds) {
            await fetchWindow(b.lo, b.hi);
            done++;
            if (fieldOrder.length === prevFields)
                stable++;
            else {
                stable = 0;
                prevFields = fieldOrder.length;
            }
            log(`${tallyType}: processed ${done}/${bounds.length} windows — ${allRows.length}/${expected} records, ${fieldOrder.length} fields so far`);
            // discovery only: once the field set stops growing, we've seen every field — stop
            if (opts.stopWhenStableFor && stable >= opts.stopWhenStableFor) {
                earlyStop = true;
                log(`${tallyType}: field set stable (no new fields for ${stable} windows) — stopping after ${allRows.length} sampled records, ${fieldOrder.length} fields`);
                break;
            }
        }
        windows = done;
    }
    // completeness self-check. An intentional early stop (discovery sampling) is NOT
    // incomplete — it walked enough records to see every field.
    const got = allRows.length;
    const complete = earlyStop ? true : got >= expected;
    if (earlyStop)
        log(`${tallyType}: discovery sampled ${got} of ${expected} records, ${fieldOrder.length} fields in ${secs()}`);
    else
        log(`${tallyType}: fetched ${got}/${expected} records, ${fieldOrder.length} fields in ${secs()}${complete ? '' : ' — INCOMPLETE'}`, !complete);
    return { rows: allRows, fields: fieldOrder, expected, got, complete, windows };
}
/** Cheap presence/count probe for object discovery (fetches only NAME). */
export async function probePresence(server, port, tallyType, opts = {}, timeoutMs = 8000) {
    // Nested sub-collection paths (e.g. "voucher.allledgerentries") are NOT standalone
    // collection types — probing one as a <TYPE> wedges Tally's gateway. Never send them.
    if (!tallyType || tallyType.includes('.'))
        return { present: false, count: 0 };
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