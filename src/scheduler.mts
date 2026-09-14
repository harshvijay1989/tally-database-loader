import { runCycle, bakedSapCode } from './syncRunner.mjs';
import { loadSyncConfigs, resolveAccount, nextDue, isDue, type SyncConfig } from './sfConfig.mjs';
import type { CycleReport } from './syncRunner.mjs';

// Self-running scheduler that lives INSIDE the connector process. While the connector is
// running it ticks once a minute, asks Salesforce what's due (per-object schedule in
// Sync_Config__c — Interval or Daily-at-time), and runs those syncs by itself. No OS task,
// no manual trigger. runCycle already gates each config by isDue(), so a tick is just a call.

export type LogFn = (msg: string, isError?: boolean) => void;
export interface TallyLoc { server: string; port: number; }

interface SchedState {
    enabled: boolean;
    running: boolean;
    startedAt: number;
    lastTickAt: number | null;
    lastError: string | null;
    lastReports: CycleReport[];
    lastRunAt: number | null;
}
const state: SchedState = { enabled: true, running: false, startedAt: 0, lastTickAt: null, lastError: null, lastReports: [], lastRunAt: null };
let timer: NodeJS.Timeout | null = null;
const TICK_MS = 60 * 1000;

/** One scheduler tick: run whatever is due (runCycle gates by isDue internally). */
async function tick(getTally: () => TallyLoc, log: LogFn): Promise<void> {
    if (state.running || !state.enabled) return;
    state.running = true;
    try {
        const { server, port } = getTally();
        const reports = await runCycle({ server, port, dryRun: false, force: false, log });
        state.lastTickAt = Date.now();
        if (reports.length) { state.lastReports = reports; state.lastRunAt = Date.now(); }
        state.lastError = null;
    } catch (e: any) {
        state.lastError = String(e?.message || e);
        log(`[scheduler] tick failed: ${state.lastError}`, true);
    } finally {
        state.running = false;
    }
}

/** Start the in-connector scheduler (idempotent). */
export function startScheduler(getTally: () => TallyLoc, log: LogFn): void {
    if (timer) return;
    state.startedAt = Date.now();
    log(`[scheduler] started — ticking every ${TICK_MS / 1000}s`);
    // First tick shortly after boot, then every minute.
    setTimeout(() => tick(getTally, log), 5000);
    timer = setInterval(() => tick(getTally, log), TICK_MS);
}

export function setEnabled(on: boolean): void { state.enabled = on; }

/** Trigger a run now (optionally a single object), regardless of schedule. */
export async function runNow(getTally: () => TallyLoc, log: LogFn, objectType?: string): Promise<CycleReport[]> {
    const { server, port } = getTally();
    const reports = await runCycle({ server, port, dryRun: false, force: true, objectType, log });
    if (reports.length) { state.lastReports = reports; state.lastRunAt = Date.now(); }
    return reports;
}

/** Status + per-config schedule (last run / next due) for the UI to display. */
export async function schedulerStatus(): Promise<any> {
    const base = {
        enabled: state.enabled, running: state.running, startedAt: state.startedAt,
        lastTickAt: state.lastTickAt, lastRunAt: state.lastRunAt, lastError: state.lastError,
        lastReports: state.lastReports, tickSeconds: TICK_MS / 1000,
    };
    const sapCode = bakedSapCode();
    if (!sapCode) return { ...base, configs: [], note: 'No distributor SAP code configured.' };
    try {
        const acct = await resolveAccount(sapCode);
        if (!acct) return { ...base, configs: [], note: `No Account for SAP code ${sapCode}.` };
        const now = Date.now();
        const both = [...await loadSyncConfigs(sapCode, 'ToSalesforce'), ...await loadSyncConfigs(sapCode, 'ToTally')];
        const seen = new Set<string>();
        const configs = both.filter(c => { const k = c.id + c.direction; if (seen.has(k)) return false; seen.add(k); return true; })
            .map((c: SyncConfig) => ({
                objectType: c.objectType, direction: c.direction,
                schedule: c.scheduleType === 'Daily' ? `Daily at ${c.dailyTime || '(unset)'}` : `Every ${c.frequencyMinutes} min`,
                lastRun: c.lastRun || null, nextDue: new Date(nextDue(c, now)).toISOString(), due: isDue(c, now),
            }));
        return { ...base, distributor: acct.name, sapCode, configs };
    } catch (e: any) {
        return { ...base, configs: [], note: `Could not load config: ${String(e?.message || e)}` };
    }
}
