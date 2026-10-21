# Scope — Date-Valid, Per-Customer Pricing (Price Lists) for the Tally ⇄ Salesforce Connector

**Status:** scoping only — not built. For team review before we commit to the build.

## Goal
Honor **customer-specific, time-bound prices**: a product can sell to different customers (or
customer groups) at different prices, each price **valid for a date range**, and revised over
time (a new price supersedes the old one from its effective date). This must work for:
- **Tally-only distributors** — the price list must physically live **in Tally**, so when they
  bill a customer inside Tally the correct price is applied automatically.
- **Salesforce-driven orders** — the connector can instead resolve the right price and stamp it
  on the order line (no Tally price list strictly required for this path).

A complete solution does **both**.

## What already exists (so we're not starting from zero)
- **`Tally_Pricing__c`** in Salesforce already models this (SAP-fed): `Tally_Product__c`,
  `Account__c` / `Ship_To__c`, `Price_List__c`, `Segment__c`, `Sales_Org__c`,
  `Distribution_Channel__c`, `Plant__c`, geography, `UOM__c`, `Currency_Code__c`, `isActive__c`,
  and crucially **`Valid_From__c` / `Valid_To__c`** + **`Price__c`**.
- The connector already sends a **per-line rate** (`Rate__c`) to Tally and reads it back — so
  "each line its own price" works today. What's missing is *deriving/pushing* the price from the
  dated price master.
- The connector has **no** price-list / price-level handling today.

## How it maps to Tally
Tally's native mechanism is **Price Levels + dated Price Lists** (requires F11 → **Use Multiple
Price Levels** = Yes):
- **Price Level** = the pricing "bucket" a customer belongs to. A customer ledger is tagged to a
  price level.
- **Price List entry** = per (price level × stock item), a **rate** with an **"Applicable From"**
  date (and optionally quantity slabs + discount %). Multiple dated entries stack; Tally bills at
  whichever is valid for the voucher date and keeps history for back-dated vouchers.
- Mapping: `Valid_From__c → Applicable From`, `Price__c → rate`, `UOM__c → per-unit`, product →
  stock item. A revised price = a new dated entry under the same level.

## The hard constraint (must be decided)
Tally's price model is **simpler** than the SAP pricing on `Tally_Pricing__c`. A Tally price is
keyed only by **price level × item × applicable-from** (+ slab/discount). It **cannot** represent
the extra SAP dimensions — `Sales_Org__c`, `Distribution_Channel__c`, `Segment__c`, `Plant__c`,
geography, `Currency_Code__c`. So we must decide **which dimension becomes the Tally price level**
and which dimensions are dropped/assumed-constant per distributor.

## Open questions for the team (these shape the build)
1. **Price-level grain** — per **individual customer** (one Tally price level per customer, its
   ledger tagged to its own level) and/or per **customer group** (`Price_List__c` / `Segment` →
   one level shared by many customers)? *(You indicated it's both — so the design should let a
   customer either carry its own prices or inherit a group's.)* We need the exact rule: which
   `Tally_Pricing__c` field identifies the group, and how a customer is resolved to a level.
2. **Validity / expiry semantics** — Tally uses *Applicable From* only (a price runs until the
   next dated price). What should happen when a price **expires (`Valid_To__c`) with no successor**
   — fall back to no price (error), the last price, or a base price? And back-dated/gap handling.
3. **Which distributor owns which rows** — how is a `Tally_Pricing__c` row scoped to a distributor
   (so we push only that distributor's prices)? (e.g. `Sales_Org__c`, a distributor lookup, or via
   the customer `Account__c`.)
4. **Quantity slabs / discounts / schemes** — see the dedicated section below; decide how far to go.
5. **Currency / UOM** — assume INR + the product's base unit, or honor `Currency_Code__c`/`UOM__c`?
6. **Direction** — push price list **to Tally** (needed for Tally-only distributors) only, or also
   **resolve-on-post** for SF-driven orders (recommended: both)?

## Quantity slabs, discounts & schemes
- **Quantity slabs ("sell ≥ N → this rate / this much off")** — **native to Tally price lists**:
  each price-level × item entry can carry quantity ranges (from–to qty), each with its own rate
  and discount %. Rides along with the price-list build; no separate mechanism.
- **Discount** — the line objects already have **`Discount__c`**, and the connector **captures it
  on inbound (Tally→SF)**. Gap: the **SF→Tally write does not send a discount** yet (no `<DISCOUNT>`
  tag) — a **small** add. Tally supports a line discount % and price-list discount natively.
- **Free-goods schemes (buy X get Y free)** — Tally has **no built-in scheme engine**, but free
  goods are modeled via **Actual Qty vs Billed Qty** (bill 10, deliver 12 → 2 free). The connector
  **already emits both `ACTUALQTY` and `BILLEDQTY`** but currently sets them **equal**; supporting
  free goods means carrying billed-vs-free separately (a line field + write change) — **small–medium**.
- **Complex promotional schemes** (value-based free goods, "buy 10 get 1 free" slab rules, combo
  offers) — no native Tally feature; the **connector would compute the scheme** from SF rules and
  emit the resulting free qty / extra line. **Larger**; needs its own rule model in Salesforce and
  a decision on where scheme logic lives (SF vs connector).

**Decision for the team:** how far into this to go in v1 — (a) quantity-slab prices + discount in
the price list (comes mostly free with the price-list build), (b) + line discount on write, (c) +
free-goods via actual/billed qty, (d) + a full scheme engine (significantly larger).

## Build outline (once decisions land) — ~larger than the godown feature
**Salesforce**
- `Tally_Pricing__c` likely needs: integration-user **FLS** (permission set), a scoping/`Sync_Status`
  convention, and a **`Sync_Config` Object Type = `Pricing`** to schedule it.
- Possibly a small **Price Level** reference (if we name/track levels in SF).

**Connector**
- New Tally helpers: create/alter **Price Levels** and **Price List** entries via XML
  (`<PRICELEVELLIST>` / price-list master structures), and **assign a price level to a party
  ledger** (extend the account/ledger master write).
- `sfMaster`: `syncPricingToTally` — read `Tally_Pricing__c` (scoped to the distributor), group by
  level, push dated price-list entries; (optional) `syncPricingToSalesforce` for round-trip.
- `syncRunner`: dispatch the new `Pricing` object type, before transactions (prices depend on
  products + party ledgers existing first → ordering: Account/Product/Godown → Pricing →
  transactions).
- (Optional, SF-driven path) a `resolvePrice(product, customer, date)` used in `syncToTally` to
  stamp the line rate when a line has no explicit rate.

**Tally (per distributor)**
- Enable F11 → **Use Multiple Price Levels**. Price levels + customer ledger assignments in place.

**Testing (Fixer → Tester loop)**
- Push a dated price list; bill a customer in Tally and confirm the valid price applies; push a
  revision and confirm the new price applies from its date while the old voucher keeps its price;
  per-customer vs group; regression (products with no price list unaffected).

## Risks / notes
- **Per-customer price levels at scale** — one level per customer is unusual in Tally; fine
  functionally but heavier. Grouping (Q1) mitigates this.
- **Tally price-list XML is fiddly** (nested price-level/slab structures) — expect a probe-first
  pass like we did for godowns.
- **Dimension loss** — anything beyond price-level × item × date is not representable in Tally.
- Feasibility is **not in doubt** (Tally price lists are a standard, API-writable feature); the
  effort is in the mapping decisions above + the connector build + testing.
