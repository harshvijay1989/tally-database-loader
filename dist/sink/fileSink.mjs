import { jsonToCsv } from './rowCodec.mjs';
// Abstract base for file-output sinks (csv / json / bigquery). Terminal output is a
// file on disk; SQL-oriented members are not supported and are never called (callers
// guard on capabilities). This encapsulates the file-writing orchestration that used
// to live inline in tally.mts. See docs/architecture-sink.md.
export class FileSink {
    config;
    constructor(config) {
        this.config = config;
    }
    async open() { }
    async close() { }
    // --- SQL-oriented members: unsupported for file sinks (never called) ---
    async listTables() {
        throw new Error('listTables is not supported by file sinks');
    }
    async ensureSchema(syncMode) {
        throw new Error('ensureSchema is not supported by file sinks');
    }
    async executeNonQuery(sqlQuery, values) {
        throw new Error('executeNonQuery is not supported by file sinks');
    }
    async executeScalar(sqlQuery) {
        throw new Error('executeScalar is not supported by file sinks');
    }
    async truncateTables(lstTables) {
        throw new Error('truncateTables is not supported by file sinks');
    }
    async uploadTable(targetTable) {
        throw new Error('uploadTable is not supported by this sink');
    }
    // JSON/collection path: dump typed rows to a CSV file (identical to the previous
    // behaviour for all file technologies, including json → .csv).
    async loadFromRows(targetTable, lstTableData) {
        await jsonToCsv(`./csv/${targetTable.name}.csv`, targetTable, lstTableData, true); //save CSV file
        return 0;
    }
}
//# sourceMappingURL=fileSink.mjs.map