# Platform architecture — north star

Status: **agreed direction (scope option A)**. This is the top-level design every
phase refers back to. The sink refactor in [`architecture-sink.md`](./architecture-sink.md)
is **pillar 1** of this document.

## What we are building

A small, iPaaS-style integration tool ("mini MuleSoft/Informatica") that runs
locally on the Tally machine. It:

- reads data out of a **source** (Tally today),
- reshapes it according to a **mapping the user defines in a UI**, and
- writes it to a **target** (Salesforce today).

The defining rule: **no domain logic lives in code.** There is no `voucher` or
`Opportunity` anywhere in the engine. Objects, fields, relationships, transforms and
keys are all *discovered metadata* and *user-authored configuration*. "Tally sales
voucher → SF Account + Opportunity + line items" is simply the first **mapping a user
builds in the designer**, not a hardcoded path.

### Scope (option A)

- **Generic bones**: four contracts below, built to be connector-agnostic.
- **Two real connectors wired up**: Tally (source), Salesforce (target). A third
  connector later = implement an interface, not a rewrite.
- **One mapping designer** UI: two-sided, discovery-driven, with transforms.
- **Deferred** (not now): connector registry / dynamic plugin loading, a general
  transform expression language, Product2/Pricebook sync, deep object-graph mapping
  beyond parent→child, cloud/distributed execution, multi-tenant.

## The four contracts

Everything reduces to four seams. Get these right and the rest is detail.

```
   SourceConnector  ──►  Engine  ──►  SinkAdapter
        ▲                  ▲               ▲
        └──── MappingDocument (user config, JSON) ────┘
```

1. **`SourceConnector`** — discover source metadata; emit typed records. (Tally)
2. **`SinkAdapter`** — discover target metadata; accept typed records; upsert.
   (Salesforce) — *defined in pillar 1.*
3. **`MappingDocument`** — the user-authored artifact tying source→target.
4. **`Engine`** — generic runner: pull → transform → push, in dependency order.

---

### 1. `SourceConnector`

Mirror image of the sink. Wraps today's `tally.mts` extraction behind an interface so
the engine never talks to Tally directly.

```ts
export interface SourceObjectMeta {
    name: string;                 // e.g. "voucher", "ledger"  (Tally collection)
    label: string;                // human label for the UI
    fields: SourceFieldMeta[];
    children?: SourceObjectMeta[];// hierarchy: voucher → inventoryentries, etc.
}

export interface SourceFieldMeta {
    name: string;                 // path relative to its object level
    datatype: SinkDataType;       // reuse the normalized vocabulary from pillar 1
    label: string;
}

export interface SourceRecordSet {
    object: string;               // which SourceObjectMeta this satisfies
    records: Record<string, any>[]; // typed rows; children nested as arrays
}

export interface SourceConnector {
    readonly capabilities: {
        discover: boolean;        // can enumerate objects/fields (for the UI)
        incremental: boolean;     // can emit only-changed since a watermark
        hierarchical: boolean;    // emits nested child records (Tally: yes)
    };

    open(config: SourceConnectionConfig): Promise<void>;
    close(): Promise<void>;

    /** For the mapping designer's left-hand pane. */
    discover(): Promise<SourceObjectMeta[]>;

    /** Pull records for one source object (with its nested children). */
    fetch(object: string, opts?: FetchOptions): Promise<SourceRecordSet>;
}
```

`TallySource` implements this by reusing, unchanged: `postTallyXML`,
`generateXMLfromYAML` / `generateCollectionRequestXMLPayload`,
`parseXmlToJsonCollection`, the sign-flip TDL expressions, and voucher date-range
batching. `discover()` is backed by the export-config for v1 (real TDL introspection
is a later enhancement). The UTF-16LE transport stays entirely inside this connector.

The current `tableConfigJSON` + `collectionPaths` machinery already produces nested
typed records — that is the `SourceRecordSet` shape, so this is a wrapping job, not a
rewrite.

---

### 2. `SinkAdapter`

Defined in **pillar 1** (`architecture-sink.md`). Two additions the platform needs on
top of the loader-focused version there:

