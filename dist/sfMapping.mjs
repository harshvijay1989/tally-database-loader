import fs from 'node:fs';
import { sfQuery } from './sfClient.mjs';
// --- Local overrides (edited in the connector, stored on this machine) ---------
const OVERRIDES_FILE = './mapping-overrides.json';
const okey = (objectType, direction) => `${objectType}|${direction}`;
export function loadOverrides() {
    try {
        return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) || {};
    }
    catch {
        return {};
    }
}
export function saveOverrides(store) {
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(store, null, 2));
}
/** Get the local override rows for one object+direction (empty if none). */
export function getOverride(objectType, direction) {
    return loadOverrides()[okey(objectType, direction)] || {};
}
/** Save local override rows for one object+direction. */
export function setOverride(objectType, direction, rows) {
    const store = loadOverrides();
    store[okey(objectType, direction)] = rows;
    saveOverrides(store);
}
/** Merge local overrides over a set of SF default maps (local wins, keyed by target). */
function mergeOverrides(objectType, direction, sfMaps) {
    const ov = getOverride(objectType, direction);
    if (!Object.keys(ov).length)
        return sfMaps;
    const byTarget = new Map(sfMaps.map(m => [m.target, { ...m }]));
    for (const [target, row] of Object.entries(ov)) {
        if (row.active === false) {
            byTarget.delete(target);
            continue;
        } // distributor disabled this row
        const base = byTarget.get(target) || { target };
        byTarget.set(target, {
            ...base,
            source: row.source ?? base.source,
            transform: row.transform ?? base.transform,
            constant: (row.constant != null && row.constant !== '') ? row.constant : base.constant,
        });
    }
    return [...byTarget.values()];
}
/**
 * Download the active mappings for one object + direction, in sort order. Scoped to this
 * distributor by SAP code: a per-distributor override (Account set to this code) plus the
 * shared defaults (Account blank). A per-distributor row wins over a default for the same
 * target field. Omit sapCode to load only the shared defaults.
 */
export async function loadMappings(objectType, direction, sapCode) {
    const scope = sapCode
        ? `AND (Account__c = null OR Account__r.SAP_Company_Code__c = '${sapCode.replace(/'/g, "\\'")}')`
        : `AND Account__c = null`;
    const rows = await sfQuery(`SELECT Source_Field__c, Target_Field__c, Constant_Value__c, Transform__c, Account__c FROM Field_Mapping__c ` +
        `WHERE Object_Type__c = '${objectType}' AND Direction__c = '${direction}' AND Active__c = true ${scope} ` +
        `ORDER BY Sort_Order__c NULLS LAST`);
    // A per-distributor row (Account set) overrides a default (Account blank) for the same target.
    // Keep the query's Sort_Order; just drop defaults whose target has an override, and any dupes.
    const overridden = new Set(rows.filter(r => r.Account__c).map(r => r.Target_Field__c));
    const seen = new Set();
    const sfMaps = rows.filter(r => {
        if (!r.Target_Field__c)
            return false;
        if (!r.Account__c && overridden.has(r.Target_Field__c))
            return false; // default shadowed by override
        if (seen.has(r.Target_Field__c))
            return false;
        seen.add(r.Target_Field__c);
        return true;
    }).map(r => ({
        source: r.Source_Field__c || undefined,
        target: r.Target_Field__c,
        constant: (r.Constant_Value__c != null && r.Constant_Value__c !== '') ? r.Constant_Value__c : undefined,
        transform: r.Transform__c || undefined,
    }));
    // Apply this machine's local edits over the Salesforce defaults.
    return mergeOverrides(objectType, direction, sfMaps);
}
/** Apply a single transform token to a value. Extend as new transforms are needed. */
export function applyTransform(v, t) {
    if (v == null)
        return v;
    switch ((t || '').toLowerCase()) {
        case '':
        case 'none': return v;
        case 'upper': return String(v).toUpperCase();
        case 'lower': return String(v).toLowerCase();
        case 'trim': return String(v).trim();
        case 'bool': {
            const s = String(v).trim().toLowerCase();
            return s === 'yes' || s === 'true' || s === '1';
        } // Tally 'Yes'/'No' -> checkbox
        case 'number': {
            const n = parseFloat(String(v).replace(/,/g, ''));
            return isNaN(n) ? null : n;
        }
        case 'abs': {
            const n = Math.abs(parseFloat(String(v).replace(/,/g, '')));
            return isNaN(n) ? null : n;
        }
        case 'tallydate': {
            const s = String(v).replace(/[^0-9]/g, '');
            return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
        } // YYYYMMDD -> YYYY-MM-DD (SF Date); empty/invalid -> null
        case 'sfdate': {
            const s = String(v).replace(/[^0-9]/g, '');
            return s.length === 8 ? s : null;
        } // YYYY-MM-DD -> YYYYMMDD (Tally); empty/invalid -> null
        default: return v;
    }
}
/** Build a target record from a source record using the mappings. */
export function applyMapping(source, maps) {
    const out = {};
    for (const m of maps) {
        let val = m.constant != null ? m.constant : (m.source ? source[m.source] : undefined);
        val = applyTransform(val, m.transform);
        if (val !== undefined)
            out[m.target] = val;
    }
    return out;
}
//# sourceMappingURL=sfMapping.mjs.map