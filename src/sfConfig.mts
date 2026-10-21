import { sfQuery, sfUpdate } from './sfClient.mjs';

// Config is the CONTROL PLANE and lives in Salesforce. The connector calls SF at the start
// of every cycle to learn what it is allowed to do — which objects, which direction, on what
// schedule — and never acts on a direction unless SF says Enabled. No connector redeploy is
// needed to turn a distributor's read or write on/off: an admin flips Sync_Config__c in SF.
//
// Identity is the SAP Id (Account.SAP_ID__c, unique per distributor), baked into the
// per-distributor build. (SAP_Company_Code__c is deprecated but still read/populated.)

export type Direction = 'ToSalesforce' | 'ToTally';
export type ScheduleType = 'Interval' | 'Daily';

export interface SyncConfig {
    id: string;                 // Sync_Config__c Id (for watermark / Last_Run write-back)
    objectType: string;         // e.g. 'Invoice', 'Purchase'
    direction: Direction;       // this row's enabled direction
    scheduleType: ScheduleType; // 'Interval' (every N min) or 'Daily' (once at a set time)
    frequencyMinutes: number;   // Interval: minutes between runs
    dailyTime: string;          // Daily: 'HH:MM' 24h in connector-local time (e.g. '19:00')
    lastAlterId: number;        // incremental watermark (Tally->SF)
    lastRun?: string;           // ISO
    debug: boolean;
    retryEnabled: boolean;
    maxRetryCount: number;
    retryIntervalMinutes: number;
}

/** When is this config next due (ms epoch), given its schedule and last run? */
export function nextDue(c: SyncConfig, now = Date.now()): number {
    const last = c.lastRun ? Date.parse(c.lastRun) : NaN;
    if (c.scheduleType === 'Daily') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(c.dailyTime || '');
        if (!m) return now; // misconfigured time -> treat as due now
        const d = new Date(now); d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
        let scheduled = d.getTime();
        if (scheduled > now) return scheduled;           // today's slot is still ahead
        // slot has passed today: due now if we haven't run since it, else tomorrow's slot
        if (isNaN(last) || last < scheduled) return now;
        return scheduled + 24 * 60 * 60 * 1000;
    }
    // Interval
    if (isNaN(last)) return now;
    return last + Math.max(1, c.frequencyMinutes) * 60 * 1000;
}

/** Is this config due to run now (by its schedule)? */
export function isDue(c: SyncConfig, now = Date.now()): boolean {
    return nextDue(c, now) <= now;
}

/**
 * Load the enabled sync configs for THIS distributor (by SAP company code) and the given
 * direction. A row with Direction__c = 'Both' counts for either direction. Only Enabled rows
 * are returned — a disabled row means the connector must not act on it.
 */
export async function loadSyncConfigs(sapId: string, direction: Direction): Promise<SyncConfig[]> {
    const soql =
        `SELECT Id, Object_Type__c, Direction__c, Enabled__c, Schedule_Type__c, Frequency_Minutes__c, ` +
        `Daily_Time__c, Last_AlterId__c, Last_Run__c, Debug__c, Retry_Enabled__c, Max_Retry_Count__c, ` +
        `Retry_Interval_Minutes__c ` +
        `FROM Sync_Config__c ` +
        `WHERE Enabled__c = true ` +
        `AND Account__r.SAP_ID__c = '${sapId.replace(/'/g, "\\'")}' ` +
        `AND (Direction__c = '${direction}' OR Direction__c = 'Both') ` +
        `ORDER BY Object_Type__c`;
    const rows = await sfQuery(soql);
    return rows.map(r => ({
        id: r.Id,
        objectType: r.Object_Type__c,
        direction,
        scheduleType: (r.Schedule_Type__c === 'Daily' ? 'Daily' : 'Interval') as ScheduleType,
        frequencyMinutes: Number(r.Frequency_Minutes__c) || 15,
        dailyTime: r.Daily_Time__c || '',
        lastAlterId: Number(r.Last_AlterId__c) || 0,
        lastRun: r.Last_Run__c || undefined,
        debug: !!r.Debug__c,
        retryEnabled: r.Retry_Enabled__c !== false,
        maxRetryCount: Number(r.Max_Retry_Count__c) || 5,
        retryIntervalMinutes: Number(r.Retry_Interval_Minutes__c) || 15,
    })).filter(c => c.objectType);
}

export interface AccountRef { id: string; name: string; sapId: string; companyCode: string; }

/** Resolve the distributor Account for this SAP Id. The Account IS the distributor identity;
 *  the connector matches its configured SAP Id against Account.SAP_ID__c (unique per distributor).
 *  SAP_Company_Code__c is still read (deprecated) so inbound rows keep that field populated too. */
export async function resolveAccount(sapId: string): Promise<AccountRef | null> {
    const rows = await sfQuery(
        `SELECT Id, Name, SAP_ID__c, SAP_Company_Code__c FROM Account ` +
        `WHERE SAP_ID__c = '${sapId.replace(/'/g, "\\'")}' LIMIT 1`);
    if (!rows.length) return null;
    return { id: rows[0].Id, name: rows[0].Name, sapId: rows[0].SAP_ID__c, companyCode: rows[0].SAP_Company_Code__c || '' };
}

/** Advance the incremental watermark after a successful Tally->SF pass. */
export async function saveWatermark(configId: string, lastAlterId: number): Promise<void> {
    await sfUpdate('Sync_Config__c', configId, { Last_AlterId__c: lastAlterId, Last_Run__c: new Date().toISOString() });
}

/** Stamp Last_Run__c without moving the watermark (SF->Tally, or a no-op cycle). */
export async function stampRun(configId: string): Promise<void> {
    await sfUpdate('Sync_Config__c', configId, { Last_Run__c: new Date().toISOString() });
}
