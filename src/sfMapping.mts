import { sfQuery } from './sfClient.mjs';

// Salesforce-authored field mapping: the connector downloads Field_Mapping__c rows and
// applies them (both directions). Mapping "stays in Salesforce"; the connector just applies.

export interface FieldMap { source?: string; target: string; constant?: string; transform?: string; }

/** Download the active mappings for one object + direction, in sort order. */
export async function loadMappings(objectType: string, direction: string): Promise<FieldMap[]> {
    const rows = await sfQuery(
        `SELECT Source_Field__c, Target_Field__c, Constant_Value__c, Transform__c FROM Field_Mapping__c ` +
        `WHERE Object_Type__c = '${objectType}' AND Direction__c = '${direction}' AND Active__c = true ` +
        `ORDER BY Sort_Order__c NULLS LAST`);
    return rows.map(r => ({
        source: r.Source_Field__c || undefined,
        target: r.Target_Field__c,
        constant: (r.Constant_Value__c != null && r.Constant_Value__c !== '') ? r.Constant_Value__c : undefined,
        transform: r.Transform__c || undefined,
    })).filter(m => m.target);
}

/** Apply a single transform token to a value. Extend as new transforms are needed. */
export function applyTransform(v: any, t?: string): any {
    if (v == null) return v;
    switch ((t || '').toLowerCase()) {
        case '': case 'none': return v;
        case 'upper': return String(v).toUpperCase();
        case 'lower': return String(v).toLowerCase();
        case 'trim': return String(v).trim();
        case 'number': { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }
        case 'abs': { const n = Math.abs(parseFloat(String(v).replace(/,/g, ''))); return isNaN(n) ? null : n; }
        case 'tallydate': { const s = String(v).replace(/[^0-9]/g, ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : v; } // YYYYMMDD -> YYYY-MM-DD (SF Date)
        case 'sfdate': { const s = String(v).replace(/[^0-9]/g, ''); return s.length === 8 ? s : v; } // YYYY-MM-DD -> YYYYMMDD (Tally)
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
