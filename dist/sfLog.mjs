import { sfInsert } from './sfClient.mjs';
// Logging to Morde's SHARED application log: Trigger_Log__c (the same object their
// IntegrationLogger writes to). We reuse their field shape so Tally sync entries sit
// alongside SAP integration entries in one place — do NOT introduce a custom log object.
//
// Field reference (Trigger_Log__c): Integration_Name__c, Operation__c, Object_Name__c,
// Class_Name__c, Method_Name__c, Log_Level__c, Status__c, Status_Code__c, Error_Message__c,
// Stack_Trace__c, Request_Body__c, Response_Body__c, Request_Endpoint__c, HTTP_Method__c,
// Related_Record_Id__c, Retry_Count__c, Started_At__c, Completed_At__c, Duration_MS__c.
export const INTEGRATION_NAME = 'Tally Connector';
const cap = (s, n) => (s == null ? undefined : String(s).slice(0, n));
/** Write one Trigger_Log__c row. Never throws — logging must not break a sync run. */
export async function logToTrigger(e) {
    const started = e.startedAt || new Date();
    const completed = e.completedAt || new Date();
    const rec = {
        Integration_Name__c: INTEGRATION_NAME,
        Operation__c: cap(e.operation, 255),
        Object_Name__c: cap(e.objectName, 255),
        Class_Name__c: 'sfAgent',
        Log_Level__c: e.level || (e.status === 'Error' ? 'ERROR' : e.status === 'Partial' ? 'WARN' : 'INFO'),
        Status__c: e.status,
        Status_Code__c: e.statusCode,
        Error_Message__c: cap(e.errorMessage, 32000),
        Stack_Trace__c: cap(e.stackTrace, 32000),
        Request_Body__c: cap(e.requestBody, 32000),
        Response_Body__c: cap(e.responseBody, 32000),
        Related_Record_Id__c: cap(e.relatedRecordId, 18),
        Retry_Count__c: e.retryCount,
        Started_At__c: started.toISOString(),
        Completed_At__c: completed.toISOString(),
        Duration_MS__c: Math.max(0, completed.getTime() - started.getTime()),
    };
    for (const k of Object.keys(rec))
        if (rec[k] === undefined)
            delete rec[k];
    try {
        await sfInsert('Trigger_Log__c', [rec]);
    }
    catch { /* logging is best-effort */ }
}
//# sourceMappingURL=sfLog.mjs.map