import { connectionConfig, tableConfigJSON, sinkAdapter, sinkCapabilities } from '../definition.mjs';
import { jsonToCsv } from './rowCodec.mjs';

// Abstract base for file-output sinks (csv / json / bigquery). Terminal output is a
// file on disk; SQL-oriented members are not supported and are never called (callers
// guard on capabilities). This encapsulates the file-writing orchestration that used
// to live inline in tally.mts. See docs/architecture-sink.md.
export abstract class FileSink implements sinkAdapter {

    config: connectionConfig;

    constructor(config: connectionConfig) {
        this.config = config;
    }

    abstract get capabilities(): sinkCapabilities;

    async open(): Promise<void> { }
    async close(): Promise<void> { }

    // --- SQL-oriented members: unsupported for file sinks (never called) ---
    async listTables(): Promise<string[]> {
        throw new Error('listTables is not supported by file sinks');
    }
    async ensureSchema(syncMode: string): Promise<void> {
        throw new Error('ensureSchema is not supported by file sinks');
    }
    async executeNonQuery(sqlQuery: string | string[], values?: Map<string, any>): Promise<number> {
        throw new Error('executeNonQuery is not supported by file sinks');
    }
    async executeScalar<T>(sqlQuery: string): Promise<T> {
        throw new Error('executeScalar is not supported by file sinks');
    }
    async truncateTables(lstTables: string[]): Promise<void> {
        throw new Error('truncateTables is not supported by file sinks');
    }
    async uploadTable(targetTable: string): Promise<number> {
        throw new Error('uploadTable is not supported by this sink');
    }

    // Consume a .data TSV file → produce the sink's output file. Subclass-specific.
    abstract loadFromFile(targetTable: string, filePath: string, lstFieldType: string[]): Promise<number>;

    // JSON/collection path: dump typed rows to a CSV file (identical to the previous
    // behaviour for all file technologies, including json → .csv).
    async loadFromRows(targetTable: tableConfigJSON, lstTableData: any[]): Promise<number> {
        await jsonToCsv(`./csv/${targetTable.name}.csv`, targetTable, lstTableData, true); //save CSV file
        return 0;
    }
}
