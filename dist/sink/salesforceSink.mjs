import fs from 'node:fs';
import { logger } from '../logger.mjs';
// Salesforce sink (pillar 2). Authenticates via Connected App OAuth 2.0 Client
// Credentials flow, then upserts typed rows into a Salesforce object keyed on an
// External ID field using the Composite sObject Collections API (batches of 200,
// synchronous, per-record results). Uses Node's built-in fetch — no new dependency.
//
// The generic sinkAdapter load methods require a source->target mapping (pillar 3),
// which is not wired yet, so they throw. The real entry point today is upsertObject(),
// exercised by the smoke test and, later, by the mapping engine.
export class SalesforceSink {
    config;
    creds;
    accessToken = '';
    apiBaseUrl = ''; // instance_url returned by the token endpoint
    constructor(config) {
        this.config = config;
    }
    get capabilities() {
        return {
            sql: false,
            incrementalSync: false,
            fileOutput: false,
            upload: false,
            persistsCompanyInfo: false
        };
    }
    async open() {
        try {
            this.creds = JSON.parse(fs.readFileSync('./salesforce-credentials.json', 'utf8'));
            await this.authenticate();
        }
        catch (err) {
            logger.logError('SalesforceSink.open()', err);
            throw err;
        }
    }
    async close() {
        this.accessToken = '';
    }
    async authenticate() {
        let c = this.creds;
        let body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: c.clientId,
            client_secret: c.clientSecret
        });
        let resp = await fetch(`${c.instanceUrl}/services/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        let data = await resp.json();
        if (!resp.ok || !data.access_token) {
            throw new Error(`Salesforce authentication failed: ${data.error || resp.status} - ${data.error_description || ''}`);
        }
        this.accessToken = data.access_token;
        this.apiBaseUrl = data.instance_url || c.instanceUrl;
    }
    get apiVersion() {
        return this.creds?.apiVersion || 'v62.0';
    }
    /**
     * Upsert rows into a Salesforce object, matching on an External ID field.
     * Rows are plain objects keyed by Salesforce field API name; the external id
     * field must be present on each row.
     */
    async upsertObject(objectApiName, externalIdField, rows) {
        let retval = { total: rows.length, success: 0, failed: 0, errors: [] };
        try {
            // Composite sObject Collections upsert allows max 200 records per call
            for (let i = 0; i < rows.length; i += 200) {
                let batch = rows.slice(i, i + 200);
                let payload = {
                    allOrNone: false,
                    records: batch.map(r => ({ attributes: { type: objectApiName }, ...r }))
                };
                let resp = await fetch(`${this.apiBaseUrl}/services/data/${this.apiVersion}/composite/sobjects/${objectApiName}/${externalIdField}`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                let results = await resp.json();
                if (!resp.ok) {
                    throw new Error(`Salesforce upsert HTTP ${resp.status}: ${JSON.stringify(results)}`);
                }
                for (const res of results) {
                    if (res.success) {
                        retval.success++;
                    }
                    else {
                        retval.failed++;
                        if (retval.errors.length < 20) {
                            let msg = Array.isArray(res.errors) ? res.errors.map((e) => `${e.statusCode}: ${e.message}`).join('; ') : 'unknown error';
                            retval.errors.push(msg);
                        }
                    }
                }
            }
        }
        catch (err) {
            logger.logError(`SalesforceSink.upsertObject(${objectApiName})`, err);
            throw err;
        }
        return retval;
    }
    /** Run a SOQL query (used for verification / discovery). */
    async query(soql) {
        let resp = await fetch(`${this.apiBaseUrl}/services/data/${this.apiVersion}/query?q=${encodeURIComponent(soql)}`, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        let data = await resp.json();
        if (!resp.ok) {
            throw new Error(`Salesforce query HTTP ${resp.status}: ${JSON.stringify(data)}`);
        }
        return data.records || [];
    }
    // --- generic sinkAdapter members: require the mapping layer (pillar 3), not yet wired ---
    async listTables() {
        throw new Error('listTables is not supported by SalesforceSink');
    }
    async ensureSchema(syncMode) {
        throw new Error('ensureSchema is not supported by SalesforceSink');
    }
    async executeNonQuery(sqlQuery, values) {
        throw new Error('executeNonQuery is not supported by SalesforceSink');
    }
    async executeScalar(sqlQuery) {
        throw new Error('executeScalar is not supported by SalesforceSink');
    }
    async truncateTables(lstTables) {
        throw new Error('truncateTables is not supported by SalesforceSink');
    }
    async uploadTable(targetTable) {
        throw new Error('uploadTable is not supported by SalesforceSink');
    }
    async loadFromFile(targetTable, filePath, lstFieldType) {
        throw new Error('SalesforceSink requires a source->target mapping (pillar 3); use upsertObject()');
    }
    async loadFromRows(targetTable, lstTableData) {
        throw new Error('SalesforceSink requires a source->target mapping (pillar 3); use upsertObject()');
    }
}
//# sourceMappingURL=salesforceSink.mjs.map