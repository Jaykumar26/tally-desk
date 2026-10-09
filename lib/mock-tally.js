'use strict';

const http = require('node:http');
const { parse, findFirst, textOf, escapeXml } = require('./xml');
const fmt = require('./format');

/*
 * A stand-in for Tally's gateway, so the interface can be built and tested on a
 * machine that has no Tally installed. It speaks the same envelopes and returns
 * XML shaped the way TallyPrime shapes it — including the details that trip
 * integrations up: dates as YYYYMMDD, quantities as "12 Nos", rates as
 * "450.00/Nos", and an ISO-8859-1 declaration.
 *
 * Run it with:  node lib/mock-tally.js
 */

const COMPANY = 'Demo Traders';

const LEDGERS = [
  { name: 'Ram Traders', group: 'Sundry Debtors', closing: 48750, phone: '9876543210', credit: '30 Days', gstin: '24AAAPL1234C1ZV' },
  { name: 'Shreeji Enterprise', group: 'Sundry Debtors', closing: 122400, phone: '9825011111', credit: '45 Days', gstin: '24AACCS4567D1ZP' },
  { name: 'Nova Hardware', group: 'Sundry Debtors', closing: 8600, phone: '9998887770', credit: '', gstin: '' },
  { name: 'Sitaram & Co', group: 'Sundry Debtors', closing: 15200, phone: '9723344556', credit: '15 Days', gstin: '' },
  { name: 'Anand Steel Supply', group: 'Sundry Creditors', closing: -73400, phone: '9812345678', credit: '30 Days', gstin: '24AAECA9999K1Z2' },
  { name: 'Gupta Packaging', group: 'Sundry Creditors', closing: -19800, phone: '9856231470', credit: '', gstin: '' },
  { name: 'Cash', group: 'Cash-in-Hand', closing: 64300, phone: '', credit: '', gstin: '' },
  { name: 'HDFC Bank', group: 'Bank Accounts', closing: 512900, phone: '', credit: '', gstin: '' },
  { name: 'Sales', group: 'Sales Accounts', closing: -1840000, phone: '', credit: '', gstin: '' },
  { name: 'Sales - GST 18%', group: 'Sales Accounts', closing: -640000, phone: '', credit: '', gstin: '' },
  { name: 'Purchase', group: 'Purchase Accounts', closing: 1210000, phone: '', credit: '', gstin: '' },
  { name: 'CGST', group: 'Duties & Taxes', closing: -58400, phone: '', credit: '', gstin: '' },
  { name: 'SGST', group: 'Duties & Taxes', closing: -58400, phone: '', credit: '', gstin: '' },
  { name: 'Round Off', group: 'Indirect Expenses', closing: 12, phone: '', credit: '', gstin: '' },
];

const STOCK = [
  { name: 'MS Angle 40x40', group: 'Steel', unit: 'Kg', qty: 1840.5, rate: 62, value: 114111 },
  { name: 'MS Pipe 1 inch', group: 'Steel', unit: 'Nos', qty: 320, rate: 480, value: 153600 },
  { name: 'Cement OPC 53', group: 'Cement', unit: 'Bag', qty: 214, rate: 395, value: 84530 },
  { name: 'Plywood 19mm', group: 'Boards', unit: 'Nos', qty: 46, rate: 2150, value: 98900 },
  { name: 'Paint Emulsion 20L', group: 'Paints', unit: 'Can', qty: 8, rate: 4300, value: 34400 },
  { name: 'Screws 2 inch', group: 'Hardware', unit: 'Box', qty: 0, rate: 240, value: 0 },
];

const BILLS = [
  { ref: 'INV-1042', party: 'Ram Traders', date: '2026-05-02', amount: 22750, credit: '30 Days' },
  { ref: 'INV-1088', party: 'Ram Traders', date: '2026-07-18', amount: 26000, credit: '30 Days' },
  { ref: 'INV-1011', party: 'Shreeji Enterprise', date: '2026-03-11', amount: 84000, credit: '45 Days' },
  { ref: 'INV-1099', party: 'Shreeji Enterprise', date: '2026-08-01', amount: 38400, credit: '45 Days' },
  { ref: 'INV-1101', party: 'Nova Hardware', date: '2026-08-10', amount: 8600, credit: '' },
  { ref: 'INV-1067', party: 'Sitaram & Co', date: '2026-06-20', amount: 15200, credit: '15 Days' },
  { ref: 'INV-0980', party: 'Ram Traders', date: '2026-01-15', amount: 0, credit: '30 Days' },
  { ref: 'PUR-556', party: 'Anand Steel Supply', date: '2026-07-05', amount: -73400, credit: '30 Days' },
  { ref: 'PUR-561', party: 'Gupta Packaging', date: '2026-08-04', amount: -19800, credit: '' },
];

