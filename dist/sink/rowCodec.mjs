import fs from 'node:fs';
import { logger } from '../logger.mjs';
// Shared TSV <-> row format helpers. Moved verbatim out of the former
// database.mts; used by both the SQL sinks and the file-output sinks. The `ñ`
// (char 241) NULL-date sentinel is intrinsic to the untyped TSV fast path and is
// handled here / in the SQL sinks exactly as before. See docs/architecture-sink.md.
export function convertCSV(content, lstFieldType, doubleQuote = false) {
    let lstLines = content.split(/\r\n/g);
    for (let r = 0; r < lstLines.length; r++) {
        let line = lstLines[r];
        line = line.replace(/ñ/g, ''); //replace blank date with empty text
        line = line.replace(/\"/g, '""'); //escape double quotes with 2 instance of double quotes (as per ISO)
        let lstValues = line.split('\t');
        for (let c = 0; c < lstValues.length; c++) {
            let targetFieldType = lstFieldType[c];
            let targetFieldValue = lstValues[c];
            if (doubleQuote)
                lstValues[c] = `"${targetFieldValue}"`;
            else if (targetFieldType == 'text' || targetFieldType == 'date')
                lstValues[c] = `"${targetFieldValue}"`;
        }
        lstLines[r] = lstValues.join(',');
    }
    return lstLines.join('\r\n');
}
export function csvToJsonArray(content, targetTable, lstFieldType) {
    let retval = [];
    try {
        let lstLines = content.split(/\r\n/g);
        let fieldList = lstLines.shift() || ''; //extract header
        let lstFields = fieldList.split(/\t/g);
        for (const line of lstLines) {
            if (line == '')
                continue;
            let objRow = {};
            let lstValues = line.split(/\t/g);
            for (let f = 0; f < lstFields.length; f++) {
                const fieldName = lstFields[f];
                const fieldType = lstFieldType[f];
                let fieldRawValue = lstValues[f];
                let fieldValue = undefined;
                if (fieldRawValue == 'ñ') { //NULL
                    fieldValue = null;
                }
                else if (fieldType == 'text') { //Text
                    fieldValue = fieldRawValue;
                }
                else if (fieldType == 'number' || fieldType == 'logical' || fieldType == 'amount' || fieldType == 'quantity' || fieldType == 'rate') { //Numeric
                    fieldValue = parseFloat(fieldRawValue);
                    if (isNaN(fieldValue)) {
                        fieldValue = null;
                    }
                }
                else if (fieldType == 'date') {
                    fieldValue = fieldRawValue == '' ? null : new Date(fieldRawValue);
                }
                Object.defineProperty(objRow, fieldName.trim(), { enumerable: true, value: fieldValue });
            }
            retval.push(objRow);
        }
    }
    catch (err) {
        logger.logError('rowCodec.csvToJsonArray()', err);
    }
    return retval;
}
export function jsonToCsv(filePath, tableConfig, lstTableData, emitBOM = false) {
    return new Promise((resolve, reject) => {
        try {
            let writeStream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
            writeStream.on('error', (err) => {
                reject(err);
            });
            writeStream.on('finish', () => {
                resolve();
            });
            if (emitBOM) {
                writeStream.write('﻿'); //write BOM for UTF-8
            }
            //write header
            let headerLine = tableConfig.fields.map(p => p.name).join(',');
            writeStream.write(headerLine);
            //write data rows
            for (const row of lstTableData) {
                let rowLine = '\n';
                let lstRowValues = [];
                for (const targetField of tableConfig.fields) {
                    let fieldValue = row[targetField.name];
                    if (fieldValue === null || fieldValue === undefined) {
                        lstRowValues.push('');
                    }
                    else if (typeof fieldValue === 'string') {
                        if (fieldValue.includes('\n') || fieldValue.includes('\r') || fieldValue.includes('\t')) { //strip off new line, carriage return, tab characters
                            fieldValue = fieldValue.replace(/\r/g, '').replace(/\n/g, ' ').replace(/\t/g, ' ');
                        }
                        if (fieldValue.includes('"')) {
                            fieldValue = fieldValue.replace(/"/g, '""'); //escape double quotes with 2 instance of double quotes (as per ISO)
                        }
                        lstRowValues.push(`"${fieldValue}"`);
                    }
                    else if (typeof fieldValue === 'number') {
                        lstRowValues.push(fieldValue.toString());
                    }
                    else if (typeof fieldValue === 'boolean') {
                        lstRowValues.push(fieldValue ? '1' : '0');
                    }
                    else if (fieldValue instanceof Date) {
                        let v = fieldValue.toISOString().split('T')[0];
                        lstRowValues.push(`"${v}"`);
                    }
                }
                rowLine += lstRowValues.join(',');
                writeStream.write(rowLine);
            }
            writeStream.end();
        }
        catch (err) {
            logger.logError(`rowCodec.jsonToCsv(${tableConfig.name})`, err);
            reject(err);
        }
    });
}
//# sourceMappingURL=rowCodec.mjs.map