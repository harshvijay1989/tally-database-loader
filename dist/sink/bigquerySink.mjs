import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../logger.mjs';
import { CsvSink } from './csvSink.mjs';
// Google BigQuery sink. Writes the same CSV file as CsvSink, then loads it into a
// BigQuery table. Verbatim relocation of uploadGoogleBigQuery from database.mts.
export class BigQuerySink extends CsvSink {
    bigquery;
    constructor(config) {
        super(config);
        this.bigquery = new BigQuery({ keyFilename: './bigquery-credentials.json' });
    }
    get capabilities() {
        return {
            sql: false,
            incrementalSync: false,
            fileOutput: true,
            upload: true,
            persistsCompanyInfo: true
        };
    }
    async loadFromFile(targetTable, filePath, lstFieldType) {
        await super.loadFromFile(targetTable, filePath, lstFieldType); //produce the CSV file
        return this.uploadTable(targetTable);
    }
    async loadFromRows(targetTable, lstTableData) {
        await super.loadFromRows(targetTable, lstTableData); //produce the CSV file
        return this.uploadTable(targetTable.name);
    }
    uploadTable(targetTable) {
        return new Promise(async (resolve, reject) => {
            try {
                const [job] = await this.bigquery.dataset(this.config.schema).table(targetTable).load(`./csv/${targetTable}.csv`, {
                    sourceFormat: 'CSV',
                    skipLeadingRows: 1,
                    writeDisposition: 'WRITE_TRUNCATE'
                });
                let retval = parseInt(job.statistics?.load?.outputRows || '0');
                resolve(retval);
            }
            catch (err) {
                reject(err);
                logger.logError('BigQuerySink.uploadTable()', err);
            }
        });
    }
}
//# sourceMappingURL=bigquerySink.mjs.map