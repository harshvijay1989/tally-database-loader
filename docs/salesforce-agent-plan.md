# Plan: Salesforce-driven two-way sync agent (Morde)

> **Scope: DESIGN / PLAN ONLY.** No implementation yet. This documents the
> architecture, Salesforce data model, connector additions, security, and build order
> so it can be executed later.

## Context

Morde runs Salesforce and wants to bring its **distributors** onto it. Each distributor
runs its own Tally (some cloud-hosted, some local) with **our connector installed
locally**. Because Salesforce **cannot reach** a connector behind NAT/firewalls, the
connector must be the initiator: it always **calls out to Salesforce**. Salesforce
becomes the **control plane** — configuration, frequency, field mapping, monitoring and
debugging all live there; the connector is a **mediator**.

**Four staging objects**, all bidirectional: **Orders, Purchase, Invoice, Note** — where the
**Note** object covers both **Credit Note** and **Debit Note** via a type field (5 Tally voucher
types collapse into 4 SF staging objects, since Credit and Debit notes share the same structure).

Confirmed decisions:
- **Connector stays as-is; we ADD an agent module** — the existing local UI + one-way
  export keep working; the SF agent is a new background capability, reusing existing infra.
- **Morde-only** — single Morde org, tailored to these objects (not a generic product).
- **Mapping authored in Salesforce, applied by the connector** (both directions).
- **Two-way for all four objects**, including **writing vouchers into Tally** (new, high-risk).
- **Auth: one Morde org, per-distributor OAuth** (Connected App), TLS, secrets encrypted at rest.

## Architecture overview

```
  Distributor machine (behind firewall)          Morde Salesforce (control plane)
  ┌───────────────────────────────┐              ┌──────────────────────────────┐
  │  Connector (existing app)      │  outbound    │  Config + Mapping (per dist.) │
  │  + NEW SF Agent module         │ ───HTTPS──►  │  4 Staging objects            │
  │   • poll config/frequency      │              │  Sync Log / run status        │
  │   • Tally→SF: read+map+upsert  │  ◄──poll───  │  Connected App (OAuth)        │
  │   • SF→Tally: pull+map+WRITE   │              └──────────────────────────────┘
  │  Tally (local/cloud) ◄─XML─►   │                        │ SF-side Flow/Apex
  └───────────────────────────────┘              staging ⇄ real SF objects (Morde's side)
```

