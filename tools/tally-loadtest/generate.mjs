// Load-test data generator: creates many ledgers (with nested data) in the LOCAL
// Tally company via the HTTP Import gateway, so we can reproduce the big-company
// FETCH * crash and validate the fix. Zero deps. Names are prefixed LT_ so
// cleanup.mjs can remove them all afterward.
//
// Usage:  node tools/tally-loadtest/generate.mjs [ledgerCount]   (default 8000)
//         WARNING: this modifies the currently-open Tally company.

import http from 'node:http';

const HOST = process.env.TALLY_HOST || 'localhost';
const PORT = Number(process.env.TALLY_PORT) || 9000;
const PREFIX = 'LT_';
const LEDGERS = Number(process.argv[2]) || 8000;
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
  const r = await post(xml, 15000);
  const m = /<COMPANY NAME="([^"]+)"/.exec(r) || /<NAME>([^<]+)<\/NAME>/.exec(r);
  return m ? m[1] : '';
}

// party-type groups only — they accept the GST/bank/party nested fields we add,
// so every ledger imports cleanly AND carries heavy nested data for FETCH *.
const GROUPS = ['Sundry Debtors', 'Sundry Creditors'];
function ledgerXml(i) {
  const name = `${PREFIX}Ledger_${String(i).padStart(5, '0')}`;
  const parent = GROUPS[i % GROUPS.length];
  const ob = (((i * 97) % 100000) / 100) * (i % 2 ? 1 : -1);
  const num = String(1000 + (i % 9000));
  return `<LEDGER NAME="${esc(name)}" ACTION="Create">`
    + `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>`
    + `<PARENT>${parent}</PARENT>`
    + `<OPENINGBALANCE>${ob.toFixed(2)}</OPENINGBALANCE>`
    + `<MAILINGNAME>${esc(name)}</MAILINGNAME>`
    + `<LEDGERPHONE>98${String(10000000 + (i % 89999999))}</LEDGERPHONE>`
    + `<EMAIL>lt${i}@example.com</EMAIL>`
    + `<INCOMETAXNUMBER>ABCDE${num}F</INCOMETAXNUMBER>`
    + `<PARTYGSTIN>27ABCDE${num}F1Z5</PARTYGSTIN>`
    + `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>`
    + `<BANKDETAILS>HDFC Bank Branch ${i % 50}</BANKDETAILS>`
    + `<IFSCODE>HDFC000${num}</IFSCODE>`
    + `<BANKACCHOLDERNAME>${esc(name)}</BANKACCHOLDERNAME>`
    + `<ADDRESS.LIST TYPE="String"><ADDRESS>Plot ${i}, Industrial Area</ADDRESS><ADDRESS>Sector ${i % 40}</ADDRESS><ADDRESS>Pune, Maharashtra</ADDRESS></ADDRESS.LIST>`
    + `<LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>Plot ${i}</ADDRESS><ADDRESS>Pune</ADDRESS></ADDRESS.LIST><STATE>Maharashtra</STATE><COUNTRY>India</COUNTRY><PINCODE>4110${String(i % 100).padStart(2, '0')}</PINCODE></LEDMAILINGDETAILS.LIST>`
    + `</LEDGER>`;
}

function importEnvelope(company, messages) {
  const sv = company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '';
  return '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>'
    + `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES>${sv}</STATICVARIABLES></REQUESTDESC>`
    + `<REQUESTDATA>${messages.map(m => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`).join('')}</REQUESTDATA>`
    + '</IMPORTDATA></BODY></ENVELOPE>';
}
function parseResp(r) {
  const g = t => { const m = new RegExp(`<${t}>(-?\\d+)</${t}>`).exec(r); return m ? parseInt(m[1]) : 0; };
  return { created: g('CREATED'), altered: g('ALTERED'), errors: g('ERRORS'), exceptions: g('EXCEPTIONS'), ignored: g('IGNORED') };
}

const company = await getCompany();
console.log(`Tally ${HOST}:${PORT} | company: ${company || '(active)'} | creating ${LEDGERS} ledgers (prefix ${PREFIX}) in batches of ${BATCH}`);
let created = 0, errors = 0; const t0 = Date.now();
for (let start = 1; start <= LEDGERS; start += BATCH) {
  const end = Math.min(start + BATCH - 1, LEDGERS);
  const msgs = []; for (let i = start; i <= end; i++) msgs.push(ledgerXml(i));
  try {
    const resp = await post(importEnvelope(company, msgs));
    const p = parseResp(resp);
    created += p.created; errors += p.errors;
    console.log(`  ledgers ${start}-${end}: created=${p.created} altered=${p.altered} errors=${p.errors} exceptions=${p.exceptions}`);
    if (p.errors && start === 1) console.log('  [sample response]', resp.slice(0, 500).replace(/\s+/g, ' '));
  } catch (e) { console.log(`  ledgers ${start}-${end}: FAILED - ${e.message}`); }
}
console.log(`DONE: created ${created} ledgers, ${errors} errors, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
