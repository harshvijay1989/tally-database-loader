# Project State — Tally ⇄ Salesforce Connector (handoff / anti-compaction snapshot)

_Last updated: 2026-10-23. This captures everything so context survives a compaction._

## What this is
A per-distributor Windows connector that two-way-syncs a distributor's **Tally** with **Morde's
Salesforce**. Forked from the open-source `tally-database-loader`; the connector is a NEW layer on
top. Orgs: **QA = `mordeqa`**, **Dev = `morde`** (both sandboxes). Commit as Harsh Vijay +
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Run `sf` CLI via PowerShell.

## How the connector runs (live path)
- Launcher runs **`dist/uiServer.mjs`** (web UI at localhost:3000 + scheduler). CLI entry = **`dist/runSync.mjs`** (flags: `--backfill-account-states [--live]`, `--live`, `--force`, `--object`, `--direction`).
- **Identity = `Account.SAP_ID__c`** (SWAPPED from the old `SAP_Company_Code__c`). `resolveAccount(sapId)` matches `SAP_ID__c`; returns `{id,name,sapId,companyCode}`. connections.json key `distributor.sapId` (falls back to old `sapCode`). Staging rows filtered on **`SAP_Id__c`** (new field on all 10 staging objects); inbound rows dual-stamp `SAP_Id__c` + `SAP_Company_Code__c`.
- **Config-driven cycle** (`syncRunner.mts runCycle`): reads enabled+due `Sync_Config__c` rows for the distributor; per row dispatches by `Object_Type__c`. Masters run before transactions.
- **Transport**: Tally HTTP/XML at 127.0.0.1:9000 (`httpFetch`, no external npm deps in the live path). Tally must be idle (no modal) + gateway on port 9000. Dev/QA Tally company = FY2017-18, so **voucher dates must be ~2017-08-01**.

## Sync_Config object types (all wired into the cycle)
`Invoice, Purchase, Order, Note, PurchaseOrder, Account, Product, Godown`. Direction = `ToTally | ToSalesforce | Both`. Masters (`Account`, `Product`, `Godown`) hardcoded-field (no Field_Mapping); transactions mapping-driven for the HEADER (lines are hardcoded fields). `Product`/`PurchaseOrder` are ToTally-only. Schedule: Interval (Frequency_Minutes__c) or Daily (Daily_Time__c).

## Built + Tester-verified + committed + deployed to BOTH orgs
Recent commits (newest first): `afd5965` docs+gitignore · `f2902e3` setup-screen labels · `b2c08ed`(pills, later removed) · `a90b98f` search/filter · `a78a0d0` Sync Config Setup LWC+Apex · `afadd83` wire SAP-id backfill into cycle · `9868e80` orders carry no godown alloc · `d9a4492` default godown · `d0030c3`/`8de37d4` godown feature · `7e9d3dc`/`1ee19de` identity→SAP_Id · `2ce74ba`/`2f84501` note GST sign fix · `9e89de3` state backfill tool · `0f33ed3` masters+PO into cycle · `87541b7` watermark · `d9a…`.

Verified working: identity swap (resolve by SAP Id); masters both ways (Account/Product/Godown) + SAP-id backfill to Tally (org generates SAP → written onto ledger MordeSAPID, idempotent); purchase (+stock, Input GST); credit/debit notes (GST sign fix: Output debited / Input credited, balanced); godown routing (explicit + default `Main Location`, orders carry NO allocation); GST intra (CGST+SGST) / inter-state (IGST from party state); cycle dispatch (14–15 actions, masters first); state auto-fill from `$LedStateName`/GSTIN; backfill CLI.

## Salesforce Sync Config Setup screen (LWC `tallySyncConfigSetup` + Apex `TallySyncConfigSetup`)
Tab **"Tally Sync Setup"** (`Tally_Sync_Setup`) in the Tally_Sync app + permission set (tab + classAccesses). Pick 1+ distributors (datatable, search "Filter by Name or SAP code", status filter Show: All / Already configured / Not configured yet; "Sync configured" col = Yes(N)/Not yet). Per-object matrix (include + direction), schedule, **Apply** → idempotent upsert (keyed Account+Object_Type) for all selected accounts; **Load existing config** pre-fills from a configured distributor. 5/5 Apex tests. Deployed both orgs. (UI itself needs human click-test.)

## === NEW DIRECTION (2026-10-23) — reconcile with the org's existing objects ===
User: **do NOT use our `Tally_Godown__c`** — the org already has objects to follow:
- **`Tally_Shipping_Address__c`** = the "Tally Addresses" object. Fields: `Account__c`(→Account), `Tally_Account__c`(→Tally_Account__c), `Shipping_Address__c`(→Shipping_Address__c), `Full_Address__c` (compound Address: Street/City/PostalCode/**StateCode**/CountryCode/geo), `Address_Type__c`, `Is_Default__c`, `Active__c`, `SAP_ID__c`, `Tally_Guid__c`, `Sync_Status__c`. ← use THIS for the address/location (ship-to) concept instead of the godown object.
- **`Tally_Price__c`** = the "Tally Price" object our **pricing must follow**. Fields: `Customer__c`(→Account), `Account__c`(→Account), `Product__c`(→Product2), `Price__c`(currency), `Quantity__c`(slab), `Start_Date__c`/`End_Date__c` (validity window), `UOM__c`, `Direction__c`, `Sync_Status__c`, `Tally_Guid__c`, `SAP_ID__c`, `Price_Source__c`/`Price_Source_Tag__c`, `Active__c`, `Error__c`. It already has the connector bridge-field pattern (Direction/Sync_Status/Tally_Guid/Error) → it's designed to be synced by the connector. (`Tally_Pricing__c` is the raw SAP-fed pricing with Valid_From/To; `Tally_Price__c` looks like the connector-facing one.)

