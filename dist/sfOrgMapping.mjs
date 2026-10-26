import { sfQuery } from './sfClient.mjs';
const cache = new Map();
/** Load the org's active mappings for one source->target object pair (cached per process). */
export async function loadOrgMapping(sourceObject, targetObject) {
    const key = `${sourceObject}->${targetObject}`;
    const hit = cache.get(key);
    if (hit)
        return hit;
    let maps = [];
    try {
        const rows = await sfQuery(`SELECT Source_Field__c, Target_Field__c, Value_Type__c, Default_Value__c ` +
            `FROM Tally_Account_Field_Mapping__mdt ` +
            `WHERE Source_Object__c = '${sourceObject}' AND Target_Object__c = '${targetObject}' ` +
            `AND Active__c = true ORDER BY Sequence__c`);
        maps = rows
            .filter((r) => r.Target_Field__c)
            .map((r) => ({
            sourceField: r.Source_Field__c || undefined,
            targetField: r.Target_Field__c,
            valueType: String(r.Value_Type__c || 'FIELD').toUpperCase(),
            defaultValue: r.Default_Value__c || undefined,
        }));
    }
    catch {
        maps = [];
    } // metadata unreadable -> caller falls back to its minimal field set
    cache.set(key, maps);
    return maps;
}
/** The distinct source fields a mapping set reads — i.e. what to SELECT from the source object. */
export function orgMappingSourceFields(maps) {
    return [...new Set(maps.filter(m => m.valueType === 'FIELD' && m.sourceField).map(m => m.sourceField))];
}
/** Project a source record into the target record the org's trigger would have produced.
 *  FIELD rows copy source -> target (blank/absent values are skipped so we never null a field);
 *  STATIC rows write Default_Value as-is. `skip` drops targets the caller sets itself. */
export function buildMappedRecord(source, maps, skip = []) {
    const out = {};
    const skipSet = new Set(skip);
    for (const m of maps) {
        if (skipSet.has(m.targetField))
            continue;
        if (m.valueType === 'STATIC') {
            if (m.defaultValue != null && m.defaultValue !== '')
                out[m.targetField] = m.defaultValue;
            continue;
        }
        if (!m.sourceField)
            continue;
        const v = source[m.sourceField];
        if (v === undefined || v === null || v === '')
            continue;
        out[m.targetField] = v;
    }
    return out;
}
//# sourceMappingURL=sfOrgMapping.mjs.map