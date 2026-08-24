# Tally load-test data (dev only)

Creates a **large** local Tally company so we can reproduce the big-company
`FETCH *` crash and prove the safe fetch fix. Our normal test company is tiny
(~100 ledgers) and can never reproduce it.

> ⚠️ These scripts **modify the currently-open Tally company**. Use a throwaway /
> test company. All records are prefixed `LT_` so `cleanup.mjs` can remove them.
> Never point this at a client's live Tally.

## Generate

```
node tools/tally-loadtest/generate.mjs 8000
```

Creates ~8,000 ledgers (default) under `Sundry Debtors` / `Sundry Creditors`, each
with nested data (address list, mailing details, GST, bank) so `FETCH *` is as
heavy as a real company. Imports in batches of 500 via Tally's HTTP Import gateway
(`TALLYREQUEST=Import Data`, `REPORTNAME=All Masters`). Idempotent — re-running
alters the same records.

Env: `TALLY_HOST`, `TALLY_PORT` (default `localhost:9000`), `BATCH` (default 500).

## Clean up (restore the company)

```
node tools/tally-loadtest/cleanup.mjs
```

Deletes every `LT_`-prefixed Ledger / StockItem / Group.

## What this validates

- **Reproduce:** old `FETCH *` over the full ledger collection times out / wedges Tally.
- **Fix:** `TYPE=Object` discovery + a single bounded-field export request stay fast and
  keep Tally responsive on the same big company.

## Import format notes (from Tally docs)

- The name must appear as a **child** element: `<NAME.LIST><NAME>…</NAME></NAME.LIST>`
  (the `NAME=` attribute alone is rejected).
- `<TALLYMESSAGE xmlns:UDF="TallyUDF">` is required.
- Escape `&`, `<`, `>` in values.
- GST/bank/party fields belong on **party-type** ledgers (Sundry Debtors/Creditors);
  putting them on Cash/Bank ledgers throws exceptions.