const VOUCHERS = [
  { date: '2026-05-02', type: 'Sales', no: '1042', party: 'Ram Traders', amount: 22750, against: 'Sales' },
  { date: '2026-06-14', type: 'Receipt', no: '318', party: 'Ram Traders', amount: -18000, against: 'Cash' },
  { date: '2026-07-18', type: 'Sales', no: '1088', party: 'Ram Traders', amount: 26000, against: 'Sales' },
  { date: '2026-03-11', type: 'Sales', no: '1011', party: 'Shreeji Enterprise', amount: 84000, against: 'Sales' },
  { date: '2026-08-01', type: 'Sales', no: '1099', party: 'Shreeji Enterprise', amount: 38400, against: 'Sales' },
  { date: '2026-08-10', type: 'Sales', no: '1101', party: 'Nova Hardware', amount: 8600, against: 'Sales' },
  { date: '2026-06-20', type: 'Sales', no: '1067', party: 'Sitaram & Co', amount: 15200, against: 'Sales' },
  { date: '2026-07-05', type: 'Purchase', no: '556', party: 'Anand Steel Supply', amount: -73400, against: 'Purchase' },
];

const HEAD = '<?xml version="1.0" encoding="ISO-8859-1"?>';

function tag(name, text) {
  return `<${name}>${escapeXml(text)}</${name}>`;
}

function companiesXml() {
  return `${HEAD}<ENVELOPE><COMPANY NAME="${COMPANY}">${tag('NAME', COMPANY)}${tag('STARTINGFROM', '20260401')}${tag('ENDINGAT', '20270331')}${tag('BOOKSFROM', '20260401')}</COMPANY></ENVELOPE>`;
}

function ledgersXml() {
  const body = LEDGERS.map((l) => [
    `<LEDGER NAME="${escapeXml(l.name)}" RESERVEDNAME="">`,
    tag('NAME', l.name),
    tag('PARENT', l.group),
    // Tally exports balances credit-positive, so a Debit balance goes out
    // negative. The table above is written debit-positive for readability and
    // negated here, matching what a real TallyPrime returns.
    tag('OPENINGBALANCE', (-l.closing * 0.4).toFixed(2)),
    tag('CLOSINGBALANCE', (-l.closing).toFixed(2)),
    tag('LEDGERMOBILE', l.phone),
    tag('PARTYGSTIN', l.gstin),
    tag('BILLCREDITPERIOD', l.credit),
    tag('ISBILLWISEON', /Debtors|Creditors/.test(l.group) ? 'Yes' : 'No'),
    l.phone ? `<ADDRESS.LIST TYPE="String">${tag('ADDRESS', 'Shop 4, Market Road')}${tag('ADDRESS', 'Ahmedabad')}</ADDRESS.LIST>` : '',
    '</LEDGER>',
  ].join('')).join('');
  return `${HEAD}<ENVELOPE>${body}</ENVELOPE>`;
}

// A "Bills" collection comes back as <BILL> elements, singular — confirmed
// against TallyPrime. Amounts are credit-positive like every other balance.
function billsXml() {
  const body = BILLS.map((b) => [
    `<BILL NAME="${escapeXml(b.ref)}">`,
    tag('NAME', b.ref),
    tag('PARENT', b.party),
    tag('BILLDATE', fmt.toTallyDate(b.date)),
    tag('CLOSINGBALANCE', (-b.amount).toFixed(2)),
    tag('BILLCREDITPERIOD', b.credit),
    tag('ISADVANCE', 'No'),
    '</BILL>',
  ].join('')).join('');
  return `${HEAD}<ENVELOPE>${body}</ENVELOPE>`;
}

function stockXml() {
  const body = STOCK.map((s) => [
    `<STOCKITEM NAME="${escapeXml(s.name)}" RESERVEDNAME="">`,
    tag('NAME', s.name),
    tag('PARENT', s.group),
    tag('BASEUNITS', s.unit),
    tag('CLOSINGBALANCE', `${s.qty} ${s.unit}`),
    tag('CLOSINGVALUE', s.value.toFixed(2)),
    tag('CLOSINGRATE', `${s.rate.toFixed(2)}/${s.unit}`),
    tag('STANDARDPRICE', `${(s.rate * 1.15).toFixed(2)}/${s.unit}`),
    '</STOCKITEM>',
  ].join('')).join('');
  return `${HEAD}<ENVELOPE>${body}</ENVELOPE>`;
}

