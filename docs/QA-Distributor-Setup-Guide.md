# Setting up one Distributor on the Tally ⇄ Salesforce Connector (QA)

A do-it-yourself checklist to onboard a single distributor end to end in **QA (mordeqa)**.
Three parts: Salesforce setup → the distributor's Tally + connector → a smoke test.

> **New (important):** a party ledger's **Billing State is now mandatory** on `Tally_Account__c`
> (it drives GST intra- vs inter-state). The connector auto-fills it from the Tally ledger on the
> inbound pull, but records created without a resolvable state are **rejected**. See step A3 and
> the "GST & state" notes below — this is the #1 thing that trips up a new setup.

---

## 0. Prerequisite — QA storage
If QA is at its data-storage limit (`STORAGE_LIMIT_EXCEEDED`), **no records can be created** and
every sync fails the same way. If you hit that:

- Setup → **Storage Usage** to see what's consuming it.
- Delete old **`Trigger_Log__c`** rows (they pile up fast) and any stale **`Tally_*`** test
  records, or raise the sandbox allocation.
- Confirm it's clear by creating any one test record successfully.

---

## Part A — Salesforce (QA)

1. **Permission set → integration user.**
   Setup → Permission Sets → **Tally Sync Integration** → *Manage Assignments* → add the
   user the connector authenticates as. This grants object + field access for the staging objects,
   the **Tally Purchase Order** objects, and the master objects **`Tally_Account__c`** /
   **`Tally_Product__c`** (incl. read access to **`BillingAddress__c`**, needed for the GST state).
   Without it the connector sees "no data / no access" or "No such column".

2. **Distributor Account.** Create or pick the distributor's Account (the same way `BT01` /
   `ME01` are set up) with:
   - **`SAP_Company_Code__c`** = a short code, e.g. `D01` — *this is what the connector matches
     on* (you type it into the connector).
   - **`SAP_ID__c`** = the distributor's own SAP id, e.g. `100200` — used as the **prefix** when
     the org auto-generates customer/product SAP ids. (If blank, SAP generation is skipped.)
   - **Billing State** (`BillingStateCode`, e.g. `MH`) — **set this.** It's the distributor's own
     state and is how the connector decides **intra vs inter-state GST**. If it's blank, *every*
     voucher is taxed intra-state (CGST+SGST) and inter-state sales will never produce IGST (the
     connector logs a warning when this happens).
   - Record type = **Distributor** (as your org uses), **Active** = true.

3. **Enable the States you operate in** (one-time, org-wide).
   Setup → **State and Country/Territory Picklists** → *Configure* → **India** → make sure every
   state the distributor and its customers are in is **Active + Visible**, with the right 2-letter
   **Integration Value** (e.g. Maharashtra `MH`, Telangana `TG`). A state that isn't enabled is
   **silently dropped** on write — so the party ends up with no state and then fails the mandatory
   rule. Known-enabled in QA today: `GJ, KA, DL, TN, UP, RJ, WB, AP, MH`. (The connector maps a
   Tally ledger's state name / GSTIN to this code automatically; it just needs the code enabled.)

4. **Sync_Config__c** — one row per object × direction you want to run, **Enabled**, linked to
   the distributor Account:
   - Objects: **Invoice, Purchase, Order, PurchaseOrder, Note**
   - Direction: **ToTally** (push to Tally) and/or **ToSalesforce** (read from Tally)
   - Schedule: **Interval** (every N minutes) or **Daily** (HH:MM)
   - *(`BT01`/`ME01` already have Invoice/Purchase/Order/Note configs — add a
     **PurchaseOrder / ToTally** row for the primary purchase-order flow.)*

5. **Field mappings** are org-wide defaults and already deployed — nothing to do unless you
   want to customise a field (editable in the connector UI or via `Field_Mapping__c`).

---

## Part B — the distributor's Tally + the connector

**On the distributor's Windows machine:**

1. **Tally setup (one-time):**
   - **Load the TDL:** F1 (Help) → **TDL & Add-On** → *Manage Local TDLs* → add `MordeSAPID.tdl`
     → Accept → restart Tally. *(Creates the SAP-Id field the connector reads/writes. Mandatory.)*
   - **Enable the gateway:** F1 (Help) → **Settings → Connectivity** (older: *Advanced Config*) →
     TallyPrime **acts as Server**, **Port 9000**. The connector talks to Tally on `127.0.0.1:9000`;
     if it's off (or a Tally screen/modal is blocking it), nothing syncs. Keep Tally open.
   - **Enable order processing:** F11 (Features) → set **Enable purchase order processing** and
     **Enable sales order processing** = Yes (needed for orders).
   - **GST:** make sure GST is enabled (F11). The connector **auto-creates** its own GST ledgers
     (`Output/Input CGST/SGST/IGST`, correctly classified) — you don't need to pre-make them.
   - **Party ledgers should carry a State / GSTIN** in Tally (under the ledger's statutory/GST
     details). The connector reads this on the inbound pull and writes the Billing State up to
     Salesforce — so a ledger with no state and no GSTIN will sync up *without* a state and then be
     rejected by the mandatory-state rule (it shows as a failure in `Trigger_Log__c`).
   - **Period/date:** make sure the company's active period covers the dates you'll post.

2. **Install the connector:**
   - Run **`TallySalesforceConnector-Setup-2.2.1-qa.exe`** (or `-qa-win7` on Windows 7/8). It's
     pre-wired to QA — no credentials to enter.
   - Launch it → your browser opens **http://localhost:3000**.
   - Enter the **Distributor SAP Company Code** (e.g. `D01`) — it must exactly match the
     Account's `SAP_Company_Code__c`.
   - (Optional) review field mappings in the UI; the connector pulls them from Salesforce.

3. **Backfill existing ledgers' state (one-time, if the distributor already has ledgers).**
   The *incremental* pull only re-reads changed ledgers, so pre-existing stateless customer
   ledgers won't get a state on their own. From the connector's install folder run:
   - dry-run (no writes, shows counts): `node dist\runSync.mjs --backfill-account-states`
   - apply: `node dist\runSync.mjs --backfill-account-states --live`
   It fills the Billing State on every `Tally_Account__c` whose Tally ledger has a resolvable
   state/GSTIN. Rows it can't resolve stay stateless (fix the state on the Tally ledger, then
   re-run).

