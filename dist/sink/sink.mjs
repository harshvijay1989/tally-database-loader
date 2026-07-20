import fs from 'node:fs';
import { logger } from '../logger.mjs';
import { MssqlSink } from './mssqlSink.mjs';
import { MysqlSink } from './mysqlSink.mjs';
import { PostgresSink } from './postgresSink.mjs';
import { CsvSink } from './csvSink.mjs';
import { JsonSink } from './jsonSink.mjs';
import { BigQuerySink } from './bigquerySink.mjs';
// Sink factory + module singleton. Replaces the former `database` singleton.
// index.mts builds the config (with command-line overrides applied) and calls
// initSink(); tally.mts reads the active sink via getSink().
export function loadDatabaseConfig() {
    try {
        return JSON.parse(fs.readFileSync('./config.json', 'utf8'))['database'];
    }
    catch (err) {
        logger.logError('sink.loadDatabaseConfig()', err);
        throw err;
    }
}
// Apply command-line overrides + normalisation to the database config. This is the
// former database.updateCommandlineConfig(), minus the per-sink concerns
// (maxQuerySize / BigQuery client) which now live on the sinks themselves.
export function applyCommandlineConfig(config, lstConfigs) {
    try {
        if (lstConfigs.has('database-technology'))
            config.technology = lstConfigs.get('database-technology') || '';
        if (lstConfigs.has('database-server'))
            config.server = lstConfigs.get('database-server') || '';
        if (lstConfigs.has('database-port'))
            config.port = parseInt(lstConfigs.get('database-port') || '0');
        if (lstConfigs.has('database-schema'))
            config.schema = lstConfigs.get('database-schema') || '';
        if (lstConfigs.has('database-username'))
            config.username = lstConfigs.get('database-username') || '';
        if (lstConfigs.has('database-password'))
            config.password = lstConfigs.get('database-password') || '';
        if (lstConfigs.has('database-loadmethod'))
            config.loadmethod = lstConfigs.get('database-loadmethod') || 'insert';
        if (lstConfigs.has('database-ssl'))
            config.ssl = lstConfigs.get('database-ssl') == 'true';
        config.technology = config.technology.toLowerCase(); //convert technology to lowercase
        //port = 0 [load default port for]
        if (config.port == 0) {
            if (config.technology == 'mssql')
                config.port = 1433;
            else if (config.technology == 'mysql')
                config.port = 3306;
            else if (config.technology == 'postgres')
                config.port = 5432;
            else
                ;
        }
    }
    catch (err) {
        logger.logError('sink.applyCommandlineConfig()', err);
        throw err;
    }
}
export function createSink(config) {
    switch (config.technology.toLowerCase()) {
        case 'mssql': return new MssqlSink(config);
        case 'mysql': return new MysqlSink(config);
        case 'postgres': return new PostgresSink(config);
        case 'bigquery': return new BigQuerySink(config);
        case 'csv': return new CsvSink(config);
        case 'json': return new JsonSink(config);
        default: throw new Error(`Unsupported sink technology: ${config.technology}`);
    }
}
let activeSink = undefined;
export function initSink(config) {
    activeSink = createSink(config);
    return activeSink;
}
export function getSink() {
    if (!activeSink) {
        throw new Error('Sink not initialised. Call initSink() first.');
    }
    return activeSink;
}
//# sourceMappingURL=sink.mjs.map