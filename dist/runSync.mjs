import fs from 'node:fs';
import { runCycle, bakedSapCode } from './syncRunner.mjs';
import { resolveAccount } from './sfConfig.mjs';
import { backfillAccountStates } from './sfMaster.mjs';
// Headless entry point for one sync cycle. In production the OS scheduler (or the connector's
// own timer) calls this on the per-mapping frequency; Salesforce still decides what actually
// runs (Sync_Config__c). Dry-run by DEFAULT — pass --live to write to Tally/Salesforce.
//
//   node dist/runSync.mjs            # dry-run, honours per-mapping schedule
//   node dist/runSync.mjs --live     # actually upsert to SF / write to Tally
//   node dist/runSync.mjs --force    # ignore schedule (run every due-or-not config now)
//
//   node dist/runSync.mjs --backfill-account-states            # one-time: dry-run (default)
//   node dist/runSync.mjs --backfill-account-states --live     # one-time: actually write the states
//     Fills GST state on legacy stateless Tally_Account__c rows that the AlterID-gated incremental
//     pull will never re-read. Runs ONLY the backfill (no normal cycle), then exits.
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
    const sapCode = bakedSapCode();
    if (!sapCode) {
        console.error('No distributor SAP code in connections.json (distributor.sapCode). Aborting.');
        process.exit(2);
    }
    console.log(`Tally at ${server}:${port} — ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE'}${force ? ', forced' : ''}${objectType ? `, object=${objectType}` : ''}${direction ? `, direction=${direction}` : ''}`);
    // One-time maintenance: backfill GST state on legacy stateless Tally_Account__c rows. Resolves
    // the distributor the same way runCycle does (by baked SAP code), runs the backfill, and exits
    // WITHOUT running a normal cycle. Dry-run by default; --live performs the writes.
    if (args.has('--backfill-account-states')) {
        const acct = await resolveAccount(sapCode);
        if (!acct) {
            console.error(`No Account in Salesforce with SAP_Company_Code__c = ${sapCode} — cannot backfill`);
            process.exit(2);
        }
        const r = await backfillAccountStates(acct, server, port, { dryRun, log });
        console.log(`\n=== account-state backfill ===\nscanned=${r.scanned} filled=${r.filled} unresolvable=${r.unresolvable} failed=${r.failed}`);
        if (r.errors.length)
            r.errors.slice(0, 10).forEach(e => console.error('  ' + e));
        process.exit(r.failed ? 1 : 0);
    }
    const reports = await runCycle({ server, port, dryRun, force, objectType, direction, log });
    console.log('\n=== cycle summary ===');
    if (!reports.length)
        console.log('(nothing enabled/due)');
    for (const r of reports)
        console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.direction} ${r.objectType}: ${r.detail}`);
    process.exit(reports.some(r => !r.ok) ? 1 : 0);
}
main().catch(e => { console.error('cycle failed:', (e === null || e === void 0 ? void 0 : e.message) || e); process.exit(1); });
//# sourceMappingURL=runSync.mjs.map