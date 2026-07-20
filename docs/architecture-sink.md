# Sink adapter architecture — refactor plan (step 1)

Status: **proposal for review**. No source has been touched. This document is the
deliverable of step 1; implementation waits on your sign-off.

Goal of this step: extract a `SinkAdapter` interface, move each existing target
(`mssql`, `mysql`, `postgres`, `bigquery`, `csv`, `json`) behind it, and make
`tally.mts` talk to the interface instead of `database.*` + technology-string
`if` branches. **Zero behavior change.** A full/incremental sync must produce
byte-identical output.

---

## 1. What the code does today (the two extraction paths)

There are two independent producer/consumer pipelines, selected by whether
`config.tally.definition` ends in `.yaml` or `.json` (`isDefinitionYAML`).

### YAML / report path (the TSV fast path)
- `processReport()` posts TDL XML, runs `processTdlOutputManipulation()`, and writes
  a **tab-delimited, untyped** `./csv/<table>.data` file (header row + data rows).
  NULL dates are encoded in-band as `ñ` (char 241), emitted by the TDL expression
  `$$StrByCharCode:241` in `generateXMLfromYAML()`.
- Consumption: `database.bulkLoad(file, table, fieldTypes[])`. For SQL sinks this
  either builds batched `INSERT` statements (`loadmethod=insert`) or rewrites the
  file per-dialect and uses native bulk load (`loadmethod=file`). For `csv`/`json`/
  `bigquery` the file is converted (`convertCSV` / `csvToJsonArray`) and, for
  BigQuery, uploaded.

### JSON / collection path (typed rows in memory)
- `parseXmlToJsonCollection()` builds typed JS objects; `populateTableFromCollectionData()`
  flattens them into `Record<string, any>[]` rows already coerced to string / number /
  boolean / Date / null.
- Consumption: `database.bulkLoadTableJson(tableConfigJSON, rows)` (SQL sinks) or
  `database.jsonToCsv(...)` (+ BigQuery upload).

**Key observation for interface design:** the JSON path already produces exactly the
"batch of typed rows" the task asks the contract to be built around. The TSV `.data`
file is an optimization of the YAML path, not the fundamental unit. A future
Salesforce sink consumes typed rows and never touches `.data`.

### Every `database.*` call site in `tally.mts`
Grouped by the capability it implicitly assumes:

| Concern | Calls | Gated today by |
|---|---|---|
| lifecycle | `openConnectionPool`, `closeConnectionPool` | unconditional |
| schema mgmt | `listDatabaseTables`, `createDatabaseTables` | `/^(mssql\|mysql\|postgres)$/` |
| arbitrary SQL | `executeNonQuery`, `executeScalar` | inside SQL-only branches |
| truncate | `truncateTables` | `/^(mssql\|mysql\|postgres)$/` |
| TSV load | `bulkLoad` | `/^(mssql\|mysql\|postgres)$/` |
| typed-row load | `bulkLoadTableJson` | `/^(mssql\|mysql\|postgres)$/` |
| file conversion | `convertCSV`, `csvToJsonArray`, `jsonToCsv` | `csv\|json\|bigquery` |
| upload | `uploadGoogleBigQuery` | `bigquery` |
| config read | `database.config.*` | pervasive |

There are **19 distinct technology-string tests** across `importData()` and
`saveCompanyInfo()`. They all collapse to a handful of capability questions.

---

## 2. Proposed core data model

```ts
// definition.mjs (new types)

// Normalized logical datatype the sink sees. Superset of both existing
// vocabularies; the caller maps into it (see §2.1). No new wire vocabulary is
// introduced into the config files.
export type SinkDataType =
    | 'text' | 'number' | 'amount' | 'quantity' | 'rate' | 'date' | 'logical';

export interface SinkField {
    name: string;          // column / target field name
    datatype: SinkDataType;
}

export interface SinkTable {
    name: string;
    fields: SinkField[];
}

export interface RowBatch {
    table: SinkTable;
    rows: Record<string, any>[];   // typed rows; may be empty
}
```

`Record<string, any>` values are already-typed JS values (`string | number |
boolean | Date | null`), exactly as `populateTableFromCollectionData()` and
`csvToJsonArray()` produce them today.

### 2.1 The two datatype vocabularies — deliberately NOT unified in this step

