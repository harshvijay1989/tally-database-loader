import fs from 'node:fs';
import { runCycle, bakedSapCode } from './syncRunner.mjs';
// Headless entry point for one sync cycle. In production the OS scheduler (or the connector's
// own timer) calls this on the per-mapping frequency; Salesforce still decides what actually
// runs (Sync_Config__c). Dry-run by DEFAULT — pass --live to write to Tally/Salesforce.
//
//   node dist/runSync.mjs            # dry-run, honours per-mapping schedule
//   node dist/runSync.mjs --live     # actually upsert to SF / write to Tally
//   node dist/runSync.mjs --force    # ignore schedule (run every due-or-not config now)
function loadTally() {
    // Default to 127.0.0.1, not 'localhost': on Windows 'localhost' can resolve to IPv6 ::1
    // while Tally's gateway binds IPv4 only, giving spurious ECONNREFUSED even when Tally is up.
    try {
        const c = JSON.parse(fs.readFileSync('./config.json', 'utf8')).tally || {};
        const server = (!c.server || c.server === 'localhost') ? '127.0.0.1' : c.server;
        return { server, port: Number(c.port) || 9000 };
    }
    catch {
        return { server: '127.0.0.1', port: 9000 };
    }
}
// Optional flags:
//   --object <Type>       run only this object (Invoice|Purchase|Order|Note) — one schedule per object
//   --direction <Dir>     ToSalesforce | ToTally (default: both)
//   --live --force        as before
function argVal(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
}
async function main() {
    const argv = process.argv.slice(2);
    const args = new Set(argv);
    const dryRun = !args.has('--live');
    const force = args.has('--force');
    const objectType = argVal(argv, '--object');
    const direction = argVal(argv, '--direction');
    const { server, port } = loadTally();
    const log = (m, e) => console[e ? 'error' : 'log'](m);
    if (!bakedSapCode()) {
        console.error('No distributor SAP code in connections.json (distributor.sapCode). Aborting.');
        process.exit(2);
    }
    console.log(`Tally at ${server}:${port} — ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE'}${force ? ', forced' : ''}${objectType ? `, object=${objectType}` : ''}${direction ? `, direction=${direction}` : ''}`);
    const reports = await runCycle({ server, port, dryRun, force, objectType, direction, log });
    console.log('\n=== cycle summary ===');
    if (!reports.length)
        console.log('(nothing enabled/due)');
    for (const r of reports)
        console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.direction} ${r.objectType}: ${r.detail}`);
    process.exit(reports.some(r => !r.ok) ? 1 : 0);
}
main().catch(e => { console.error('cycle failed:', e?.message || e); process.exit(1); });
//# sourceMappingURL=runSync.mjs.map