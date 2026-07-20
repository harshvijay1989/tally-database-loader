export interface connectionConfig {
    technology: string;
    server: string;
    port: number;
    schema: string;
    ssl: boolean;
    username: string;
    password: string;
    loadmethod: string;
}

export interface tallyConfig {
    definition: string;
    server: string;
    port: number;
    fromdate: string; // [ YYYYMMDD / auto ]
    todate: string; // [ YYYYMMDD / auto ]
    sync: string; // [ full / incremental ]
    batchsize: number;
    frequency: number; // in minutes
    company: string;
}

export interface queryResult {
    rowCount: number;
    data: any[];
}

export interface collectionConfigJSON {
    collection: string; // name of collection as per Tally
    fetch?: string[]; // fetch list of fields which are not loaded by default
    compute?: computeFieldConfig[]; // list of computed fields
    filters?: filterConfigJson[];
    by?: string[]; // list of fields to group by
    aggrcompute?: string[]; // list of aggregate computations (SUM, COUNT, AVG, MIN, MAX)
}

export interface filterConfigJson {
    name: string; // name of the filter
    expression?: string; // filter expression (if not pre-defined)
}

export interface computeFieldConfig {
    name: string; // name of the computed field
    expression: string; // expression to compute the field value
}

export interface tableConfigJSON {
    name: string; // table name for database / CSV mapping
    isMaster: boolean; // is master table
    collectionPaths: string[]; // list of collection / sub-collection hierarchy paths
    fields: fieldConfigJSON[]; // list of fields
    filter?: tableFilterJson;
}

export interface tableFilterJson {
    field: string;
    operator: string; // [ == != < > <= >= ]
    value: string | number | boolean;
}

export interface fieldConfigJSON {
    name: string; // name as per database
    datatype: string; // data type as per database
    source: string; // source field name as per Tally
    transform?: transformFieldConfig; // transformation config (if any)
}

export interface transformFieldConfig {
    replace?: string | transformOperationReplace;
    concat?: string;
    lookup?: transformOperationLookup;
}

export interface transformOperationReplace {
    source: string;
    target: string;
}

export interface transformOperationLookup {
    sourceField: string;
    lookupCollection: string;
    lookupField: string
    returnField: string;
}

export interface fieldConfigYAML {
    name: string;
    field: string;
    type: string;
}

export interface tableFieldYAML {
    table: string;
    field: string;
}

export interface tableConfigYAML {
    name: string;
    collection: string;
    nature: string;
    fields: fieldConfigYAML[];
    filters?: string[];
    fetch?: string[];
    subcollections?: tableConfigYAML[];
    cascade_update?: tableFieldYAML[];
    cascade_delete?: tableFieldYAML[];
}

export interface databaseFieldInfo {
    fieldName: string;
    dataType: string;
    isNullable: boolean;
    length?: number;
    precision?: number;
    scale?: number;
}

export interface tdlDefinitionItem {
    metadata: {
        name: string;
        type: string;
    },
    attributes: any[];
}

export interface tdlMessageItem {
    definitions: tdlDefinitionItem[];
}

export interface tdlStaticVariableItem {
    name: string;
    value: string;
}

export interface tdlRequestPayload {
    static_variables: tdlStaticVariableItem[];
    tdlmessage: tdlMessageItem[];
}

export interface companyInfo {
    name: string;
    booksfrom: Date;
    iscompanyactive: boolean;
    altmstid: number;
    altvchid?: number;
}

// ---------------------------------------------------------------------------
// Sink adapter layer (pillar 1 of the platform architecture)
// See docs/architecture-sink.md and docs/platform-architecture.md
// ---------------------------------------------------------------------------

/** SQL dialects that share the SqlSink implementation. */
export type sqlDialect = 'mssql' | 'mysql' | 'postgres';

/**
 * What a sink can do. Replaces the technology-string tests that used to be
 * scattered through tally.mts. Callers guard on a capability, never on a
 * technology name.
 */
export interface sinkCapabilities {
    /** executeNonQuery / executeScalar against the target (mssql,mysql,postgres). */
    sql: boolean;
    /** the incremental diff/delete/cascade orchestration is supported (mssql,mysql,postgres). */
    incrementalSync: boolean;
    /** terminal output is files on disk the caller/sink post-processes (csv,json,bigquery). */
    fileOutput: boolean;
    /** has a post-write upload step (bigquery). */
    upload: boolean;
    /** persists the company-info metadata (everything except json). */
    persistsCompanyInfo: boolean;
}

/**
 * The pluggable target. Every existing technology implements this; a future
 * Salesforce sink implements the same contract.
 *
 * Optional members are present iff the matching capability is true, so callers
 * are forced by the type system to guard before calling.
 */
export interface sinkAdapter {
    readonly config: connectionConfig;
    readonly capabilities: sinkCapabilities;
    /** present for SQL sinks; lets callers build dialect-correct SQL (Option B). */
    readonly dialect?: sqlDialect;

    // lifecycle
    open(): Promise<void>;
    close(): Promise<void>;

    // schema management (capability: sql)
    listTables(): Promise<string[]>;
    ensureSchema(syncMode: string): Promise<void>;

    // arbitrary SQL (capability: sql)
    executeNonQuery(sqlQuery: string | string[], values?: Map<string, any>): Promise<number>;
    executeScalar<T>(sqlQuery: string): Promise<T>;
    truncateTables(lstTables: string[]): Promise<void>;

    // bulk load
    /** consume a tab-delimited .data file produced by the YAML/report path. */
    loadFromFile(targetTable: string, filePath: string, lstFieldType: string[]): Promise<number>;
    /** consume typed rows produced by the JSON/collection path. */
    loadFromRows(targetTable: tableConfigJSON, lstTableData: any[]): Promise<number>;

    // post-write upload (capability: upload)
    uploadTable(targetTable: string): Promise<number>;
}