Confirmed values in the config files:

- YAML `type`: `text, number, amount, quantity, rate, date, logical`
- JSON `datatype`: `string, number, decimal, boolean, date`

These differ (`text`↔`string`, `logical`↔`boolean`, YAML has `amount/quantity/rate`,
JSON has `decimal`). Unifying them is a **config-format change** and is out of scope
(backward-compat constraint). Instead:

- The YAML path keeps passing its `type[]` list into the **file fast path**
  (`loadTableFromFile`), which is the only place those strings are consumed for
  TSV parsing/quoting — behavior byte-identical to today.
- The JSON path maps `tableConfigJSON.fields[].datatype` → `SinkDataType` with a
  trivial adapter (`string→text`, `boolean→logical`, `decimal→number`, others
  pass through) when constructing a `SinkTable`. Note the sink only uses the
  datatype for typed-row loading (e.g. MSSQL column typing already re-reads the
  DB schema via `INFORMATION_SCHEMA`, so this mapping does not change what gets
  written).

I recommend keeping the two vocabularies separate now and unifying them only when
the mapping UI lands. Flagging in case you'd rather unify earlier.

---

## 3. Capabilities — replacing technology strings

A sink declares what it can do. This is what the `if (/^(mssql|mysql|postgres)$/)`
tests become.

```ts
export interface SinkCapabilities {
    /** executeNonQuery / executeScalar against the target (mssql,mysql,postgres). */
    sql: boolean;
    /** create/list tables from the bundled DDL scripts. */
    manageSchema: boolean;
    /** truncate existing tables before a full load. */
    truncate: boolean;
    /** the incremental diff/delete/cascade orchestration is supported. Implies sql. */
    incrementalSync: boolean;
    /** fast path: bulk-load a tab-delimited .data file straight from disk. */
    fileLoad: boolean;
    /** terminal output is files on disk that the caller post-processes (csv,json,bigquery). */
    fileOutput: boolean;
    /** persists the company-info metadata row set (everything except json). */
    persistsCompanyInfo: boolean;
}
```

Capability matrix for the six existing sinks:

| capability | mssql | mysql | postgres | bigquery | csv | json |
|---|---|---|---|---|---|---|
| `sql` | ✓ | ✓ | ✓ | | | |
| `manageSchema` | ✓ | ✓ | ✓ | | | |
| `truncate` | ✓ | ✓ | ✓ | | | |
| `incrementalSync` | ✓ | ✓ | ✓ | | | |
| `fileLoad` | ✓ | ✓ | ✓ | | | |
| `fileOutput` | | | | ✓ | ✓ | ✓ |
| `persistsCompanyInfo` | ✓ | ✓ | ✓ | ✓ | ✓ | |

Today all SQL capabilities are perfectly correlated (every SQL sink has all of
them). Modeling them separately is what lets a future Salesforce sink pick a
subset — e.g. Salesforce would be `{ sql:false, manageSchema:false, truncate:true
(via hard-delete), incrementalSync:false (step "porting incremental to JSON path"),
fileLoad:false, fileOutput:false, persistsCompanyInfo:true }` and drive `loadTable`
only.

---

## 4. The `SinkAdapter` interface

```ts
export interface SinkAdapter {
    readonly config: connectionConfig;
    readonly capabilities: SinkCapabilities;

    // lifecycle
    open(): Promise<void>;                 // was openConnectionPool
    close(): Promise<void>;                // was closeConnectionPool

    // THE CONTRACT — every sink implements this. Typed rows in, row count out.
    loadTable(batch: RowBatch): Promise<number>;

    // fast path — only when capabilities.fileLoad. Byte-identical to today's bulkLoad.
    loadTableFromFile?(table: SinkTable, filePath: string, fieldTypes: string[]): Promise<number>;

    // schema — only when capabilities.manageSchema
    listTables?(): Promise<string[]>;
    ensureSchema?(syncMode: string): Promise<void>;   // was createDatabaseTables

    // mutation / SQL — only when capabilities.sql / truncate
    truncateTables?(tables: string[]): Promise<void>;
    executeNonQuery?(sql: string | string[]): Promise<number>;
    executeScalar?<T>(sql: string): Promise<T>;

    // file-output post-processing — only when capabilities.fileOutput
    // (kept as a sink method so tally.mts stops owning convertCSV/csvToJsonArray/jsonToCsv routing)
    writeTableFile?(table: SinkTable, batchOrFile: RowBatch | string, fieldTypes?: string[]): Promise<number>;
}
```

