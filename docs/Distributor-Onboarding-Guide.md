# Distributor Onboarding — Complete Setup Guide

How to connect one distributor's **Tally** to your **Salesforce** so customers, products,
purchases, sales, orders and GST flow automatically between the two — in both directions.

You'll work through four parts:
1. **Salesforce** — create the distributor and switch on the syncs.
2. **Tally** — prepare the distributor's Tally.
3. **Connector** — install and point it at the distributor.
4. **Verify** — one test to prove it's working.

> 💡 A few one-time technical items (done once by your admin/IT) are collected in the
> **"For your IT team"** box at the end. If those are already in place for your org, skip them.

---

## Before you start — have these ready
- Access to **Salesforce** (and the **Tally Sync Integration** permission set assigned to the
  connector's user — see the IT box).
- The connector installer: **`TallySalesforceConnector-Setup-2.2.1-qa.exe`** (or `-qa-win7` for
  Windows 7/8).
- The Tally add-on file **`MordeSAPID.tdl`** (we provide this).
- The distributor's **Windows machine** with **Tally** and their company loaded.

---

## Part 1 — Salesforce

### Step 1 — Create the distributor (Account) — *1 record*
Create (or open) the distributor's **Account** and set:
- **SAP Company Code** — a short code you choose, e.g. `D01`. *You'll type this exact code into
  the connector, so it's the link between the two.*
- **Distributor SAP ID** — the distributor's SAP number, e.g. `100200`. *Used as the prefix when
  the system auto-generates customer/product codes.*
- **Billing State** — the distributor's own state, e.g. *Maharashtra*. **Required** — it decides
  whether a sale is taxed as same-state (CGST+SGST) or inter-state (IGST).
- Record type **Distributor**, **Active** = true.

### Step 2 — Switch on the syncs (Sync Config) — *create 7 rows*
Create one **Sync Config** record per item below. For every row: **Enabled = true**, **Account =
the distributor Account** from Step 1, and a **schedule** (either *Interval* every N minutes, or
*Daily* at a set time).

| Object Type | Direction | What it syncs |
|---|---|---|
| **Account** | Both | Customer/supplier ledgers — sends to Tally **and** reads back (also fills each customer's State automatically) |
| **Product** | To Tally | Products / stock items → Tally *(one-way; there is no product read-back)* |
| **Invoice** | Both | Sales invoices, both directions |
| **Purchase** | Both | Purchases, both directions |
| **Order** | Both | Sales & purchase orders, both directions |
| **Note** | Both | Credit notes & debit notes, both directions |
| **Purchase Order** | To Tally | Primary purchase orders (you → distributor) *(one-way)* |

- **"Both"** = a single row drives *both* directions. Prefer separate schedules per direction?
  Create two rows instead (one *To Tally*, one *To Salesforce*).
- **Account** and **Product** run **before** the transaction rows each cycle, so the people and
  products a voucher refers to always exist first.

### Step 3 — Make sure the supporting data is complete
- Every **customer / supplier Account** that will sync needs a **Billing State** (same reason as
  the distributor's — it drives GST, and it's required).
- Every **product** needs its **GST %** filled in (a product with no rate is sold with no tax).

---

## Part 2 — The distributor's Tally (one time)

On the distributor's machine, in Tally:

### Step 1 — Load the Morde add-on (`MordeSAPID.tdl`) — **required**
*This lets the connector tag records so nothing is ever duplicated.*
1. Copy the `MordeSAPID.tdl` file onto the machine (e.g. the Desktop).
2. Press **F1 (Help) → TDL & Add-On** (older Tally: *F1 → TDL Configuration*).
3. Choose **Manage Local TDLs**, set *Load TDL on startup* = **Yes**, and add the full path to
   `MordeSAPID.tdl`.
4. **Accept**, then **restart Tally.**

### Step 2 — Let the connector reach Tally (port 9000) — **required**
Tally must run as a *server* on the machine: **F1 (Help) → Settings → Connectivity** (older Tally:
*F1 → Advanced Configuration*) → set TallyPrime to **act as Server**, **Port 9000**. *If this is
off, nothing syncs.* Keep Tally open while the connector runs.

### Step 3 — Turn on the features the flows need
- **Order processing** (sales orders and purchase orders) — in Features (**F11**).
- **GST** — in Features (**F11**). *The connector creates its own GST tax ledgers automatically;
  you don't make them by hand.*

### Step 4 — Check the period
Make sure the company's **current period/date** covers the dates you'll be entering, or Tally
rejects vouchers.

*(Tip: fill in each customer/supplier's **State** and **GSTIN** in Tally — the connector reads
these and copies the State up to Salesforce automatically.)*

---

## Part 3 — Install & run the connector

### Step 1 — Install
Run **`TallySalesforceConnector-Setup-2.2.1-qa.exe`** (or `-qa-win7`). It's pre-connected to
Salesforce — no logins or passwords to enter.

### Step 2 — Point it at the distributor
Launch it — a page opens at **localhost:3000**. Enter the **Distributor SAP Company Code** (e.g.
`D01`) — it must match **exactly** what you set on the Account in Part 1, Step 1.

### Step 3 — (Only if the distributor already has existing ledgers) fill in their States once
Existing customer ledgers won't get a State on their own. From the connector's install folder, run:
- preview (no changes): `node dist\runSync.mjs --backfill-account-states`
- apply: `node dist\runSync.mjs --backfill-account-states --live`

### Step 4 — Let it run
The connector runs quietly in the background on the schedule you set and restarts with the
computer. (Click **Run Now** in the connector if you want to trigger a cycle immediately.)

---

## Part 4 — Verify (one test)

1. In Salesforce, create a **test customer** for this distributor — **with a Billing State**.
2. In the connector, click **Run Now** (or wait for the schedule).
3. In Tally, confirm the customer ledger now appears (Gateway → Ledgers). Back in Salesforce, the
   record now shows a **Tally reference** — the two are linked.
4. Enter a **purchase** (goods in) and a **sales invoice** (goods out). Confirm:
   - stock goes **up** on the purchase, **down** on the sale;
   - GST is correct: **same state** → CGST + SGST; **different state** → IGST.
5. Try a **Credit Note** (sales return → stock back, reduces output tax) and a **Debit Note**
   (purchase return → stock out, reduces input tax).
6. Watch the **activity log** (Trigger Log) for each run's status and any errors.

---

## How GST & State work
- **Rate** comes from each product's **GST %**. No rate → 0 tax (and a warning).
- **Same-state vs inter-state** is decided from the **distributor's State** vs the **customer's
  State**. Same → **CGST + SGST**; different → **IGST**. If a State is missing it falls back to
  same-state — which is why State is required on everyone.
- The connector works out a customer's State from their Tally ledger's **State** (or their
  **GSTIN**) and copies it into Salesforce automatically.

## If something goes wrong
- **"A Billing State is required."** — The customer (or distributor) record has no State. Add it.
- **Tax looks wrong (CGST/SGST vs IGST).** — Check both the distributor's and the customer's State.
- **A product sold with no tax.** — That product is missing its GST %.
- **Nothing syncs.** — Check the Sync Config is **Enabled**, the **SAP Company Code** matches
  exactly, and **Tally is open and acting as a server on port 9000**. Then check the activity log.
- **"Voucher date is missing."** — The date is outside Tally's open period; use an in-period date.
- **Some old customers keep failing with "State required."** — Their Tally ledgers have no State;
  add it in Tally (or run the backfill in Part 3, Step 3). Once fixed they sync on the next run.

---

<details>
<summary><b>📦 For your IT team — one-time technical setup (per Salesforce org, not per distributor)</b></summary>

1. **Permission set.** Assign **Tally Sync Integration** to the integration user the connector
   signs in as (Setup → Permission Sets → *Manage Assignments*). It grants the staging objects,
   the Purchase Order objects, and the `Tally_Account__c` / `Tally_Product__c` masters (incl. read
   on `BillingAddress__c`, needed for the GST state).

2. **State & Country picklist.** Enable every Indian state the distributors/customers operate in
   (Setup → *State and Country/Territory Picklists* → Configure → India → state **Active + Visible**
   with its 2-letter **Integration Value**, e.g. Telangana = `TG`). A state that isn't enabled is
   silently dropped on save and then trips the "State required" rule. Already enabled in QA:
   `GJ, KA, DL, TN, UP, RJ, WB, AP, MH`.

3. **Field / object API names** (for finding things above): distributor Account fields
   `SAP_Company_Code__c`, `SAP_ID__c`; sync rows on `Sync_Config__c` (`Object_Type__c`,
   `Direction__c`, `Enabled__c`, `Account__c`, `Schedule_Type__c`, `Frequency_Minutes__c`,
   `Daily_Time__c`); the mandatory-state rule `Require_Billing_State` on `Tally_Account__c`.

4. **Object Type values** the connector understands (on `Sync_Config__c.Object_Type__c`):
   `Invoice, Purchase, Order, Note, PurchaseOrder, Account, Product`. `Product` is To-Tally only
   (no inbound); `PurchaseOrder` is To-Tally only.

5. **Backfill existing ledgers' state** (one-time, if the distributor already has ledgers): from
   the install folder, `node dist\runSync.mjs --backfill-account-states` (preview) then `--live`.

6. **This build targets the QA (test) Salesforce.** For go-live, rebuild the installer against the
   production org.

</details>
