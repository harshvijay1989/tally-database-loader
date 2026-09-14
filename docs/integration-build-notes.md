# Tally ⇄ Salesforce Integration — Build Notes & State

> Living record of the two-way Tally⇄Salesforce integration for **Morde**. Captures what's
> built, what's verified, the design decisions, and what's next. Companion to
> [salesforce-agent-plan.md](./salesforce-agent-plan.md) (which has the voucher-import rules).
> **Status: working proof-of-concept; NOT production yet** (see "Production requirements").

## Two components (keep them distinct)

1. **Connector** — the local app installed at each distributor (this repo, `src/`). Talks to
   Tally over the HTTP/XML gateway (`localhost:9000`, UTF-16LE) and calls Salesforce outbound.
2. **Salesforce Integration** — org metadata in `salesforce/` (SFDX project): custom objects,
   permission set, tabs, Connected App. This is the *control plane*.

The connector is **outbound-only** (works behind NAT/firewall, cloud or local Tally). Salesforce
never calls in. Config/mapping/monitoring live in Salesforce; the connector is the mediator.

## Environment / facts

- **Sandbox org alias `morde`** = `harsh@crmlanding.in.dev`, instance
  `https://agility-page-6328--devmorde1.sandbox.my.salesforce.com`, API v62/67. **Sandbox — safe to test.**
- Run the **`sf` CLI via PowerShell**, not Bash (Bash hits `'C:\Program' is not recognized`).
- Connector Salesforce creds live in **`connections.json`** (git-ignored) under `salesforce`:
  `instanceUrl`, `loginUrl`, `clientId`, `clientSecret`, `apiVersion`. Client-credentials OAuth.
- **Auth model:** Client Credentials flow (no browser). Connected App = "Tally Connector" (External
  Client App), Client Credentials Flow enabled, **Run-As user = `erp.integration.user@devmorde1.com`**
  (Salesforce **Integration license** — CANNOT read standard objects like `Order`; user will replace
  with a proper-licensed user).
- **Test Tally company** ("Harsh Vijay"): ~8,121 ledgers, 3 stock items (**Billet, Packing Cover,
  TMT BAR** — all MT/pcs, GST-applicable 18%), 1 godown "Main Location", voucher types incl. Sales,
  Purchase, Sales Order, Purchase Order. Sales/Purchase/tax ledgers exist (`Sales`, `Purchase`,
  `Input CGST @ 9%`, `Input SGST @ 9%`, etc.).

## Salesforce org — what's deployed (`salesforce/force-app`)

Custom objects (all with tabs + in permission set `Tally_Sync_Integration`, assigned to the
integration user AND `harsh@crmlanding.in.dev`):
- **Distributor__c** — connector registry (currently EMPTY). Real distributors are **Accounts**.
- **Sync_Config__c** — per distributor × object × direction: Frequency_Minutes__c, Enabled__c,
  Debug__c, Direction__c, Last_AlterId__c (watermark).
- **Field_Mapping__c** — SF-authored mappings (Object_Type__c, Direction__c, Source_Field__c,
  Target_Field__c, Constant_Value__c, Transform__c, Active__c, Sort_Order__c). Seeded: Invoice
  ToSalesforce (6 rows) + Invoice ToTally (6 rows).
- **Tally_Invoice__c** — staging (Tally_Guid__c ext-id, Direction__c, Sync_Status__c, Error__c,
  Party_Name__c, Amount__c, Voucher_Date__c, Tally_Voucher_Number__c, Tally_AlterId__c, Raw_Payload__c).
  Has ~8 test rows.
- **Tally_Purchase__c** + **Tally_Purchase_Line__c** — staging for Order→Purchase (header + lines:
  Stock_Item__c, Quantity__c, Rate__c, Amount__c). Empty.
- **Sync_Log__c** — run/per-record results (Object_Type__c, Direction__c, Status__c,
  Records_Processed__c, Records_Failed__c, Message__c, Run_At__c).

**Salesforce data model facts:** Distributors = **Account** (121 accounts). Orders = standard
**`Order`** with Record Types **"Primary Order" / "Secondary Order"**; `Order.Distributor_Customer__c`
→ Account; line items = **OrderItem** (Product2, Quantity, UnitPrice). Products = **Product2**.
Order fields: Status (Draft…Activated…Invoiced…Closed), Type, EffectiveDate, TotalAmount.

## Connector — modules (`src/`, compiled to `dist/`)

- **tallyLive.mts** — Tally read: `postTallyXml` (UTF-16LE), `parseCollection`, `buildFetchXml(Filtered)`,
  `nameFilter`, `fetchAllWindowed` (AlterID-windowed FETCH*, crash-safe, discovery+export),
  `alterIdRangeFilter`, `probePresence`, `reachable`, `describeError`, `tallyErrorHint`.