Design notes:
- Optional methods are present **iff** the corresponding capability is true. Callers
  guard on the capability, then call. TypeScript's optional-method typing makes the
  guard mandatory, which is the point — no more string matching.
- `loadTable` is the single guaranteed method. `loadTableFromFile` is the documented
  optimization the task asked for.
- Incremental sync stays SQL-only for this step (its orchestration is inherently
  relational). It is gated by `capabilities.incrementalSync`; see §6 for the
  dialect-SQL question, which is the one real design decision I need from you.

### Config-driven metadata (company info)
`saveCompanyInfo()` in `tally.mts` mixes Tally extraction (must stay) with target
writing (SQL `INSERT` for DB sinks, `config.csv` for csv/bigquery, reject for json).
Recommendation: keep the Tally extraction in `tally.mts`, and route the write through
`capabilities.persistsCompanyInfo` + existing sink methods (`executeNonQuery` for SQL
sinks; `writeTableFile` for csv/bigquery). This removes the last technology-string
test from `tally.mts` without inventing new surface. Flagging because it's a judgment
call on where the seam goes.

---

## 5. Class layout

```
src/sink/
  sink.mts            factory + SinkAdapter re-export + module singleton
  sqlSink.mts         abstract SqlSink implements SinkAdapter (shared orchestration)
  mssqlSink.mts       extends SqlSink   (dumpDataMssql / dumpDataMssqlJson / N-prefix)
  mysqlSink.mts       extends SqlSink   (dumpDataMysql / dumpDataMysqlJson / backslash escape / ø→NULL)
  postgresSink.mts    extends SqlSink   (dumpDataPostges / ø placeholder / COPY)
  bigquerySink.mts    implements SinkAdapter (file output + uploadGoogleBigQuery)
  csvSink.mts         implements SinkAdapter (convertCSV / csvToJsonArray file output)
  jsonSink.mts        implements SinkAdapter (csvToJsonArray → JSON file output)
```

`SqlSink` owns the parts of today's `_database` that are dialect-agnostic
(connection pool lifecycle, `bulkLoad`'s INSERT-batching loop bounded by
`maxQuerySize`, `truncateTables`, `executeNonQuery`/`executeScalar` dispatch,
`listTables`, `ensureSchema`) and declares abstract hooks for the parts that differ:

| abstract hook | mssql | mysql | postgres |
|---|---|---|---|
| `maxQuerySize` | 65535 | 4194303 | 16777215 |
| INSERT text escaping | `N`-prefix on Unicode | `\\` backslash escape | — |
| file rewrite for `loadmethod=file` | strip `ñ` | `ñ`→`ø`→`NULL`, dbl-quote | `ñ`→`ø`→empty, BOM |
| native bulk load | `execBulkLoad` | `LOAD DATA LOCAL INFILE` | `COPY ... FROM STDIN` |
| typed-row load | `dumpDataMssqlJson` | `dumpDataMysqlJson` | `jsonToCsv`→`COPY` |
| DDL dialect fixups | none | `nvarchar→varchar` | `nvarchar→varchar`, `tinyint→smallint` |
| int cast in SQL | `int` | `unsigned int` | `int` |
| UPDATE…JOIN syntax | `update t set … from … join` | `update t join … set` | `update t set … from … where` |

Every one of these is a **verbatim move** of an existing branch — no logic changes.
This is the bulk of the mechanical work and where byte-identical risk concentrates
(see §8).

### Factory
```ts
export function createSink(config: connectionConfig): SinkAdapter {
    switch (config.technology.toLowerCase()) {
        case 'mssql':    return new MssqlSink(config);
        case 'mysql':    return new MysqlSink(config);
        case 'postgres': return new PostgresSink(config);
        case 'bigquery': return new BigQuerySink(config);
        case 'csv':      return new CsvSink(config);
        case 'json':     return new JsonSink(config);
        default: throw new Error(`Unsupported sink technology: ${config.technology}`);
    }
}
```

