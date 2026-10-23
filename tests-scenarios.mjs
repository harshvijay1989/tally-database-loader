import { assembleVoucher } from './dist/sfAgent.mjs';
import { computeGstEntries, DEFAULT_GST_LEDGERS } from './dist/gst.mjs';
import { buildVoucherImportXml, validateVoucher } from './dist/tallyImport.mjs';
import { canonStateCode, stateNameFromCode, resolveStateCode } from './dist/stateCodes.mjs';

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  x FAIL:', name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + '==' + JSON.stringify(b) + ')', a === b); }
const cfg = { ...DEFAULT_GST_LEDGERS };
const itemBySap = new Map([['p1', { name: 'Item One', unit: 'pcs' }], ['p2', { name: 'Item Two', unit: 'pcs' }]]);
const rate18 = new Map([['p1', 18], ['p2', 18]]);
const L = (o) => ({ productSapId: 'p1', qty: 10, rate: 100, amount: 1000, ...o });

console.log('== A. GST engine ==');
{ const r = computeGstEntries([{ base: 1000, rate: 18 }], { intra: true, isPurchase: false, cfg });
  eq('A1 intra total tax', r.totalTax, 180);
  eq('A1 intra two entries', r.entries.length, 2);
  eq('A1 CGST 90', r.entries[0].amount, 90); eq('A1 SGST 90', r.entries[1].amount, 90);
  ok('A1 output ledgers', r.entries[0].ledger === 'Output CGST'); }
{ const r = computeGstEntries([{ base: 1000, rate: 18 }], { intra: false, isPurchase: false, cfg });
  eq('A2 inter one entry', r.entries.length, 1); eq('A2 IGST 180', r.entries[0].amount, 180);
  ok('A2 output igst ledger', r.entries[0].ledger === 'Output IGST'); }
{ const r = computeGstEntries([{ base: 1000, rate: 18 }], { intra: true, isPurchase: true, cfg });
  ok('A3 purchase uses input ledgers', r.entries[0].ledger === 'Input CGST'); }
{ const r = computeGstEntries([{ base: 1000, rate: 0 }], { intra: true, isPurchase: false, cfg });
  eq('A4 zero rate -> no entries', r.entries.length, 0); eq('A4 zero tax', r.totalTax, 0); }
{ const r = computeGstEntries([{ base: 1000, rate: 18 }], { intra: false, isPurchase: false, cfg: {} });
  ok('A5 missing ledger -> error', !!r.error); }
{ const r = computeGstEntries([{ base: 1000, rate: 18 }], { intra: false, isPurchase: false, sign: -1, cfg });
  eq('A6 note sign flips IGST negative', r.entries[0].amount, -180); }
{ const r = computeGstEntries([{ base: 333, rate: 18 }], { intra: true, isPurchase: false, cfg });
  eq('A7 rounding total', r.totalTax, 59.94); ok('A7 halves sum to total', r.entries[0].amount + r.entries[1].amount === 59.94); }

