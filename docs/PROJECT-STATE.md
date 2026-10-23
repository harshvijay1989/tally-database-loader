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

## === NEW DIRECTION (2026-10-23) — reconcile with org objects (SCHEMA-GROUNDED, confirmed) ===
Retire our `Tally_Godown__c`; use the org's objects. Verified live against `mordeqa` (`sf sobject describe`); both target objects are currently **EMPTY** (0 rows) so we define conventions.

**`Tally_Shipping_Address__c`** — plays BOTH the godown (stock-location) role AND the ship-to role. Exact fields: `Account__c`(→Account), `Tally_Account__c`(→Tally_Account__c), `Shipping_Address__c`(→Shipping_Address__c, org's own object), `Full_Address__Street__s`/`__City__s`/`__PostalCode__s`/`__StateCode__s`(picklist AN..WB)/`__CountryCode__s`(IN), `Address_Type__c`(**free string**, no picklist), `Is_Default__c`(bool), `Active__c`(bool), `SAP_ID__c`, `Tally_Guid__c`, `Sync_Status__c`(picklist **{To Tally|From Tally}**). No Parent, no Code.
- **`Address_Type__c` convention we define: `Warehouse`** = distributor's own godown (stock location); **`Shipping`** = customer ship-to.

**On `Tally_Invoice__c` AND `Tally_Order__c` only** (NOT Purchase/PurchaseOrder/Note) the org added header lookups:
- **`Warehouse_Address__c`** →`Tally_Shipping_Address__c` = the distributor godown this voucher ships FROM (→ Tally godown on the inventory lines).
- **`Customer_Shipping_Address__c`** →`Tally_Shipping_Address__c` = customer ship-to (→ voucher shipping address + GST **place-of-supply state**).
- (also `Customer_Ship_To_Address__c` & `Dispatch_Address__c` → the org's OTHER `Shipping_Address__c` object — connector ignores these.)

**`Tally_Price__c`** — pricing object; **`Direction__c` picklist = {ToTally} ONLY → SF→Tally one-way**. Fields: `Customer__c`(→Account), `Account__c`(→Account=distributor), `Product__c`(→Product2), `Price__c`(currency), `Quantity__c`(double, slab), `Start_Date__c`/`End_Date__c`(validity), `UOM__c`, `Sync_Status__c`(picklist **{Pending|Done|Error}**), `Tally_Guid__c`, `SAP_ID__c`, `Price_Source__c`/`Price_Source_Tag__c`, `Active__c`, `Error__c`. → Tally **Price Lists** (per-party price level, dated, qty slabs). (`Tally_Pricing__c` = raw SAP-fed, ignore.)

**PLAN (phased):**
- **Phase 1 — addresses/godown — DONE in code (commit `1714604`), NOT yet deployed.** (a) `sfMaster`: `syncGodownsTo*`→`syncWarehousesTo*` now read/write `Tally_Shipping_Address__c` where `Address_Type__c='Warehouse'`, `Account__c=dist`, keyed by `Tally_Guid__c` (Tally godown machinery in `tallyMaster` unchanged). (b) `sfAgent`: godown per-HEADER via `Warehouse_Address__c` (Invoice/Order ship-FROM + **Purchase receive-INTO** — we added `Warehouse_Address__c` to `Tally_Purchase__c` so purchases can land stock in a chosen godown; else `resolveDefaultGodown` fallback); customer ship-to only on Invoice/Order; `Customer_Shipping_Address__c` emitted as voucher consignee/shipping address (additive — no ship-to ⇒ byte-identical XML); GST place-of-supply = ship-to `Full_Address__StateCode__s`, fallback party billing state, compared via `canonStateCode`. New `stateNameFromCode`/`canonStateCode` in `stateCodes`. (c) retired `Tally_Godown__c` + `Godown__c`/`Batch__c` on all 5 line objects + perm-set entries (repo only; **org destructiveChanges still pending**). Sync_Config `Object_Type__c`: `Godown`→`Warehouse`, added `Price`; LWC default matrix updated. (d) `syncRunner` dispatch renamed `Warehouse`. tsc clean.
  - **INBOUND TODO (deliberate, deferred):** Tally→SF no longer captures line godown; header `Warehouse_Address__c` is NOT back-filled from an inbound voucher's godown name (would need a per-distributor godown-name→warehouse-address map). Low priority — sales flow is SF→Tally.
  - **DEPLOY TODO:** add `Tally_Shipping_Address__c` + `Tally_Price__c` object/field perms + the Invoice/Order `Warehouse_Address__c`/`Customer_Shipping_Address__c` lookups to the integration user's access (verify live — org objects may already grant it); define `Address_Type__c='Warehouse'`/`'Shipping'` convention with the team.
- **Phase 2 — pricing — DONE in code (compiles), NOT yet deployed/tested.** New `src/tallyPrice.mts` (Tally-side: `ensurePriceLevel` on the company, `setLedgerPriceLevel` on the party ledger, `upsertStockItemPrice` = dated/qty-banded FULLPRICELIST entry on the stock item) + `src/sfPrice.mts` (`syncPricesToTally`: pulls `Tally_Price__c` `Sync_Status__c='Pending'` + `Direction__c='ToTally'` for the distributor `Account__c`; resolves **Customer→Tally party ledger** via `Tally_Account__c` [Distributor__c + Account__c], **Product→Tally stock item** via `Tally_Product__c` [Account__c + `Dist_Product_Mapping__r.Product__c`]; one price level **per customer, named for the ledger**; stamps `Done`/`Error` + synthetic `Tally_Guid__c`). Wired into `syncRunner` ToTally as `Price` (ToSalesforce skipped — one-way). Sync_Config `Price` value + LWC matrix already present.
  - **⚠ VERIFY LIVE (top test priority):** the Tally price-list XML (FULLPRICELIST.LIST / PRICELEVELLIST.LIST / APPLICABLEFROM / STARTINGFROM / PRICELEVEL / RATE) and price-level creation via the Company master are a best-known reconstruction — confirm/adjust against the live company. Company needs **"Use Multiple Price Levels"** (F11 > Inventory) enabled (one-time, not settable over the gateway). Advanced pricing (customer-group pricing, discount/free-goods schemes) still awaits the team's scope decision.
- Then: tsc + installer build; deploy both orgs; **whole-system live test** per **`docs/Acceptance-Test-Warehouse-Pricing.md`** (user's scenario: distributor + 2 warehouses → product → purchases into each warehouse [per-godown stock IN] → retailer + ship-to → prices → sales order + invoice [per-godown stock OUT] → assert per-godown add/subtract + GST by place of supply + idempotency); destructive object/field deletes LAST (after confirm).

## UAT readiness
Connector is **regression-clean**. Gates before a full UAT (ORG-SIDE, not connector):
- ~~Broken org Flow `tmpVar1`~~ **RESOLVED (2026-10-23):** probe inserts of `Tally_Invoice__c` AND `Tally_Order__c` now succeed in BOTH orgs (dev `morde` + QA `mordeqa`); no flow/validation rule in either org references `tmpVar1` anymore. Sales leg unblocked.
- **Phase 1/2 metadata DEPLOYED to both orgs (2026-10-23):** 250 components each, clean. Connector run-as user = **Harsh Vijay (harsh@crmlanding.in.qa / .dev), System Administrator** → already has full access to `Tally_Shipping_Address__c` + `Tally_Price__c` (no perm-set additions needed). Tally up (TallyPrime), company "Harsh Vijay" FY2017-18, **MultiGodown=Yes**.
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