- **httpFetch.mts** — dependency-free fetch (node:http/https), Node-14 safe (Win7/8).
- **sfClient.mts** — Salesforce API: `sfAuth` (client-credentials, cached), `sfQuery` (SOQL+paging),
  `sfUpsert` (Composite upsert by external id, ≤200), `sfInsert`, `sfUpdate` (PATCH by Id).
- **sfMapping.mts** — `loadMappings(objectType, direction)` downloads Field_Mapping__c; `applyMapping`;
  transforms (tallydate, sfdate, number, upper/lower/trim/abs).
- **sfAgent.mts** — `syncToSalesforce(spec)` (Tally→SF: read→map→upsert→Sync_Log); `syncToTally(spec)`
  (SF→Tally: read Pending staging→assemble→postVoucher→status back); `assembleVoucher`; `SYNC_SPECS`.
- **tallyImport.mts** — Tally WRITE: `buildVoucherImportXml` (picks LEDGERENTRIES vs ALLLEDGERENTRIES
  by view), `validateVoucher` (balance), `postVoucher` (dry-run + response parse),
  `ledgerExists`/`createLedger`/`ensureLedger` (master prereq).
- **uiServer.mts** — the connector UI + also has Salesforce refresh-token OAuth (auth-url/callback +
  PKCE) as an alternative auth path (not used by the agent, which uses client-credentials).

## Verified end-to-end (against sandbox + test Tally)

- **Tally → SF (Invoice): FULLY WORKING.** 43 vouchers → filter Sales (5) → download 6 SF-authored
  mappings → apply (incl. date transform) → upsert `Tally_Invoice__c` by GUID (5 ok, 0 failed) →
  `Sync_Log__c` written. Idempotent by `Tally_Guid__c`.
- **SF → Tally (accounting voucher): WORKING.** Sales invoice + Purchase (supplier credit + Purchase
  debit) import (`created=1`).
- **SF → Tally (GST inventory Purchase): WORKING.** Supplier "Morde Foods" auto-created under Sundry
  Creditors; connector-computed GST (CGST 9% + SGST 9%); TMT BAR stock line → Purchase ledger;
  `created=1, exceptions=0`.
- **Key voucher-import rules** (see salesforce-agent-plan.md §"Verified voucher-import rules"):
  EFFECTIVEDATE + OBJVIEW required; in-period dates; **Invoice Voucher View → `LEDGERENTRIES.LIST`**,
  Accounting View → `ALLLEDGERENTRIES.LIST` (using the wrong tag = bare EXCEPTION); signs
  (negative=debit=ISDEEMEDPOSITIVE Yes); inventory lines need `RATE n/UNIT`, `ACTUALQTY n UNIT`.

## Distributor identity (decided direction)

- One connector = one Tally company = one **Salesforce Account**. The **Account Id** is the single key
  everything is stamped with and filtered by.
- Connector can't read `Account` under the Integration license, so identity comes from EITHER
  (A) **baked per-distributor build config** (recommended — builds are already per-client), OR
  (B) a **Distributor__c registry** matched by **Tally company GUID**. With a proper-licensed user,
  the connector could also just resolve the Account directly.

## Production requirements (from the user — the real product)

Current build is a **proof, not production**. Target:
1. **Config-driven:** on install/startup and each cycle, the connector **pulls its config from
   Salesforce** (its "Connector Setup" record) and does exactly that — nothing hardcoded.
2. **Per-connector feature toggles:** e.g. Tally→SF ON, SF→Tally OFF for a given connector.
3. **Distributor stamping:** every Tally→SF record marked with which distributor (Account + name +
   Tally company) — provenance + filtering.
4. **Easy admin config in Salesforce** — an admin sets identity, toggles, frequency, mappings
   without it being "rocket science".
5. **Permissions:** user will provide a proper user / license — stop working around the Integration
   license.
6. **Order of work:** **Tally → SF first** (config-driven, toggles, stamping), then SF → Tally.
7. **Products → distributor Tally:** for SF→Tally, Morde's **Product2** must exist as **stock items**
   in each distributor's Tally (name, unit, GST) via master Import, before orders reference them.

## Can it be connector-only (no Salesforce code)?

**Yes, largely.** The connector reads/writes Salesforce via REST and applies mapping itself:
- Tally→SF: connector upserts directly to staging or real objects — no Apex/Flow needed.
- SF→Tally: connector can **poll the real `Order` directly** (given a proper-licensed user) instead
  of needing a Flow to copy to staging.
- SF-side code becomes **optional** (only for Morde-native automation). Staging objects remain a
  useful-but-optional audit/decoupling layer.

## Open decisions (asked, not yet answered)

