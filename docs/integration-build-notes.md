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

## Git

Branch **`mordefoodspakcage`**. Recent integration commits: SFDX model, Field_Mapping, SF client +
mapping engine, agent (both directions), tallyImport (inventory + ensureLedger + view-tag fix), tabs,
docs. Salesforce metadata is versioned under `salesforce/`. `connections.json` and `drive-upload.mjs`
are git-ignored (contain secrets).