console.log('== B. assembleVoucher by type ==');
{ const v = assembleVoucher('Invoice', { party: 'Cust', date: '20170801', number: 'I1' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  ok('B1 invoice object', typeof v === 'object');
  eq('B1 voucherType', v.voucherType, 'Sales');
  const party = v.entries.find(e => e.ledger === 'Cust'); eq('B1 party DEBITED (sale: Dr customer, <0)', party.amount, -1180);
  const sum = v.entries.reduce((s, e) => s + e.amount, 0) + (v.inventoryEntries || []).reduce((s, i) => s + i.amount, 0);
  ok('B1 balances', Math.abs(sum) < 0.005);
  eq('B1 qty outward (neg)', v.inventoryEntries[0].qty, -10); }
{ const v = assembleVoucher('Purchase', { party: 'Sup', date: '20170801', number: 'P1' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  const party = v.entries.find(e => e.ledger === 'Sup'); eq('B2 party CREDITED (purchase: Cr supplier, >0)', party.amount, 1180);
  eq('B2 qty inward (pos)', v.inventoryEntries[0].qty, 10);
  ok('B2 input ledger used', v.entries.some(e => e.ledger === 'Input CGST')); }
{ const v = assembleVoucher('Note', { party: 'Cust', date: '20170801', number: 'CN1', noteType: 'Credit' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  eq('B3 credit note type', v.voucherType, 'Credit Note');
  ok('B3 CN uses OUTPUT ledgers', v.entries.some(e => e.ledger === 'Output CGST'));
  const cg = v.entries.find(e => e.ledger === 'Output CGST'); ok('B3 CN output debited (<0)', cg.amount < 0);
  const party = v.entries.find(e => e.ledger === 'Cust'); ok('B3 CN party credited (>0)', party.amount > 0);
  const sum = v.entries.reduce((s, e) => s + e.amount, 0) + v.inventoryEntries.reduce((s, i) => s + i.amount, 0); ok('B3 balances', Math.abs(sum) < 0.005); }
{ const v = assembleVoucher('Note', { party: 'Sup', date: '20170801', number: 'DN1', noteType: 'Debit' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  eq('B4 debit note type', v.voucherType, 'Debit Note');
  ok('B4 DN uses INPUT ledgers', v.entries.some(e => e.ledger === 'Input CGST'));
  const ig = v.entries.find(e => e.ledger === 'Input CGST'); ok('B4 DN input credited (>0)', ig.amount > 0);
  const party = v.entries.find(e => e.ledger === 'Sup'); ok('B4 DN party debited (<0)', party.amount < 0);
  const sum = v.entries.reduce((s, e) => s + e.amount, 0) + v.inventoryEntries.reduce((s, i) => s + i.amount, 0); ok('B4 balances', Math.abs(sum) < 0.005); }
{ const v = assembleVoucher('Order', { party: 'Cust', date: '20170801', number: 'SO1' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  eq('B5 sales order type', v.voucherType, 'Sales Order'); ok('B5 isOrder', v.isOrder === true);
  eq('B5 only party entry', v.entries.length, 1);
  ok('B5 no tax on order', !v.entries.some(e => /CGST|IGST/.test(e.ledger)));
  eq('B5 sales order qty outward (-10)', v.inventoryEntries[0].qty, -10); }
{ const v = assembleVoucher('PurchaseOrder', { party: 'Sup', date: '20170801', number: 'PO1' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  eq('B6 purchase order type', v.voucherType, 'Purchase Order'); ok('B6 isOrder', v.isOrder === true); }

console.log('== C. Godown header + order ==');
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L(), L({ productSapId: 'p2' })], itemBySap, { rateBySap: rate18, intra: true, cfg }, { headerGodown: 'North' });
  ok('C1 header godown on ALL lines', v.inventoryEntries.every(i => i.godown === 'North')); }
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg }, { defaultGodown: 'Main Location' });
  eq('C2 default godown when no header', v.inventoryEntries[0].godown, 'Main Location'); }
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg }, { headerGodown: 'North', defaultGodown: 'Main Location' });
  eq('C3 header wins over default', v.inventoryEntries[0].godown, 'North'); }
{ const v = assembleVoucher('Order', { party: 'C', date: '20170801', number: 'O' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg }, { headerGodown: 'North' });
  ok('C4 ORDER carries NO godown even if header set', v.inventoryEntries[0].godown === undefined); }

console.log('== D. Ship-to + place of supply ==');
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: false, cfg }, { shipTo: { name: 'ShipCo', lines: ['12 Rd', 'Ahmedabad 380001'], stateName: 'Gujarat' } });
  eq('D1 consignee name', v.consigneeName, 'ShipCo'); eq('D1 place of supply', v.placeOfSupply, 'Gujarat');
  eq('D1 ship addr lines', v.shipToAddress.length, 2); }
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  ok('D2 no ship-to -> no consignee', v.consigneeName === undefined && v.shipToAddress === undefined); }
eq('D3 canon CT==CG', canonStateCode('CT'), canonStateCode('CG'));
eq('D4 canon UT==UK', canonStateCode('UT'), canonStateCode('UK'));
ok('D5 MH != GJ', canonStateCode('MH') !== canonStateCode('GJ'));
eq('D6 stateNameFromCode GJ', stateNameFromCode('GJ'), 'Gujarat');
eq('D7 resolveStateCode from GSTIN 24', resolveStateCode('', '24ABCDE1234F1Z5'), 'GJ');
eq('D8 resolveStateCode from name', resolveStateCode('Maharashtra'), 'MH');