### Wiring / singleton
Today `database` is a module singleton constructed at import, then mutated by
`updateCommandlineConfig()`. To preserve that shape with least churn:
- `sink.mts` exports `initSink(config): SinkAdapter` (calls the factory, stores the
  result) and `getSink(): SinkAdapter`.
- `index.mts`: build config (still via `connectionConfig` construction +
  commandline overrides), then `const sink = initSink(config)`. The
  even-arg-count command-line parsing bug (§7) is untouched — flagged only.
- `tally.mts`: replace `import { database }` with `import { getSink }` and call
  `getSink()` at the top of `importData()`. All `database.config.technology` reads
  become `sink.capabilities.*` checks; all `database.<method>` become guarded
  `sink.<method>` calls.
- `server.mts` is unaffected (it forks `index.mjs` with command-line args and never
  imports `database`).
- `database.mts` is deleted once all callers move; its code is redistributed into
  `src/sink/*`. (Alternatively keep it one release as a thin re-export shim — your
  call.)

The `connectionConfig` construction + `updateCommandlineConfig` logic (default
ports, `maxQuerySize`, BigQuery credential file) moves onto the sinks / factory
unchanged.

---

## 6. The one real design decision: dialect SQL inside incremental sync

`importData()`'s incremental branch contains dialect-specific SQL **strings** (not
just capability gates): the `unsigned int` vs `int` cast, and three `UPDATE…JOIN`
shapes. The task says technology checks "should become capability checks on the
sink, not string matching." These particular ones are **SQL-dialect** decisions, not
sink-selection decisions, so they can't become simple capability booleans. Two ways
to handle them:

- **Option A (recommended): move each dialect operation onto `SqlSink` as a method.**
  `tally.mts` calls `sink.cascadeUpdate(targetTable, field, sourceTable)`,
  `sink.updateVoucherNumbers()`, `sink.maxConfigAlterIdQuery(name)`. `tally.mts`
  then holds **zero** SQL dialect strings. Cleanest end state; larger diff;
  each method is a verbatim move of the existing per-dialect branch.

- **Option B (smaller diff): expose a typed `sink.dialect: 'mssql'|'mysql'|'postgres'`**
  and keep the `switch (sink.dialect)` blocks inside `tally.mts`. Removes the
  regex string-matching smell but leaves SQL in `tally.mts`. Faster to land,
  less faithful to the "talk only to the interface" goal.

I recommend **A**, but it noticeably enlarges this step. If you'd rather keep step 1
tight, **B** unblocks the sink extraction and A can be a follow-up. Tell me which.

---

## 7. Known bugs — flagged, NOT fixed (per your instruction)

Preserved exactly as-is; the refactor moves the surrounding code without touching
these lines' behavior:

1. **`tally.mts` ~L322** `this.lstTableTransactionYaml.filter(p => p.name = 'trn_voucher')[0]`
   — assignment (`=`) not comparison. Mutates every transaction table's `name` to
   `'trn_voucher'` as a side effect of the filter, and the filter therefore returns
   all tables (truthy) rather than selecting one. Incremental + auto-numbering path
   only. **Left intact.**
2. **`tally.mts` ~L642** `this.lastAlterIdTransaction - 1;` — dead expression, missing
   `=`. Intended `this.lastAlterIdTransaction = -1;`. On the closed-company branch
   `lastAlterIdTransaction` keeps its prior value. **Left intact.**
3. **`index.mts` `parseCommandlineOptions()`** — `lstArgs.length % 2 == 0` guard means
   an odd number of overrides silently drops **all** of them. `server.mts` always
   emits pairs so the GUI path is unaffected; hand-run `run.bat` with an odd arg
   count is the exposure. **Left intact.**

I'll address these in a separate pass on your say-so.

---

## 8. Load-bearing details — preserved, with where they live after the refactor

- **UTF-16LE Tally transport** (`Buffer.byteLength(msg,'utf16le')`,
  `setEncoding('utf16le')`) is entirely in `tally.mts` / `server.mts` and is **not
  touched** — the sink layer never speaks to Tally.
