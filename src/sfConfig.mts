import { sfQuery, sfUpdate } from './sfClient.mjs';

// Config is the CONTROL PLANE and lives in Salesforce. The connector calls SF at the start
// of every cycle to learn what it is allowed to do — which objects, which direction, on what
// schedule — and never acts on a direction unless SF says Enabled. No connector redeploy is
// needed to turn a distributor's read or write on/off: an admin flips Sync_Config__c in SF.
//
// Identity is the SAP Company Code (Distributor__c.SAP_Company_Code__c, tied to
// Account.SAP_Company_Code__c), baked into the per-distributor build.

export type Direction = 'ToSalesforce' | 'ToTally';

export interface SyncConfig {
    id: string;                 // Sync_Config__c Id (for watermark / Last_Run write-back)
    objectType: string;         // e.g. 'Invoice', 'Purchase'
    direction: Direction;       // this row's enabled direction
    frequencyMinutes: number;   // per-mapping schedule
    lastAlterId: number;        // incremental watermark (Tally->SF)
    lastRun?: string;           // ISO
    debug: boolean;
    retryEnabled: boolean;
    maxRetryCount: number;
    retryIntervalMinutes: number;
}

/** Is this config due to run now, given its frequency and last run? */
export function isDue(c: SyncConfig, now = Date.now()): boolean {
    if (!c.lastRun) return true;
    const last = Date.parse(c.lastRun);
    if (isNaN(last)) return true;
    return now - last >= Math.max(1, c.frequencyMinutes) * 60 * 1000;
}

/**
 * Load the enabled sync configs for THIS distributor (by SAP company code) and the given
 * direction. A row with Direction__c = 'Both' counts for either direction. Only Enabled rows
 * are returned — a disabled row means the connector must not act on it.
 */
export async function loadSyncConfigs(sapCode: string, direction: Direction): Promise<SyncConfig[]> {
    const soql =
        `SELECT Id, Object_Type__c, Direction__c, Enabled__c, Frequency_Minutes__c, Last_AlterId__c, ` +
        `Last_Run__c, Debug__c, Retry_Enabled__c, Max_Retry_Count__c, Retry_Interval_Minutes__c ` +
        `FROM Sync_Config__c ` +
        `WHERE Enabled__c = true ` +
        `AND Distributor__r.SAP_Company_Code__c = '${sapCode.replace(/'/g, "\\'")}' ` +
        `AND (Direction__c = '${direction}' OR Direction__c = 'Both') ` +
        `ORDER BY Object_Type__c`;
    const rows = await sfQuery(soql);
    return rows.map(r => ({
        id: r.Id,
        objectType: r.Object_Type__c,
        direction,
        frequencyMinutes: Number(r.Frequency_Minutes__c) || 15,
        lastAlterId: Number(r.Last_AlterId__c) || 0,
        lastRun: r.Last_Run__c || undefined,
        debug: !!r.Debug__c,
        retryEnabled: r.Retry_Enabled__c !== false,
        maxRetryCount: Number(r.Max_Retry_Count__c) || 5,
        retryIntervalMinutes: Number(r.Retry_Interval_Minutes__c) || 15,
    })).filter(c => c.objectType);
}

export interface DistributorRef { id: string; name: string; sapCode: string; }

/** Resolve the Distributor__c record for this SAP code (for stamping staging rows). */
export async function resolveDistributor(sapCode: string): Promise<DistributorRef | null> {
    const rows = await sfQuery(
        `SELECT Id, Name, SAP_Company_Code__c FROM Distributor__c ` +
        `WHERE SAP_Company_Code__c = '${sapCode.replace(/'/g, "\\'")}' LIMIT 1`);
    if (!rows.length) return null;
    return { id: rows[0].Id, name: rows[0].Name, sapCode: rows[0].SAP_Company_Code__c };
}

/** Advance the incremental watermark after a successful Tally->SF pass. */
export async function saveWatermark(configId: string, lastAlterId: number): Promise<void> {
    await sfUpdate('Sync_Config__c', configId, { Last_AlterId__c: lastAlterId, Last_Run__c: new Date().toISOString() });
}

/** Stamp Last_Run__c without moving the watermark (SF->Tally, or a no-op cycle). */
export async function stampRun(configId: string): Promise<void> {
    await sfUpdate('Sync_Config__c', configId, { Last_Run__c: new Date().toISOString() });
}
