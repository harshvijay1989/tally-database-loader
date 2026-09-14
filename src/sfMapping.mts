import { sfQuery } from './sfClient.mjs';

// Salesforce-authored field mapping: the connector downloads Field_Mapping__c rows and
// applies them (both directions). Mapping "stays in Salesforce"; the connector just applies.

export interface FieldMap { source?: string; target: string; constant?: string; transform?: string; }

/**
 * Download the active mappings for one object + direction, in sort order. Scoped to this
 * distributor by SAP code: a per-distributor override (Account set to this code) plus the
 * shared defaults (Account blank). A per-distributor row wins over a default for the same
 * target field. Omit sapCode to load only the shared defaults.
 */
export async function loadMappings(objectType: string, direction: string, sapCode?: string): Promise<FieldMap[]> {
    const scope = sapCode
        ? `AND (Account__c = null OR Account__r.SAP_Company_Code__c = '${sapCode.replace(/'/g, "\\'")}')`
        : `AND Account__c = null`;
    const rows = await sfQuery(
        `SELECT Source_Field__c, Target_Field__c, Constant_Value__c, Transform__c, Account__c FROM Field_Mapping__c ` +
        `WHERE Object_Type__c = '${objectType}' AND Direction__c = '${direction}' AND Active__c = true ${scope} ` +
        `ORDER BY Sort_Order__c NULLS LAST`);
    // A per-distributor row (Account set) overrides a default (Account blank) for the same target.
    // Keep the query's Sort_Order; just drop defaults whose target has an override, and any dupes.
    const overridden = new Set(rows.filter(r => r.Account__c).map(r => r.Target_Field__c));
    const seen = new Set<string>();
    return rows.filter(r => {
        if (!r.Target_Field__c) return false;
        if (!r.Account__c && overridden.has(r.Target_Field__c)) return false; // default shadowed by override
        if (seen.has(r.Target_Field__c)) return false;
        seen.add(r.Target_Field__c); return true;
    }).map(r => ({
        source: r.Source_Field__c || undefined,
        target: r.Target_Field__c,
        constant: (r.Constant_Value__c != null && r.Constant_Value__c !== '') ? r.Constant_Value__c : undefined,
        transform: r.Transform__c || undefined,
    }));
}

/** Apply a single transform token to a value. Extend as new transforms are needed. */
export function applyTransform(v: any, t?: string): any {
    if (v == null) return v;
    switch ((t || '').toLowerCase()) {
        case '': case 'none': return v;
        case 'upper': return String(v).toUpperCase();
        case 'lower': return String(v).toLowerCase();
        case 'trim': return String(v).trim();
        case 'bool': { const s = String(v).trim().toLowerCase(); return s === 'yes' || s === 'true' || s === '1'; } // Tally 'Yes'/'No' -> checkbox
        case 'number': { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }
        case 'abs': { const n = Math.abs(parseFloat(String(v).replace(/,/g, ''))); return isNaN(n) ? null : n; }
        case 'tallydate': { const s = String(v).replace(/[^0-9]/g, ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; } // YYYYMMDD -> YYYY-MM-DD (SF Date); empty/invalid -> null
        case 'sfdate': { const s = String(v).replace(/[^0-9]/g, ''); return s.length === 8 ? s : null; } // YYYY-MM-DD -> YYYYMMDD (Tally); empty/invalid -> null
        default: return v;
    }
}

/** Build a target record from a source record using the mappings. */
export function applyMapping(source: Record<string, any>, maps: FieldMap[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const m of maps) {
        let val: any = m.constant != null ? m.constant : (m.source ? source[m.source] : undefined);
        val = applyTransform(val, m.transform);
        if (val !== undefined) out[m.target] = val;
    }
    return out;
}