```ts
export interface SinkAdapter {
    // ... everything in pillar 1 ...

    /** For the mapping designer's right-hand pane. Salesforce → Describe API. */
    discover(): Promise<SinkObjectMeta[]>;

    /** Upsert typed rows keyed by an external id, resolving parent refs by key. */
    upsert(batch: RowBatch, opts: UpsertOptions): Promise<UpsertResult>;
}

export interface UpsertOptions {
    externalIdField: string;             // target field holding the source key
    parentRefs?: {                       // relationship wiring, resolved by external id
        targetField: string;             // e.g. "AccountId" / "Opportunity__c"
        parentObject: string;            // the object-mapping id it points at
        parentExternalIdField: string;   // parent's external id field
    }[];
}
```

`upsert` (not plain insert) is what makes re-triggering safe: Salesforce upsert-by-
external-id turns re-runs into updates and lets children reference parents by the
source key **without** a prior round-trip. `SqlSink`s satisfy `upsert` via
insert/merge; the SQL loader path from pillar 1 is unchanged.

---

### 3. `MappingDocument` — the heart

The user-authored artifact. Evolves `tally-export-config.json` (which already has
objects, fields, `collectionPaths`, and `transform`). One document per integration;
users create and save many.

```ts
export interface MappingDocument {
    id: string;
    name: string;                        // "Tally Sales → Salesforce"
    source: { connector: 'tally';   connectionId: string };
    target: { connector: 'salesforce'; connectionId: string };
    objectMappings: ObjectMapping[];     // ordered by dependency (parents first)
}

export interface ObjectMapping {
    id: string;                          // referenced by children as parentObject
    sourceObject: string;                // e.g. "voucher"
    sourcePath?: string;                 // hierarchy level, e.g. "voucher.inventoryentries"
    targetObject: string;                // e.g. "Account" | "Opportunity" | "Opportunity_Item__c"
    externalIdField: string;             // target field that carries the source key
    keySource: string;                   // source field feeding the external id (Tally GUID)
    filter?: MappingFilter;              // e.g. only Sales vouchers
    parent?: {                           // how a child links to its parent mapping
        parentObject: string;            // ObjectMapping.id of the parent
        targetField: string;             // relationship field on the target object
    };
    fields: FieldMapping[];
}

export interface FieldMapping {
    source?: string;                     // source field path (omit if constant)
    constant?: string | number | boolean;
    target: string;                      // target field API name
    transform?: transformFieldConfig;    // reuse pillar/existing: replace | concat | lookup
}
```

**Worked example** — the same thing the user would draw in the UI, expressed as data:

```jsonc
{
  "name": "Tally Sales → Salesforce",
  "source": { "connector": "tally", "connectionId": "local" },
  "target": { "connector": "salesforce", "connectionId": "prod" },
  "objectMappings": [
    { "id": "cust", "sourceObject": "voucher", "sourcePath": "voucher.party",
      "targetObject": "Account", "externalIdField": "Tally_Guid__c", "keySource": "partyguid",
      "fields": [ { "source": "partyname", "target": "Name" } ] },

    { "id": "opp", "sourceObject": "voucher",
      "targetObject": "Opportunity", "externalIdField": "Tally_Guid__c", "keySource": "guid",
      "filter": { "field": "vouchertypename", "operator": "==", "value": "Sales" },
      "parent": { "parentObject": "cust", "targetField": "AccountId" },
      "fields": [
        { "source": "vouchernumber", "target": "Name" },
        { "source": "date",          "target": "CloseDate" },
        { "constant": "Closed Won",  "target": "StageName" },
        { "source": "amount",        "target": "Amount" }
      ] },

    { "id": "item", "sourceObject": "voucher", "sourcePath": "voucher.inventoryentries",
      "targetObject": "Opportunity_Item__c", "externalIdField": "Tally_Guid__c", "keySource": "guid",
      "parent": { "parentObject": "opp", "targetField": "Opportunity__c" },
      "fields": [
        { "source": "stockitemname", "target": "Product_Name__c" },
        { "source": "actualqty",     "target": "Quantity__c" },
        { "source": "rate",          "target": "Rate__c" },
        { "source": "amount",        "target": "Amount__c" }
      ] }
  ]
}
```

Nothing here is in code — it is entirely produced by the designer. Swapping "Sales" for
"Sales Order", or Account for a custom object, is a UI edit.

---

### 4. `Engine`

The generic runner. Replaces the technology-branch soup in `importData()`.