The connector never listens for inbound; it **polls** on a frequency set in Salesforce.
Salesforce-side automation (Morde's Flow/Apex) maps staging ⇄ real SF objects — out of
connector scope. The **connector↔staging** hop is what we build.

## Salesforce side (data model — Morde's org)

Delivered as SF metadata (custom objects + a Connected App). Connector only touches the
staging + config + log objects.

- **4 staging objects** — `Tally_Order__c`, `Tally_Purchase__c`, `Tally_Invoice__c`,
  `Tally_Note__c` (with `Note_Type__c` = Credit/Debit to cover both note voucher types).
  Common fields: `Distributor__c` (scope), `Tally_Guid__c` (unique External Id — idempotency
  key both ways), `Direction__c` (ToSalesforce / ToTally), `Sync_Status__c` (Pending/Done/Error),
  `Error__c`, `Tally_VoucherNumber__c`, `Tally_AlterId__c`, plus the mapped business fields + a
  raw JSON payload field for anything unmapped.
- **Master objects** — `Tally_Ledger__c`, `Tally_StockItem__c` (+ units/godowns/voucher-types as
  needed), keyed by `Tally_Guid__c`, scoped by `Distributor__c`. Kept in sync **before** vouchers
  so every voucher reference resolves (see "Master data sync").
- **`Distributor__c`** — one per connector install; holds identity + enabled flag.
- **`Sync_Config__c`** — per distributor × object: `Frequency__c` (minutes), `Enabled__c`,
  `Debug__c`, `Direction__c`, date-window / watermark settings.
- **`Field_Mapping__c`** (or Custom Metadata) — per object × direction: source path →
  target field + transform. This is the "mapping stays in Salesforce" store the connector
  downloads and applies. Mirrors the existing `FieldMapping` shape in
  [platform-architecture.md](./platform-architecture.md).
- **`Sync_Log__c`** — run + per-record results the connector writes back for monitoring/debug.
- **Connected App** — OAuth; each distributor authenticates with its own credential
  (refresh-token for v1; JWT bearer as the scale upgrade). Data scoped by `Distributor__c`.

## Connector side (added to the existing app)

New module `src/sfAgent.mts` (background loop), plus a new Tally-**write** module. Reuses:
- `httpFetch` ([src/httpFetch.mts](../src/httpFetch.mts)) — Node-14-safe HTTPS for all SF calls.
- SF auth/query/upsert — consolidate the two existing impls (`sfAuth`/`sfApi`/`upsertRecords`
  in [src/uiServer.mts](../src/uiServer.mts) and
  [src/sink/salesforceSink.mts](../src/sink/salesforceSink.mts)) into one SF client the agent uses.
- Tally READ — `postTallyXml`, `parseCollection`, `fetchAllWindowed`, `buildFetchXml`
  ([src/tallyLive.mts](../src/tallyLive.mts)); voucher date-range + `$AlterID` incremental pattern from
  `processVoucherCollectionDateRange` ([src/tally.mts](../src/tally.mts#L502)).
- Logging — `logLine` + Drive/`/api/log` live log already in place.

**Agent loop (per enabled config, on its frequency):**
1. **Auth** to Morde SF (per-distributor refresh-token OAuth), refresh access token as needed.
2. **Pull config + mapping** for this distributor (frequency, enabled, debug, direction, field maps).
3. **Master-data sync** (prerequisite): align ledgers/stock items/tax ledgers/units/godowns/voucher
   types — Tally→SF is authoritative ("Tally wins"); create any SF-origin master in Tally first, so
   every voucher reference resolves.
4. **Tally → SF** (read): incremental voucher read by AlterID/date window → apply SF map →
   `upsert` staging by `Tally_Guid__c` (Composite upsert). Advance AlterID watermark.
5. **SF → Tally** (write): SOQL staging where `Direction__c='ToTally' AND Sync_Status__c='Pending'`
   → apply SF map → **build Tally Import XML** (carry the **SF-generated `VOUCHERNUMBER`** for
   traceability) → **write to Tally** → write status + Tally result back to the staging record.
   On conflict, **Tally wins** — never overwrite a newer Tally version.
6. **Report** run + per-record results to `Sync_Log__c`; heartbeat the distributor's status.

**NEW — Tally write module** `src/tallyImport.mts` (the risky piece):
- Build `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST>…` with
  `<TALLYMESSAGE><VOUCHER ACTION="Create|Alter">…` (UTF-16LE transport reused).
- **Dependency ordering**: referenced masters (ledgers, stock items, voucher types) must
  exist first — create/verify masters before vouchers.
- **Idempotency**: key by `Tally_Guid__c`; use `ACTION="Alter"` on re-send; never
  blind-insert. Parse Tally's import response for `<CREATED>/<ALTERED>/<ERRORS>`.
- **Dry-run mode** (debug): build + validate XML, log it, do NOT post — for safe testing.

## The business objects in Tally terms

Each maps to a Tally **voucher type**; ref [docs/data-structure.md](./data-structure.md)
("Voucher Types Effects", "Order Vouchers"). Header lives in `trn_voucher`; effects in
`trn_accounting` (financial) and `trn_inventory` (stock).

| SF staging | Tally voucher type | Accounting | Inventory | Party ledger | Notes |
|---|---|---|---|---|---|
| Orders | **Sales Order / Purchase Order** | ✗ | ✗ | customer / supplier | `is_order_voucher=1`; no financial/stock impact; needs Order Processing enabled in Tally |
| Purchase | **Purchase** | ✓ | ✓ if goods | supplier | debit purchase/stock + tax, credit supplier |
| Invoice | **Sales** (invoice mode) | ✓ | ✓ if goods | customer | debit customer, credit sales + tax |
| Note (type=Credit) | **Credit Note** | ✓ | ✓ (sales return) | customer | reduces customer balance |
| Note (type=Debit) | **Debit Note** | ✓ | ✓ (purchase return) | supplier | reduces supplier balance |

*(Credit Note and Debit Note share the single `Tally_Note__c` staging object, distinguished by
`Note_Type__c` — 5 voucher types, 4 staging objects.)*

So the framework needs, per object: a **voucher-type name**, a **party ledger**, **ledger
allocations** (sales/purchase + tax), and — when goods are involved — **inventory
allocations** (stock item, qty, rate) each pointing at an accounting ledger.

## Requirements to CREATE records in Tally (SF→Tally write-back)

This is the genuinely new, high-risk capability (today the connector only reads). A voucher
is created by posting an **Import Data** request over the same UTF-16LE gateway:

```
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA><REQUESTDESC>...SVCURRENTCOMPANY...</REQUESTDESC>
  <REQUESTDATA><TALLYMESSAGE><VOUCHER ACTION="Create" VCHTYPE="Sales">
     <DATE>YYYYMMDD</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
     <PARTYLEDGERNAME>…</PARTYLEDGERNAME><VOUCHERNUMBER>…</VOUCHERNUMBER>
     <ALLLEDGERENTRIES.LIST> LEDGERNAME, ISDEEMEDPOSITIVE, AMOUNT …
     <ALLINVENTORYENTRIES.LIST> STOCKITEMNAME, ACTUALQTY, RATE, AMOUNT,
        ACCOUNTINGALLOCATIONS.LIST, BATCHALLOCATIONS.LIST …
     <BILLALLOCATIONS.LIST> NAME, BILLTYPE(New Ref), AMOUNT …
  </VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
```

**Hard requirements / gotchas (must be handled or the import fails or corrupts data):**
1. **Prerequisite masters MUST already exist** — party ledger, sales/purchase + tax ledgers,
   stock items, units, godowns, and the voucher type. Missing name → import error. The
   connector must either verify/create masters **first** (dependency order: masters → vouchers)
   or fail with a clear message. This is the #1 operational constraint.
2. **Amounts must balance and carry the right sign.** Per data-structure.md: in `trn_accounting`,
   **negative = Debit, positive = Credit**; driven by `ISDEEMEDPOSITIVE`. Debits must equal credits
   or Tally rejects the voucher.
3. **Inventory sign**: negative qty = Outward (sales), positive = Inward (purchase).
4. **Idempotency**: send a stable **GUID** (or a unique reference) and use `ACTION="Alter"` (or
   REMOTEID/MASTERID) on re-send so a retry updates rather than duplicates the voucher.
5. **Numbering**: Salesforce-generated number carried in as `VOUCHERNUMBER` (see Resolved
   decisions); the voucher type must allow manual/override numbering.
6. **Date** format `YYYYMMDD`; **company** via `SVCURRENTCOMPANY`.
7. **Parse the response** — `<CREATED>/<ALTERED>/<ERRORS>/<EXCEPTIONS>/<LINEERROR>` — and write
   the outcome (Tally voucher number or error) back to the staging record.
8. **GST / tax auto-calc**: Tally can auto-compute tax via voucher class, or tax ledgers can be
   posted explicitly — decide per Morde's setup.
9. **Safety**: dry-run mode (build + log XML, don't post), validate before posting, and **test only
   against a non-production Tally company** first.

**Verdict on feasibility:** yes — this is a standard Tally Import; the transport (`postTallyXml`,
UTF-16LE) is already ours. The real work is the **XML builder per voucher type**, **master
prerequisite handling**, **balancing/sign logic**, and **response parsing** — all new, and all
needing careful testing against a throwaway company before any live use.

### Verified voucher-import rules (learned by testing against the sandbox company)

These are empirically confirmed in `src/tallyImport.mts` (all created `created=1, exceptions=0`):

1. **`EFFECTIVEDATE` + `OBJVIEW` are required.** Without them Tally rejects with
   *"Voucher date is missing … retry Split"* even though `<DATE>` is present.
2. **Date must be inside the company's open period.** In-period dates import; an out-of-period
   date gives the same misleading "date is missing" error. (Use the SF date, mapped to YYYYMMDD.)
3. **Ledger-entry tag depends on the view — this was the big one:**
   - **Accounting Voucher View** (no stock): party/ledger postings use `<ALLLEDGERENTRIES.LIST>`.
   - **Invoice Voucher View** (has stock lines): party/tax postings use **`<LEDGERENTRIES.LIST>`**,
     and stock lines go in `<ALLINVENTORYENTRIES.LIST>` (each with `<ACCOUNTINGALLOCATIONS.LIST>`
     to the Purchase/Sales ledger). Using `ALLLEDGERENTRIES` in invoice view → bare `EXCEPTION`,
     no line error. `buildVoucherImportXml` now picks the tag automatically.
4. **Signs:** `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` = debit (negative amount); `No` = credit
   (positive). Debits must equal credits (ledger postings + inventory accounting allocations net to 0).
5. **GST is connector-computed (decision):** stock items here are GST-applicable, so a stock line
   alone makes Tally attempt tax auto-calc. We add explicit tax ledger lines — e.g. intra-state 18%
   → `Input CGST @ 9%` + `Input SGST @ 9%` (debits), party credited for taxable+tax. (Inter-state →
   `Input IGST …`.) Tax ledger names + intra/inter rule are config.
6. **Inventory line format:** `<RATE>5250.00/MT</RATE>`, `<ACTUALQTY>10.00 MT</ACTUALQTY>`,
   `<BILLEDQTY>…</BILLEDQTY>` — the unit must match the stock item's base unit.
7. **Master prerequisite:** `ensureLedger()` creates a missing ledger (e.g. supplier *Morde Foods*
   under *Sundry Creditors*) via a master Import before the voucher references it.
8. **Response:** `<CREATED>/<ALTERED>/<ERRORS>/<EXCEPTIONS>`; `EXCEPTIONS>0` with no `<LINEERROR>`
   means a structural/tax rejection (not a plain error) — the hard-to-debug case above.

**Order → Purchase (Morde):** a Salesforce **Primary Order** (RecordType on standard `Order`,
`Distributor_Customer__c` = an Account) means the distributor is buying from Morde → a **Purchase**
in the distributor's Tally. Because the connector runs on a **Salesforce Integration license** (can't
read standard `Order`), Morde's Flow copies Activated Primary Orders into `Tally_Purchase__c`
(+ `Tally_Purchase_Line__c`); the connector reads that staging and imports the Purchase voucher.

## Security

- Per-distributor **OAuth** (Connected App), **TLS 1.2+** (Node's own OpenSSL, OS-independent).
- **Encrypt secrets at rest** — today `connections.json` stores tokens near-plaintext; add
  encryption (OS DPAPI / a key) for the distributor OAuth credential. (Gap to close.)
- **Least privilege** integration user; data scoped per `Distributor__c`.
- **Write-safety for Tally**: validate every voucher before posting, dependency-order masters,
  idempotent by GUID, dry-run mode, and a hard rule to test against a **non-production Tally
  company** first. Writing to accounting data is the single biggest risk here.

## Resolved decisions

1. **Masters handling → sync masters FIRST.** Before any voucher sync, a **master-data sync**
   step keeps the shared masters aligned on both sides (see "Master data sync"), so every ledger /
   stock item a voucher references already exists in Tally. Vouchers never post against a missing master.
2. **Numbering → Salesforce-generated, carried into Tally**, for end-to-end traceability (the SF
   number is the shared key you can track across both systems). The connector passes it as
   `VOUCHERNUMBER`; the relevant Tally voucher types must allow manual/override numbering (not
   forced Auto). *(For vouchers that originate in Tally and flow up, Tally's own number is kept.)*
3. **Conflict rule → Distributor's Tally wins.** If the same record changed on both sides, the
   Tally version is authoritative and overwrites the Salesforce side.
4. **OAuth provisioning → one-time browser sign-in at install** (reuse the existing Google-Drive
   OAuth pattern in [src/uiServer.mts](../src/uiServer.mts)): during setup the distributor signs into
   Morde's Salesforce once, we store the **refresh token** (encrypted). Headless thereafter.
5. **JWT vs refresh-token → refresh-token for v1** (matches #4, no per-distributor certificates to
   manage). **JWT bearer** is the documented upgrade path for zero-touch, cert-based provisioning at scale.

## Master data sync (prerequisite component)

Because vouchers reference masters by name, and "Tally wins," masters are synced before
transactions each run:
- **Masters in scope**: party ledgers (customers/suppliers), sales/purchase/tax ledgers, stock
  items, units, godowns, voucher types.
- **Tally → SF**: reuse `fetchAllWindowed` to pull masters into SF master objects (keyed by
  `Tally_Guid__c`), so Salesforce always knows the valid names to map against. Authoritative direction.
- **SF → Tally**: if a master originated in Salesforce (e.g. a new customer created there) and is
  needed by an outbound voucher, create it in Tally via **Import (masters)** **before** the voucher.
- Run order each cycle: **masters sync → Tally→SF vouchers → SF→Tally vouchers**.

## Build order (when implemented)

0. SF data model (4 staging + **master objects** + Distributor + Sync_Config + Field_Mapping + Sync_Log) + Connected App + refresh-token OAuth (one-time browser sign-in).
1. Agent skeleton: auth + poll loop + pull config + heartbeat/Sync_Log write-back.
2. **Master-data sync (Tally→SF)** — ledgers, stock items, tax ledgers, units, godowns, voucher types, keyed by GUID. Prerequisite for safe write-back.
3. Direction A (Tally→SF) for ONE object (e.g. Invoice): incremental read → map → upsert staging.
4. Direction B (SF→Tally) for ONE object (e.g. Orders): ensure masters exist (create SF-origin masters first) → build Import XML with SF `VOUCHERNUMBER` → **dry-run** → write → status back.
5. Generalize the map-apply engine + config to all 4 staging objects (5 voucher types), both directions.
6. Hardening: secret encryption, retries/backoff, watermarks, conflict handling (**Tally wins**), debug/dry-run polish.

## Verification (when built)

- Stand up a **Morde SF sandbox** + a **local test Tally company** (reuse
  [tools/tally-loadtest](../tools/tally-loadtest)).
- Tally→SF: run agent, confirm staging upserts by GUID, watermark advances, Sync_Log written.
- SF→Tally: seed a staging record, run in **dry-run** (inspect XML), then write to the TEST
  company and confirm the voucher + status write-back. **Never test writes against live Tally.**
