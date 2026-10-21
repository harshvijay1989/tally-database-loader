import { runCycle, bakedSapId } from './syncRunner.mjs';
import { loadSyncConfigs, resolveAccount, nextDue, isDue } from './sfConfig.mjs';
const state = { enabled: true, running: false, startedAt: 0, lastTickAt: null, lastError: null, lastReports: [], lastRunAt: null };
let timer = null;
const TICK_MS = 60 * 1000;
/** One scheduler tick: run whatever is due (runCycle gates by isDue internally). */
async function tick(getTally, log) {
    if (state.running || !state.enabled)
        return;
    state.running = true;
    try {
        const { server, port } = getTally();
        const reports = await runCycle({ server, port, dryRun: false, force: false, log });
        state.lastTickAt = Date.now();
        if (reports.length) {
            state.lastReports = reports;
            state.lastRunAt = Date.now();
        }
        state.lastError = null;
    }
    catch (e) {
        state.lastError = String((e === null || e === void 0 ? void 0 : e.message) || e);
        log(`[scheduler] tick failed: ${state.lastError}`, true);
    }
    finally {
        state.running = false;
    }
}
/** Start the in-connector scheduler (idempotent). */
export function startScheduler(getTally, log) {
    if (timer)
        return;
    state.startedAt = Date.now();
    log(`[scheduler] started — ticking every ${TICK_MS / 1000}s`);
    // First tick shortly after boot, then every minute.
    setTimeout(() => tick(getTally, log), 5000);
    timer = setInterval(() => tick(getTally, log), TICK_MS);
}
export function setEnabled(on) { state.enabled = on; }
/** Trigger a run now (optionally a single object), regardless of schedule. */
export async function runNow(getTally, log, objectType) {
    const { server, port } = getTally();
    const reports = await runCycle({ server, port, dryRun: false, force: true, objectType, log });
    if (reports.length) {
        state.lastReports = reports;
        state.lastRunAt = Date.now();
    }
    return reports;
}
/** Status + per-config schedule (last run / next due) for the UI to display. */
export async function schedulerStatus() {
    const base = {
        enabled: state.enabled, running: state.running, startedAt: state.startedAt,
        lastTickAt: state.lastTickAt, lastRunAt: state.lastRunAt, lastError: state.lastError,
        lastReports: state.lastReports, tickSeconds: TICK_MS / 1000,
    };
    const sapId = bakedSapId();
    if (!sapId)
        return { ...base, configs: [], note: 'No distributor SAP Id configured.' };
    try {
        const acct = await resolveAccount(sapId);
        if (!acct)
            return { ...base, configs: [], note: `No Account for SAP Id ${sapId}.` };
        const now = Date.now();
        const both = [...await loadSyncConfigs(sapId, 'ToSalesforce'), ...await loadSyncConfigs(sapId, 'ToTally')];
        const seen = new Set();
        const configs = both.filter(c => { const k = c.id + c.direction; if (seen.has(k))
            return false; seen.add(k); return true; })
            .map((c) => ({
            objectType: c.objectType, direction: c.direction,
            schedule: c.scheduleType === 'Daily' ? `Daily at ${c.dailyTime || '(unset)'}` : `Every ${c.frequencyMinutes} min`,
            lastRun: c.lastRun || null, nextDue: new Date(nextDue(c, now)).toISOString(), due: isDue(c, now),
        }));
        return { ...base, distributor: acct.name, sapId, configs };
    }
    catch (e) {
        return { ...base, configs: [], note: `Could not load config: ${String((e === null || e === void 0 ? void 0 : e.message) || e)}` };
    }
}
//# sourceMappingURL=scheduler.mjs.map