1. **Admin config surface:** Salesforce record pages (fast, uses existing tabs) vs a custom LWC setup
   app vs records-now/LWC-later.
2. **Feature-toggle granularity:** per direction only vs per direction × per object.
3. **Product-sync scope:** push only products a distributor uses (just-in-time) vs full active catalog
   upfront vs decide when we start SF→Tally.

## Build order (next)

1. **Config layer:** a "Connector Setup" config in SF (likely evolve `Sync_Config__c`/`Distributor__c`)
   with identity + direction toggles + per-object frequency; connector **config-pull** each cycle.
2. **Tally→SF, production-grade:** config-driven specs, distributor **stamping**, incremental via
   AlterId watermark, retries, Sync_Log, respect toggles.
3. **SF→Tally:** product master-sync (Product2 → stock items) → Order(Primary/Activated) → Purchase
   voucher (works) with status write-back; respect toggles.
4. **Hardening:** encrypt secrets at rest, error surfacing, packaging, the admin UI.

## Production Tally→SF — BUILT this session (config-driven, logs to Trigger_Log__c)

Rebuilt the Tally→SF direction production-grade. All compiles (`tsc -p src/tsconfig.json`).
NOT yet run against live Tally/SF (standing rule: don't touch live Tally/Drive).

**Connector modules (new/changed):**
- `src/sfLog.mts` (NEW) — `logToTrigger(entry)` writes to Morde's shared **`Trigger_Log__c`**
  using their IntegrationLogger field shape. Best-effort (never throws). Replaces `Sync_Log__c`.
- `src/sfConfig.mts` (NEW) — the control-plane reader. `loadSyncConfigs(sapCode, direction)`
  returns only **Enabled** rows for THIS distributor (by SAP code) for that direction (Both counts
  for either); `isDue(cfg)` = per-mapping schedule; `resolveDistributor(sapCode)`; `saveWatermark`
  / `stampRun`. This is "connector calls SF before doing anything and only acts if allowed."
- `src/sfAgent.mts` (REWRITTEN) — now BOTH directions. `SPECS` (Invoice→Sales, Purchase→Purchase,
  connector-fixed Tally side). `syncToSalesforce(spec,cfg,dist,...)`: incremental voucher read
  `$VoucherTypeName = X AND $AlterID > watermark` via `fetchFilteredCollection` (bounded fields,
  serialized queue — never FETCH *), apply SF map (source lowercased to match parsed keys), upsert
  staging by `Tally_Guid__c`, stamp Distributor+AlterId, **advance watermark only if 0 failures**
  (else re-read next cycle = resilience), log to Trigger_Log__c. `syncToTally` kept, logging moved
  to Trigger_Log__c.
- `src/syncRunner.mts` (NEW) — `runCycle({server,port,dryRun,force})`: reads baked SAP code,
  resolves distributor, loops enabled+due ToSalesforce then ToTally configs. `bakedSapCode()` from
  `connections.json.distributor.sapCode`.
- `src/runSync.mts` (NEW) — CLI: `node dist/runSync.mjs [--live] [--force]`. **Dry-run by default.**
- `src/tallyLive.mts` — added exported `fetchFilteredCollection(...)` (serialized, bounded, FILTERed).

**Salesforce model changes:**
- `Distributor__c.SAP_Company_Code__c` (NEW, ExternalId/unique) — identity, ties to
  `Account.SAP_Company_Code__c`. Baked into per-distributor build.
- `Sync_Config__c` + `Last_Run__c`, `Retry_Enabled__c`, `Max_Retry_Count__c`,
  `Retry_Interval_Minutes__c` (mirror Integration_Config__mdt). Already had Object_Type/Direction/
  Enabled/Frequency_Minutes/Last_AlterId/Debug (= separate read/write toggles + per-mapping schedule
  + watermark).
- **Removed `Sync_Log__c`** (object + tab + permset entries) — we log to `Trigger_Log__c`.
- Permission set updated (new fields; Sync_Log__c refs dropped). Note: `Trigger_Log__c` access is
  assumed via Morde's existing integration user (not managed in our permset).

**To configure a distributor (runtime, no redeploy):** create `Distributor__c` with its SAP code;
add `Sync_Config__c` rows (Object_Type, Direction ToSalesforce/ToTally/Both, Enabled, Frequency);
author `Field_Mapping__c` (Object_Type, Direction, Source=Tally field, Target=SF field, Transform).
Connector `connections.json` needs `{ "distributor": { "sapCode": "<code>" } }`.

**Still TODO for prod:** deploy metadata to sandbox + smoke-test dry-run; ship default
Field_Mapping__c rows; bake per-distributor SAP code + shared client-credentials into the installer;
encrypt connections.json secrets; wire a scheduler (OS task / connector timer) to call runSync;
then SF→Tally product master-sync (Product2 → Tally stock items) + Order→Purchase.

## Morde's EXISTING framework (found in org — reuse it, don't reinvent)

Morde already has a mature integration + logging framework. Key parts:
- **Logging → `Trigger_Log__c`** (shared application log; IntegrationLogger writes to it). Fields:
  `Integration_Name__c`, `Operation__c`, `Object_Name__c`, `Class_Name__c`, `Method_Name__c`,
  `Log_Level__c`, `Status__c`, `Status_Code__c`, `Error_Message__c`, `Stack_Trace__c`,
  `Request_Body__c`, `Response_Body__c`, `Request_Endpoint__c`, `HTTP_Method__c`,
  `Related_Record_Id__c`, `Retry_Count__c`, `Started_At__c`, `Completed_At__c`, `Duration_MS__c`.
  → **Our connector logs here** (drop my `Sync_Log__c`).
- **`Integration_Config__mdt`** — metadata config for **SF→external callouts** (Endpoint_Path__c,
  Named_Credential__c, HTTP_Method__c, Auth_Type__c, Timeout__c, Is_Active__c, Retry_Enabled__c,
  Max_Retry_Count__c, Retry_Interval_Minutes__c, Log_Request/Response__c). Records: SAP_Create_Order,
  SAP_Morde, SAP_Morde_Return.
- **Apex**: IntegrationService/Executor/HttpClient, IntegrationLogger/LoggingService,
  **IntegrationRetryService** (retry), IntegrationQueueable, IntegrationConfigService; SAP-specific
  SAPOrderIntegrationService, InvoiceSAPIntegrationAPI, ProformaInvoiceSAPIntegrationAPI,
  OpportunityProductSyncService. Plus `Trigger_Control__mdt`, `Log_Event__e`, many `*__mdt`.

**Critical architecture note:** Morde's framework is **SF → external (outbound callouts to SAP)**.
Our Tally connector is the **opposite — external → SF (inbound)**, behind a firewall, so it does NOT
run inside their Apex framework. We **reuse their conventions**: log to `Trigger_Log__c`, key on **SAP
codes**, follow the metadata-driven + retry pattern. Think of Tally as "another ERP endpoint" alongside SAP.

**Codes (everything is keyed by a code):** distributor = `Account.SAP_Company_Code__c` (also `SAP_ID__c`,
`FSSI_code__c`); products = `Product2.SAP_ID__c` / `General_Code__c` / `ProductCode` / `SapCategory__c`.

## Reconciled production design (per user's requirements, 2026-09-14)

1. **Identity = SAP Company Code.** On install, map the connector to its distributor via
   `Account.SAP_Company_Code__c`; everything stamped/keyed by codes (not SF Ids). Baked into the
   per-distributor build config. **Credentials are BAKED** (shared client-credentials Connected App);
   the distributor never authenticates to SF. (User will set the Connected App run-as user.)
2. **Metadata-driven read/write control, checked at runtime.** Per distributor × mapping: separate
   **Read (Tally→SF)** and **Write (SF→Tally)** enable flags, held in SF; the connector **calls SF
   before every action** to check it's allowed, then acts. No connector redeploy to change config.
   (Evolve `Sync_Config__c` — keyed by SAP code — into this control table.)
3. **Resilience + per-mapping scheduling.** Handle Tally-down / internet-down: staging rows stay
   Pending, connector retries (log Retry_Count__c to Trigger_Log__c); nothing lost. **Each mapping
   scheduled separately** (per-mapping frequency in the config).
4. **Mapping shipped + SF-editable; SF-side fields fixed.** Ship default mappings; admins can change
   *some* fields in SF; the **target SF fields are fixed in the connector**; all controlled via SF —
   no connector push to change a mapping.
5. **Logging → `Trigger_Log__c`** (replace `Sync_Log__c`).
6. **Staging objects stay** (Tally maps into them). **Build Tally→SF first**, then SF→Tally
   (incl. Product2 → Tally stock-item master sync so SF→Tally can resolve items).

**Open design decisions:** config as Custom Metadata (`__mdt`, shipped/deployable) vs custom object
(`Sync_Config__c`, per-distributor data + per-mapping schedule) — leaning custom object for
per-distributor/per-mapping scheduling + toggles, mappings possibly `__mdt`. Confirm before building.

## Git

Branch **`mordefoodspakcage`**. Recent integration commits: SFDX model, Field_Mapping, SF client +
mapping engine, agent (both directions), tallyImport (inventory + ensureLedger + view-tag fix), tabs,
docs. Salesforce metadata is versioned under `salesforce/`. `connections.json` and `drive-upload.mjs`
are git-ignored (contain secrets).