function voucherTypesXml() {
  const types = [
    ['Sales', 'Sales'], ['Cash Sale', 'Sales'], ['Receipt', 'Receipt'],
    ['Purchase', 'Purchase'], ['Payment', 'Payment'], ['Journal', 'Journal'],
  ];
  const body = types.map(([name, parent]) => [
    `<VOUCHERTYPE NAME="${escapeXml(name)}">`,
    tag('NAME', name),
    tag('PARENT', parent),
    '</VOUCHERTYPE>',
  ].join('')).join('');
  return `${HEAD}<ENVELOPE>${body}</ENVELOPE>`;
}

function vouchersXml() {
  const body = VOUCHERS.map((v) => [
    `<VOUCHER REMOTEID="mock-${v.no}" VCHTYPE="${escapeXml(v.type)}" ACTION="None">`,
    tag('DATE', fmt.toTallyDate(v.date)),
    tag('VOUCHERTYPENAME', v.type),
    tag('VOUCHERNUMBER', v.no),
    tag('PARTYLEDGERNAME', v.party),
    tag('NARRATION', `Auto-generated demo entry ${v.no}`),
    tag('ISCANCELLED', 'No'),
    tag('ISOPTIONAL', 'No'),
    // Negative amount is a Debit, matching Tally's own export.
    `<ALLLEDGERENTRIES.LIST>${tag('LEDGERNAME', v.party)}${tag('ISDEEMEDPOSITIVE', v.amount > 0 ? 'Yes' : 'No')}${tag('AMOUNT', (-v.amount).toFixed(2))}</ALLLEDGERENTRIES.LIST>`,
    `<ALLLEDGERENTRIES.LIST>${tag('LEDGERNAME', v.against)}${tag('ISDEEMEDPOSITIVE', v.amount > 0 ? 'No' : 'Yes')}${tag('AMOUNT', v.amount.toFixed(2))}</ALLLEDGERENTRIES.LIST>`,
    '</VOUCHER>',
  ].join('')).join('');
  return `${HEAD}<ENVELOPE>${body}</ENVELOPE>`;
}

let created = 0;

/*
 * TallyPrime wraps import counters in <IMPORTRESULT> inside BODY/DATA. (Older
 * Tally.ERP 9 builds returned a bare <RESPONSE> with the same counters.) This
 * mirrors what a real TallyPrime 6.x gateway returns, verified against one.
 */
function importResponseXml() {
  created += 1;
  return [
    HEAD,
    '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA>',
    '<IMPORTRESULT><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED>',
    `<LASTVCHID>${9000 + created}</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED>`,
    '<IGNORED>0</IGNORED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>0</EXCEPTIONS>',
    '</IMPORTRESULT></DATA></BODY></ENVELOPE>',
  ].join('');
}

function respondTo(requestXml) {
  const doc = parse(requestXml);
  const header = findFirst(doc, 'HEADER');
  const kind = textOf(findFirst(header, 'TALLYREQUEST')).toLowerCase();
  const id = textOf(findFirst(header, 'ID'));

  if (kind === 'import') return importResponseXml();

  switch (id) {
    case 'TDCompanies': return companiesXml();
    case 'TDLedgers': return ledgersXml();
    case 'TDBills': return billsXml();
    case 'TDStockItems': return stockXml();
    case 'TDVoucherTypes': return voucherTypesXml();
    case 'TDPartyVouchers': return vouchersXml();
    default:
      return `${HEAD}<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DESC><LINEERROR>Could not find Report '${escapeXml(id)}'</LINEERROR></DESC></BODY></ENVELOPE>`;
  }
}

function start(port = 9000) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let reply;
      try {
        reply = respondTo(body);
      } catch (err) {
        reply = `${HEAD}<ENVELOPE><LINEERROR>${escapeXml(err.message)}</LINEERROR></ENVELOPE>`;
      }
      const payload = Buffer.from(reply, 'latin1');
      res.writeHead(200, { 'Content-Type': 'text/xml', 'Content-Length': payload.length });
      res.end(payload);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[mock-tally] pretending to be TallyPrime on http://127.0.0.1:${port} (company: ${COMPANY})`);
  });
  return server;
}

if (require.main === module) {
  start(Number(process.argv[2]) || 9000);
}

module.exports = { start, respondTo, COMPANY };