```
function run(mapping, source, sink):
    source.open(); sink.open()
    for objectMapping in topologicalOrder(mapping.objectMappings):   # parents first
        recordSet = source.fetch(objectMapping.sourceObject, ...)
        rows = []
        for record in flatten(recordSet, objectMapping.sourcePath):  # descend to the level
            if objectMapping.filter and not matches(record, filter): continue
            row = {}
            for fm in objectMapping.fields:
                value = fm.constant ?? read(record, fm.source)
                row[fm.target] = applyTransform(value, fm.transform)
            row[objectMapping.externalIdField] = read(record, objectMapping.keySource)
            rows.push(row)
        sink.upsert({ table: targetOf(objectMapping), rows },
                    { externalIdField, parentRefs: fromParent(objectMapping) })
        report(progress)
    source.close(); sink.close()
```

Properties it must have (iPaaS table stakes, prioritised):
- **Dependency ordering** — parents before children (topological sort of `parent` refs).
- **Per-record error isolation + a run report** — one bad row shouldn't abort the run;
  Salesforce Bulk API 2.0 returns per-row success/failure, surface it.
- **Progress streaming** — reuse the existing WebSocket channel in `server.mts`.
- **Idempotency** — via upsert-by-external-id (§2), not local state. No staging store
  needed for v1.

## The UI

Three screens, served by the existing local web server (`server.mts` + `gui.html`):

1. **Connections** — create/edit a source connection (Tally host/port) and a target
   connection (Salesforce). Salesforce auth is **Connected App OAuth 2.0** (locked):
   the screen runs the OAuth flow and stores tokens; secrets are encrypted at rest
   (this subsumes the earlier "credential handling" phase). Never plaintext in
   `config.json`.
2. **Mapping designer** — pick a source object and a target object; the left pane lists
   source fields (`SourceConnector.discover()`), the right pane lists target fields
   (`SinkAdapter.discover()` → SF Describe, with real API names/types/required flags);
   the user connects fields, sets transforms, designates the external-id/key, and links
   children to parents. Saves a `MappingDocument`. One tab per `ObjectMapping`.
3. **Run / monitor** — trigger a mapping (manual now; schedule later), watch progress
   and the per-row error report over the WebSocket.

## Salesforce target — the specifics that constrain design

- **Auth**: Connected App OAuth 2.0 (locked).
- **Load**: Bulk API 2.0, `upsert` on an External ID field per object.
- **External IDs required**: each target object needs an `External_Id__c` (unique,
  external id) holding the Tally GUID — this is what makes upsert idempotent and lets
  children reference parents by key. Users create these fields in their SF org; the
  designer flags when a chosen object lacks one.
- **Ordering**: Account → Opportunity → Item, enforced by the engine's topological sort.
- **Line items — open decision (deferred, see below)**: standard `OpportunityLineItem`
  requires Product2 + PricebookEntry + a Pricebook (heavy: implies a stock-item→Product2
  mapping too). A **custom child object** (`Opportunity_Item__c` with a lookup to
  Opportunity) needs none of that. Recommendation stands: custom object for v1. The
  architecture supports either — it is just a different target object in the mapping.

## Build order

1. **Pillar 1 — SinkAdapter refactor** (in progress; see sink doc). Unblocks everything.
2. **`SalesforceSink`** implementing SinkAdapter + `discover`/`upsert`: OAuth, Describe,
   Bulk API 2.0. Prove it against the hand-written mapping JSON above — no UI yet.
3. **`SourceConnector` + `TallySource`** — wrap the existing extraction.
4. **`Engine`** — generic run loop; retire the technology branches in `importData()`.
5. **Connections UI** + encrypted secret storage (OAuth flow).
6. **Mapping designer UI** with two-sided discovery.
7. **Run/monitor UI** on the existing WebSocket.

Each step is demoable on its own; nothing after step 1 blocks on UI.

## Deferred / explicitly out

Staging store (SQLite/DuckDB), connector plugin registry, general transform expression
language, Product2/Pricebook sync, object-graph mapping deeper than parent→child,
multi-company, scheduling/continuous triggers beyond what exists, cloud execution.

## Open decisions

1. **Line items**: standard `OpportunityLineItem` (needs Products/Pricebook) vs custom
   child object (recommended). Deferred until we reach step 2 — flagged so the SF org
   fields can be prepared.
2. **`discover()` source of truth for Tally**: derive from the export-config for v1
   (fast) vs. live TDL introspection (richer, later).
3. **Where `MappingDocument`s are stored**: flat JSON files in a `mappings/` folder
   (simple, versionable — recommended) vs. a small local DB.
4. Everything still open in pillar 1 §11 (dialect-SQL Option A/B, etc.) remains, but
   now only affects the SQL sinks, which are legacy targets under this plan.