console.log('== E. Error / edge cases ==');
ok('E1 missing party -> error', typeof assembleVoucher('Invoice', { date: '20170801' }, [L()], itemBySap) === 'string');
ok('E2 bad date -> error', typeof assembleVoucher('Invoice', { party: 'C', date: '2017-08-01' }, [L()], itemBySap) === 'string');
ok('E3 zero amount -> error', typeof assembleVoucher('Invoice', { party: 'C', date: '20170801' }, [L({ amount: 0 })], itemBySap, undefined) === 'string');
ok('E4 unresolvable item -> error', typeof assembleVoucher('Invoice', { party: 'C', date: '20170801' }, [{ productSapId: 'zzz', qty: 1, amount: 100 }], itemBySap) === 'string');
ok('E5 unknown object type -> error', typeof assembleVoucher('Nonsense', { party: 'C', date: '20170801' }, [L()], itemBySap) === 'string');
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I', amount: 1000 }, [], itemBySap, undefined);
  ok('E6 no-line invoice = 2-line accounting', typeof v === 'object' && v.entries.length === 2 && !v.inventoryEntries); }

console.log('== F. buildVoucherImportXml ==');
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg }, { headerGodown: 'North' });
  const xml = buildVoucherImportXml(v);
  ok('F1 inventory uses LEDGERENTRIES.LIST', xml.includes('<LEDGERENTRIES.LIST>') && !xml.includes('<ALLLEDGERENTRIES.LIST>'));
  ok('F2 emits godown', xml.includes('<GODOWNNAME>North</GODOWNNAME>'));
  ok('F3 default batch name', xml.includes('<BATCHNAME>Primary Batch</BATCHNAME>')); }
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I', amount: 1000 }, [], itemBySap, undefined);
  const xml = buildVoucherImportXml(v);
  ok('F4 non-inventory uses ALLLEDGERENTRIES.LIST', xml.includes('<ALLLEDGERENTRIES.LIST>')); }
{ const v = assembleVoucher('Order', { party: 'C', date: '20170801', number: 'O' }, [L()], itemBySap, undefined, { headerGodown: 'North' });
  const xml = buildVoucherImportXml(v);
  ok('F5 ORDER emits no BATCHALLOCATIONS', !xml.includes('BATCHALLOCATIONS'));
  ok('F6 ORDER emits ORDERDUEDATE', xml.includes('<ORDERDUEDATE>')); }
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: false, cfg }, { shipTo: { name: 'ShipCo', lines: ['A', 'B'], stateName: 'Gujarat' } });
  const xml = buildVoucherImportXml(v);
  ok('F7 ship-to emits PLACEOFSUPPLY', xml.includes('<PLACEOFSUPPLY>Gujarat</PLACEOFSUPPLY>'));
  ok('F8 ship-to emits consignee name', xml.includes('<BASICBUYERNAME>ShipCo</BASICBUYERNAME>'));
  ok('F9 ship-to emits address list', xml.includes('<BASICBUYERADDRESS>A</BASICBUYERADDRESS>')); }
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  const xml = buildVoucherImportXml(v);
  ok('F10 sale party DEBITED -> ISDEEMEDPOSITIVE Yes', xml.includes('<LEDGERNAME>C</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>')); }

console.log('== G. validateVoucher ==');
{ const v = assembleVoucher('Invoice', { party: 'C', date: '20170801', number: 'I' }, [L()], itemBySap, { rateBySap: rate18, intra: true, cfg });
  ok('G1 valid balanced voucher', validateVoucher(v) === null); }
{ const v = assembleVoucher('Order', { party: 'C', date: '20170801', number: 'O' }, [L()], itemBySap, undefined);
  ok('G2 order-style valid', validateVoucher(v) === null); }
ok('G3 unbalanced -> error', validateVoucher({ date: '20170801', voucherType: 'Sales', entries: [{ ledger: 'A', amount: 100 }], inventoryEntries: [] }) !== null);
ok('G4 bad date -> error', validateVoucher({ date: 'x', voucherType: 'Sales', entries: [{ ledger: 'A', amount: 0 }, { ledger: 'B', amount: 0 }] }) !== null);

console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