- **The `ñ` (char 241) NULL-date sentinel.** This is intrinsic to the **untyped TSV
  fast path**: the `.data` file is plain text, so a NULL date needs an in-band marker
  that survives the file round-trip and is decoded per-dialect in `bulkLoad`
  (mssql strips it; mysql `ñ`→`ø`→`NULL`; postgres `ñ`→`ø`→empty). It is emitted by
  the TDL expression in `generateXMLfromYAML()` and consumed only inside
  `loadTableFromFile` (+ `convertCSV`/`csvToJsonArray` for the file-output sinks).
  **Does the new interface make it unnecessary?** For the **typed-row contract
  (`loadTable`) — yes**: a null date is simply `null`, no sentinel exists, which is
  already how the JSON path works today (`csvToJsonArray` maps `'ñ'`→`null`; the
  in-memory path never creates a `ñ`). But the sentinel **cannot be removed** for the
  YAML/TSV fast path without changing that path's byte output. So: it stays exactly
  as-is inside `loadTableFromFile` and the file-output sinks; the typed contract
  never introduces it. A future Salesforce sink (typed rows only) never encounters
  it. Recording this per your instruction rather than removing anything.
- **Regex XML parsing** in `processTdlOutputManipulation()` (depends on Tally emitting
  fields in declaration order) stays in `tally.mts`, untouched. Not swapping in an
  XML parser.
- **Sign-flip logic** for `amount` (`$$IsDebit`) and `quantity` (`$$IsInwards`) lives
  in `generateXMLfromYAML()` (TDL expressions) and `parseXmlToJsonCollection()`
  (`isdeemedpositive` → negate quantity). Both are in `tally.mts`, upstream of the
  sink. **Untouched.**
- **Voucher date-range batching** (`generateVoucherDatewiseCount`, the `batchsize`
  splitting in `importData`) stays in `tally.mts`. **Untouched** — it's a
  Tally-hang workaround, not a load concern.

---

## 9. How `importData()` reads after the refactor (illustrative)

Before:
```ts
if (/^(mssql|mysql|postgres)$/g.test(database.config.technology)) {
    await database.truncateTables(lstTables);
}
```
After:
```ts
if (sink.capabilities.truncate) {
    await sink.truncateTables!(lstTables);
}
```

Before (the load dispatch, lines 559–619) collapses to:
```ts
if (sink.capabilities.fileLoad && this.isDefinitionYAML) {
    // YAML + SQL: fast path, byte-identical to today's bulkLoad(file)
    for (const t of lstTables) rowCount = await sink.loadTableFromFile!(table, `${t}.data`, fieldTypes);
} else if (sink.capabilities.sql /* + !isDefinitionYAML */) {
    // JSON + SQL: typed rows
    for (const t of tables) rowCount = await sink.loadTable({ table, rows });
} else if (sink.capabilities.fileOutput) {
    // csv/json/bigquery: writeTableFile (+ upload happens inside bigquerySink)
    ...
}
```
The three top-level shapes (YAML+SQL, JSON+SQL, file-output) are preserved exactly;
only the selector changes from technology strings to capabilities.

---

## 10. Byte-identical guarantee — how I'll verify

The success criterion is byte-identical DB state via both `run.bat` and
`run-gui.bat`, incremental unchanged, CSV/JSON output unchanged. Because every sink
method body is a verbatim move, the risk is transcription, not design. Verification
plan (after implementation, before you merge):
1. Capture baseline: full sync to each of mssql/mysql/postgres on a fixed Tally
   company + fixed date range; dump each table ordered by PK to text.
2. Same for `csv` and `json` output (compare files); `bigquery` if you have creds.
3. Repeat post-refactor; `diff` must be empty.
4. Incremental: run full, mutate a voucher in Tally, run incremental; compare.
5. Both `loadmethod=insert` and `loadmethod=file` for the SQL sinks (they take
   different branches inside `bulkLoad`).

`tsc` with the existing `tsconfig` must pass; no new runtime deps (constraint).

---

## 11. Open questions for you

1. **§6 — Option A (extract dialect SQL to `SqlSink` methods) vs Option B (typed
   `sink.dialect` enum, keep SQL in `tally.mts`)?** This is the main scope lever.
2. **§4 — company-info seam:** route the write through the sink (recommended) or
   leave `saveCompanyInfo()`'s target-writing branches in `tally.mts` for now?
3. **§5 — delete `database.mts` outright, or keep a one-release re-export shim?**
4. **§2.1 — keep the two datatype vocabularies separate (recommended) or unify now?**

I'll implement once you've answered these; nothing in `src/` changes before then.
