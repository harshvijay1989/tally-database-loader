# Acceptance Test — Multi-Warehouse Inventory + Pricing (end-to-end)

_User-defined whole-system scenario (2026-10-23). Run AFTER deploy. Proves per-warehouse inventory
add/subtract across purchases and sales, plus per-customer pricing. Dev/QA Tally company is
FY2017-18, so all voucher dates must be ~2017-08-01._

## Goal
Create a distributor with **two warehouses**, one product, **purchases into each warehouse** (so stock
differs per warehouse), a **retailer with its own ship-to**, **prices**, then an **order + invoice**,
and verify Tally inventory goes **up on purchase** and **down on sale** in the **correct godown**.

## Prerequisites (one-time, per distributor Tally company)
- Tally running, gateway on 127.0.0.1:9000, idle (no modal), MordeSAPID.tdl loaded.
- **F11 > Inventory: "Maintain multiple Godowns" = Yes** and **"Use multiple Price Levels" = Yes.**
- Connector built + metadata deployed; integration user has access to `Tally_Shipping_Address__c`,
  `Tally_Price__c`, and the `Warehouse_Address__c` / `Customer_Shipping_Address__c` lookups.
- `Address_Type__c` convention: **`Warehouse`** = distributor godown, **`Shipping`** = customer ship-to.

## Step 1 — Distributor + 2 warehouses
1. Account (the distributor) with a unique `SAP_ID__c` (e.g. `990010`). Set its Billing State (for GST).
2. Two `Tally_Shipping_Address__c` rows, `Account__c` = distributor, `Address_Type__c = 'Warehouse'`,
   `Sync_Status__c = 'To Tally'`: **"North WH"** and **"South WH"** (give one `Is_Default__c = true`).
3. Sync_Config rows for the distributor: `Warehouse` (Both), `Product` (ToTally), `Purchase` (Both),
   `Order` (Both), `Invoice` (Both), `Price` (ToTally), `Account` (Both).
4. Run a cycle (`runSync --object Warehouse --direction ToTally --force --live`).
   **✓ Assert:** two godowns "North WH" / "South WH" now exist in Tally (and each row got a `Tally_Guid__c`).

## Step 2 — Product
1. Ensure a `Tally_Product__c` for the distributor (via DistProduct_Mapping) with a base UOM
   (e.g. `pcs`), GST %, and a SAP Id; `Tally_Guid__c` blank.
2. Run `--object Product --direction ToTally --force --live`.
   **✓ Assert:** stock item exists in Tally with the base unit + GST; its `Tally_Guid__c` is written back.

## Step 3 — Purchases into different warehouses (inventory IN)
1. `Tally_Purchase__c` #1: supplier ledger, date 2017-08-01, `Warehouse_Address__c` = **North WH**,
   `Direction__c='ToTally'`, `Sync_Status__c='Pending'`, `SAP_Id__c` = distributor SAP. One line:
   product, **Qty 100**, rate, amount.
2. `Tally_Purchase__c` #2: same supplier/product, `Warehouse_Address__c` = **South WH**, **Qty 40**.
3. Run `--object Purchase --direction ToTally --force --live`.
   **✓ Assert (the core of this test):** in Tally, **North WH stock = 100**, **South WH stock = 40**
   (Godown Summary / Stock Item godown-wise). Total stock = 140. Both purchases posted Input GST.

## Step 4 — Retailer + its ship-to
1. Account (the retailer/customer). Its Tally party ledger exists (sync `Account` or create a
   `Tally_Account__c` under the distributor: `Distributor__c` = distributor, `Account__c` = retailer).
2. `Tally_Shipping_Address__c` for the retailer: `Account__c` = retailer, `Address_Type__c='Shipping'`,
   with a `Full_Address__StateCode__s` (choose a **different state** than the distributor to prove IGST,
   or the same state to prove CGST+SGST).

## Step 5 — Prices (per customer/product/qty/validity)
1. `Tally_Price__c`: `Account__c` = distributor, `Customer__c` = retailer, `Product__c` = the product,
   `Price__c` = (e.g.) 150, `Quantity__c` = 1, `Start_Date__c` = 2017-08-01, `UOM__c` = pcs,
   `Direction__c='ToTally'`, `Sync_Status__c='Pending'`.
2. Run `--object Price --direction ToTally --force --live`.
   **✓ Assert:** a price level named for the retailer's ledger exists and is assigned to that ledger;
   the stock item's price list shows 150/pcs from 2017-08-01 for that level; the row flips to `Done`
   with a synthetic `Tally_Guid__c`. (Verify the exact Tally price-list XML here — top priority.)

## Step 6 — Sales Order then Invoice (inventory OUT of a chosen warehouse)
1. `Tally_Order__c` (Sales Order): party = retailer, date 2017-08-01, `Warehouse_Address__c` = **North WH**,
   `Customer_Shipping_Address__c` = the retailer ship-to, one line Qty 30. Push ToTally.
   **✓ Assert:** Sales Order recorded (no stock movement yet — order is a commitment), consignee/ship-to
   address + place of supply appear on it.
2. `Tally_Invoice__c` (Sales): party = retailer, date 2017-08-01, `Warehouse_Address__c` = **North WH**,
   `Customer_Shipping_Address__c` = retailer ship-to, one line Qty 30 (optionally referencing the order).
   Push ToTally.
   **✓ Assert:**
   - **North WH stock = 70** (100 − 30); **South WH stock = 40** (unchanged). Total = 110.
   - GST split = IGST if retailer state ≠ distributor state, else CGST+SGST (place of supply = ship-to).
   - Voucher carries the ship-to (consignee) address + PLACEOFSUPPLY.

## Step 7 — Cross-checks
- Sell from **South WH** (Qty 10) → South WH = 30, North WH = 70, total = 100.
- Over-sell a warehouse (e.g. 999 from South) → Tally negative-stock behaviour surfaces as expected.
- Re-run every leg → **idempotent** (no duplicate vouchers/godowns/price rows; watermarks hold).

## Pass criteria
Per-godown balances match the arithmetic at every step; GST side correct by place of supply; prices
land on the right level; all legs idempotent; staging rows end `Done` (or `Error` with a clear reason).