---

## Part C — Smoke test (prove it works)

1. In Salesforce, create a test customer for the distributor — e.g. a **Distributor-Customer
   Account** (active, tagged to this distributor) **with a Billing State set**. The org's
   automation creates a `Tally_Account__c` (`To Tally`, SAP set, GUID blank). **The Billing State
   must be present** or the mandatory-state rule rejects it — this is the most common first-run
   failure.
2. In the connector, **Run Now** (or wait for the schedule).
3. Check **Tally**: the ledger appears (Gateway → Alter → Ledgers). Then check back in
   Salesforce — the **Tally GUID** has been written onto the record.
4. Push a **Purchase** (goods in) and a **Sales Invoice** (goods out) and confirm the stock
   moves the right way and GST posts:
   - customer in the **same state** as the distributor → **CGST + SGST** (split half/half);
   - customer in a **different state** → **IGST** (single line, full rate).
5. Push a **Credit Note** (sales return → stock back in, reduces **Output** GST) and a
   **Debit Note** (purchase return → stock out, reduces **Input** GST) to confirm note GST lands
   on the correct side.
6. Watch **`Trigger_Log__c`** for per-run status and any errors.

---

## GST & state — how it's decided
- **Rate** comes from each product's `GST_Percentage__c` (`Tally_Product__c`). A product with no
  rate posts **0 tax** and the connector logs a warning — set the rate on taxable products.
- **Intra vs inter-state**: distributor's state (Account Billing State) vs the party's state
  (`Tally_Account__c` Billing State). Same → CGST+SGST; different → IGST. If either side's state is
  unknown it falls back to **intra** (and logs a warning when the distributor's own state is blank).
- The connector derives a party's state from the Tally ledger's **state name**, or failing that the
  first two digits of its **GSTIN** (e.g. `27…` → Maharashtra), mapped to the SF state code.

## Good to know
- **`MordeSAPID.tdl` must be loaded** in every distributor's Tally — it's how the SAP id is
  stored/read. Without it, SAP ids silently don't persist.
- **Billing State is mandatory** on `Tally_Account__c` (validation rule `Require_Billing_State`).
  The connector fills it automatically from Tally on inbound; for Salesforce-origin (`To Tally`)
  party records you must set it yourself.
- **Date must fall in Tally's open period**, or Tally rejects the voucher with a misleading
  "Voucher date is missing".
- **Order close / pre-close** (cancel the unfulfilled part of an order) is a **manual Tally
  action** (Alt+W in Order Outstanding) — the connector does not drive it over XML.
- **Negative stock / overselling** follows the distributor's own Tally setting; the connector
  doesn't block it.
- The connector only acts on **Enabled** `Sync_Config__c` rows, and never double-posts
  (pending → done is one-way; vouchers carry the Tally GUID).
