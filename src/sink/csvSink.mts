import fs from 'node:fs';
import { sinkCapabilities } from '../definition.mjs';
import { FileSink } from './fileSink.mjs';
import { convertCSV } from './rowCodec.mjs';

// CSV file-output sink. Converts the .data TSV into a comma-delimited CSV file.
export class CsvSink extends FileSink {

    get capabilities(): sinkCapabilities {
        return {
            sql: false,
            incrementalSync: false,
            fileOutput: true,
            upload: false,
            persistsCompanyInfo: true
        };
    }

    async loadFromFile(targetTable: string, filePath: string, lstFieldType: string[]): Promise<number> {
        let content = fs.readFileSync(filePath, 'utf-8');
        content = convertCSV(content, lstFieldType);
        fs.writeFileSync(`./csv/${targetTable}.csv`, '﻿' + content);
        fs.unlinkSync(filePath); //delete raw file
        return 0;
    }
}
