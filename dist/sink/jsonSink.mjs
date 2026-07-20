import fs from 'node:fs';
import { FileSink } from './fileSink.mjs';
import { csvToJsonArray } from './rowCodec.mjs';
// JSON file-output sink. Converts the .data TSV into a JSON array file.
export class JsonSink extends FileSink {
    get capabilities() {
        return {
            sql: false,
            incrementalSync: false,
            fileOutput: true,
            upload: false,
            persistsCompanyInfo: false
        };
    }
    async loadFromFile(targetTable, filePath, lstFieldType) {
        let content = fs.readFileSync(filePath, 'utf-8');
        content = JSON.stringify(csvToJsonArray(content, targetTable, lstFieldType));
        fs.writeFileSync(`./csv/${targetTable}.json`, '﻿' + content);
        fs.unlinkSync(filePath); //delete raw file
        return 0;
    }
}
//# sourceMappingURL=jsonSink.mjs.map