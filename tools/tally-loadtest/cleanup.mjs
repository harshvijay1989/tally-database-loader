// Removes every LT_-prefixed master (created by generate.mjs) from the open Tally
// company, restoring it to its original state. Zero deps.
//
// Usage:  node tools/tally-loadtest/cleanup.mjs

import http from 'node:http';

const HOST = process.env.TALLY_HOST || 'localhost';
const PORT = Number(process.env.TALLY_PORT) || 9000;
const PREFIX = 'LT_';
const BATCH = Number(process.env.BATCH) || 500;

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
function post(msg, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path: '', method: 'POST', agent,
      headers: { 'Content-Length': Buffer.byteLength(msg, 'utf16le'), 'Content-Type': 'text/xml;charset=utf-16', 'Connection': 'keep-alive' } },
      res => { let d = ''; res.setEncoding('utf16le').on('data', c => d += c).on('end', () => resolve(d)).on('error', reject); });
    req.on('error', reject); req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout'))); req.write(msg, 'utf16le'); req.end();
  });
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getCompany() {
  const xml = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>C</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="C" ISINITIALIZE="Yes"><TYPE>Company</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
  const m = /<COMPANY NAME="([^"]+)"/.exec(await post(xml, 15000)); return m ? m[1] : '';
}
// list every LT_-prefixed name for an object type (light FETCH NAME)
async function listNames(type) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>N</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="N" ISINITIALIZE="Yes"><TYPE>${type}</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const r = await post(xml, 60000);
  const names = [];
  const re = /<[A-Z]+ NAME="([^"]+)"/g; let m;
  while ((m = re.exec(r))) if (m[1].startsWith(PREFIX)) names.push(m[1]);
  return names;
}
function delEnvelope(company, tag, names) {
  const sv = company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '';
  const msgs = names.map(n => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><${tag} NAME="${esc(n)}" ACTION="Delete"><NAME.LIST><NAME>${esc(n)}</NAME></NAME.LIST></${tag}></TALLYMESSAGE>`).join('');
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES>${sv}</STATICVARIABLES></REQUESTDESC><REQUESTDATA>${msgs}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
const num = (r, t) => { const m = new RegExp(`<${t}>(-?\\d+)</${t}>`).exec(r); return m ? parseInt(m[1]) : 0; };

const company = await getCompany();
console.log(`Tally ${HOST}:${PORT} | company: ${company || '(active)'} | deleting ${PREFIX}* masters`);
for (const [type, tag] of [['Ledger', 'LEDGER'], ['StockItem', 'STOCKITEM'], ['Group', 'GROUP']]) {
  const names = await listNames(type);
  if (!names.length) { console.log(`  ${type}: none`); continue; }
  let deleted = 0;
  for (let i = 0; i < names.length; i += BATCH) {
    const r = await post(delEnvelope(company, tag, names.slice(i, i + BATCH)));
    deleted += num(r, 'DELETED');
  }
  console.log(`  ${type}: deleted ${deleted} of ${names.length}`);
}
console.log('cleanup done');