**Implication / open work (NOT yet done):**
1. **Addresses/warehouses**: rework to use `Tally_Shipping_Address__c` (ship-to addresses, per Account, with Full_Address + StateCode + Is_Default + Address_Type). Decide how/if the Tally **Godown** concept maps (Tally godown = stock location; the user's "customer multiple warehouses" = ship-to addresses → `Tally_Shipping_Address__c`). Likely RETIRE `Tally_Godown__c` (we created it: object + fields + Godown__c/Batch__c on 5 line objects + Sync_Config `Godown` value + permission set + cycle wiring in syncRunner/sfMaster/tallyMaster/sfAgent/tallyImport). Reconcile before UAT.
2. **Pricing**: build pricing to **follow `Tally_Price__c`** (Customer+Product+Price+Quantity+Start/End date + UOM, Direction/Sync_Status). This supersedes the earlier `docs/Pricing-PriceList-Scope.md` assumption of `Tally_Pricing__c`. Tally side = Price Levels + dated Price Lists (per-customer, validity, quantity slabs). GST place-of-supply = ship-to state (from `Tally_Shipping_Address__c.Full_Address__StateCode__s`).
3. Confirm with user: does the godown/stock-location idea go away entirely (addresses only), or do we still need Tally godowns for the distributor's own stock + use Tally_Shipping_Address__c for customer ship-to?

## UAT readiness
Connector is **regression-clean**. Gates before a full UAT (ORG-SIDE, not connector):
- **Broken org Flow `tmpVar1`** blocks `Tally_Invoice__c` AND `Tally_Order__c` inserts in QA (`FIELD_CUSTOM_VALIDATION_EXCEPTION: Automation error: Variable does not exist: tmpVar1`). Candidate flows: Invoice_Created_Notification_Flow / Create_Credit_Debit_Note_From_Invoice / Order_Invoice_Status_Flow (none literally contain tmpVar1 — likely a formula/other flow). MUST be fixed org-side; blocks sales + order-inbound legs.
- Org automation must **stamp `SAP_Id__c`** on To-Tally staging rows (identity dependency).
- Duplicate inbound line (null `Tally_Line_Key__c`) = org automation on header insert.
- Enable State picklist codes needed (TG/TS not enabled; GJ/KA/DL/TN/UP/RJ/WB/AP/MH are). Multiple Godowns (F11) per distributor if godown kept.
- For UAT org: deploy our metadata there; rebuild installers baked to UAT creds (currently QA-baked, v2.2.1); PUSH commits (all local).

## Parked / scoped (awaiting team decisions)
- Pricing (now must follow `Tally_Price__c`), quantity slabs / discounts / free-goods schemes, ship-to addresses (`Tally_Shipping_Address__c`). Price-list auto-pick is a Tally **UI** feature (manual entry); XML import does NOT auto-apply a price list — connector must resolve the rate for SF→Tally.
- Dead code removal: the original DB-export cluster (`index.mts`, `server.mts`, `tally.mts`, `definition.mts`, `utility.mts`, `logger.mts`, all of `src/sink/`) + unused deps (`mysql2, pg, pg-copy-streams, tedious, @google-cloud/bigquery, js-yaml, ws`) — ~3850 lines, bundled into every installer though the live connector uses only Node built-ins. Approved to remove, do it **post-UAT** on a branch (verify tsc + clean installer build). `fetchCollectionFields` in tallyLive is a dead orphan too.

## Key facts / gotchas
- BT01 = "Business Test Distributor", `SAP_ID__c = 990001`. 20 QA distributors have SAP ids; most have 0 Sync_Config (new).
- Inventory sign: ISDEEMEDPOSITIVE Yes=inward, No=outward; ACTUALQTY positive magnitude (Math.abs). Inventory voucher party line uses `<LEDGERENTRIES.LIST>` (NOT ALLLEDGERENTRIES) or Tally throws a bare EXCEPTION.
- GST not auto-calc on import — connector computes + posts to its own ledgers (Output/Input CGST/SGST/IGST, created+classified per company). Note GST sign = -partySign (opposite the party), ledger set = taxSide.
- MordeSAPID UDF: write plain `<MORDESAPID>`, read via COMPUTE `$MordeSAPID` (FETCH drops UDFs). TDL must be loaded in each distributor's Tally.
- Mandatory party state: `Require_Billing_State` validation rule on Tally_Account__c; connector auto-fills state on inbound; watermark advances on `pulled>0`.
- Two background agents used this session: a Fixer (fixes in dev + deploys to QA) and a Tester (QA integration tester). They won't survive compaction — re-spawn if needed.
