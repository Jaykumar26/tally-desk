'use strict';

/*
 * Fills an EMPTY Tally company with sample masters so the interface has
 * something to show, and so the invoice and receipt paths can be proven against
 * real TallyPrime before they go anywhere near live books.
 *
 * This WRITES to Tally. It refuses to run unless the target company has almost
 * nothing in it, so it cannot be pointed at real books by accident.
 *
 *   node scripts/seed-test-company.js "Company Name"
 */

const tally = require('../lib/tally');
const api = require('../lib/api');
const requests = require('../lib/requests');
const vouchers = require('../lib/vouchers');
const { escapeXml, findFirst, value } = require('../lib/xml');
const fmt = require('../lib/format');

const company = process.argv[2] || '';
const cfg = {
  host: process.env.TALLY_HOST || '127.0.0.1',
  port: Number(process.env.TALLY_PORT) || 9000,
  company,
  timeoutMs: 60000,
  cacheMs: 0,
  dataDir: require('node:path').join(__dirname, '..', 'data'),
};

/* ------------------------------------------------------------- the sample */

const UNITS = ['Nos', 'Kg', 'Bag'];

const STOCK_GROUPS = ['Steel', 'Cement', 'Hardware'];

const LEDGERS = [
  { name: 'Ram Traders', parent: 'Sundry Debtors', billwise: true, mobile: '9000000001', credit: '30 Days' },
  { name: 'Shreeji Enterprise', parent: 'Sundry Debtors', billwise: true, mobile: '9000000002', credit: '45 Days' },
  { name: 'Nova Hardware', parent: 'Sundry Debtors', billwise: true, mobile: '9000000003', credit: '' },
  { name: 'Sitaram and Co', parent: 'Sundry Debtors', billwise: true, mobile: '9000000004', credit: '15 Days' },
  { name: 'Anand Steel Supply', parent: 'Sundry Creditors', billwise: true, mobile: '9000000005', credit: '30 Days' },
  { name: 'Sales', parent: 'Sales Accounts', billwise: false },
  { name: 'Purchase', parent: 'Purchase Accounts', billwise: false },
  { name: 'HDFC Bank', parent: 'Bank Accounts', billwise: false },
  // Plain ledgers under Duties & Taxes: the company has GST switched off, and a
  // TAXTYPE would be rejected. The invoice posts to them explicitly either way.
  { name: 'CGST', parent: 'Duties & Taxes', billwise: false },
  { name: 'SGST', parent: 'Duties & Taxes', billwise: false },
];

const STOCK = [
  { name: 'MS Angle 40x40', group: 'Steel', unit: 'Kg', qty: 1840.5, rate: 62 },
  { name: 'MS Pipe 1 inch', group: 'Steel', unit: 'Nos', qty: 320, rate: 480 },
  { name: 'Cement OPC 53', group: 'Cement', unit: 'Bag', qty: 214, rate: 395 },
  { name: 'Plywood 19mm', group: 'Hardware', unit: 'Nos', qty: 46, rate: 2150 },
  { name: 'Screws 2 inch', group: 'Hardware', unit: 'Bag', qty: 90, rate: 240 },
];

/* ---------------------------------------------------------------- helpers */

function masterImport(bodyXml) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST>',
    '<TYPE>Data</TYPE><ID>All Masters</ID></HEADER>',
    '<BODY><DESC><STATICVARIABLES>',
    `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`,
    '</STATICVARIABLES></DESC>',
    `<DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${bodyXml}</TALLYMESSAGE></DATA>`,
    '</BODY></ENVELOPE>',
  ].join('');
}

/** TallyPrime reports import counters in IMPORTRESULT; Tally.ERP 9 in RESPONSE. */
function counters(doc) {
  const node = findFirst(doc, 'IMPORTRESULT') || findFirst(doc, 'RESPONSE') || doc;
  return {
    created: fmt.toNumber(value(node, 'CREATED')),
    altered: fmt.toNumber(value(node, 'ALTERED')),
    ignored: fmt.toNumber(value(node, 'IGNORED')),
    errors: fmt.toNumber(value(node, 'ERRORS')),
    exceptions: fmt.toNumber(value(node, 'EXCEPTIONS')),
  };
}

async function importMasters(label, bodyXml) {
  const { doc } = await tally.request(masterImport(bodyXml), cfg);
  const c = counters(doc);
  console.log(`  ${label.padEnd(14)} created=${c.created} altered=${c.altered} ignored=${c.ignored} errors=${c.errors}`);
  if (c.errors > 0) throw new Error(`Tally reported ${c.errors} error(s) while creating ${label}.`);
  return c.created;
}

const unitXml = (name) =>
  `<UNIT NAME="${escapeXml(name)}" ACTION="Create"><NAME>${escapeXml(name)}</NAME>`
  + '<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>2</DECIMALPLACES></UNIT>';

const stockGroupXml = (name) =>
  `<STOCKGROUP NAME="${escapeXml(name)}" ACTION="Create"><NAME>${escapeXml(name)}</NAME>`
  + '<PARENT/><ISADDABLE>No</ISADDABLE></STOCKGROUP>';

const ledgerXml = (l) => [
  `<LEDGER NAME="${escapeXml(l.name)}" ACTION="Create">`,
  `<NAME>${escapeXml(l.name)}</NAME>`,
  `<PARENT>${escapeXml(l.parent)}</PARENT>`,
  `<ISBILLWISEON>${l.billwise ? 'Yes' : 'No'}</ISBILLWISEON>`,
  l.mobile ? `<LEDGERMOBILE>${escapeXml(l.mobile)}</LEDGERMOBILE>` : '',
  l.credit ? `<BILLCREDITPERIOD>${escapeXml(l.credit)}</BILLCREDITPERIOD>` : '',
  '<OPENINGBALANCE>0</OPENINGBALANCE>',
  '</LEDGER>',
].join('');

const stockItemXml = (s) => [
  `<STOCKITEM NAME="${escapeXml(s.name)}" ACTION="Create">`,
  `<NAME>${escapeXml(s.name)}</NAME>`,
  `<PARENT>${escapeXml(s.group)}</PARENT>`,
  `<BASEUNITS>${escapeXml(s.unit)}</BASEUNITS>`,
  `<OPENINGBALANCE>${s.qty} ${escapeXml(s.unit)}</OPENINGBALANCE>`,
  `<OPENINGRATE>${s.rate.toFixed(2)}/${escapeXml(s.unit)}</OPENINGRATE>`,
  `<OPENINGVALUE>${(s.qty * s.rate).toFixed(2)}</OPENINGVALUE>`,
  '</STOCKITEM>',
].join('');

/* ------------------------------------------------------------------- main */

async function main() {
  if (!company) {
    console.error('Usage: node scripts/seed-test-company.js "Company Name"');
    process.exit(1);
  }

  console.log(`\nTarget company: ${company} at ${cfg.host}:${cfg.port}\n`);

  // Guard: only ever fill an empty company, or one already holding just this
  // sample. Anything else is somebody's real books and is left alone.
  const existing = await api.getLedgers(cfg);
  const sampleNames = new Set(LEDGERS.map((l) => l.name));
  const foreign = existing.filter(
    (l) => !/^(Cash|Profit & Loss A\/c)$/.test(l.name) && !sampleNames.has(l.name),
  );
  if (foreign.length > 0) {
    console.error(`REFUSING TO RUN: "${company}" holds ${foreign.length} ledger(s) that are not part of this sample:`);
    foreign.slice(0, 5).forEach((l) => console.error(`  - ${l.name}`));
    console.error('This script is only for filling an empty test company.');
    process.exit(1);
  }

  const alreadySeeded = existing.some((l) => sampleNames.has(l.name));
  if (alreadySeeded) {
    console.log('Masters are already present — skipping to vouchers.\n');
  } else {
    console.log('Creating masters…');
    await importMasters('units', UNITS.map(unitXml).join(''));
    await importMasters('stock groups', STOCK_GROUPS.map(stockGroupXml).join(''));
    await importMasters('ledgers', LEDGERS.map(ledgerXml).join(''));
    await importMasters('stock items', STOCK.map(stockItemXml).join(''));
  }
  api.clearCache();

  const licence = await api.getLicense(cfg);
  if (licence.educational) {
    console.log('\nNOTE: this Tally is unlicensed (Educational mode).');
    console.log('      Bills carrying stock items cannot be saved, and vouchers are only');
    console.log('      accepted on the 1st, 2nd or last day of a month. The sample bills');
    console.log('      below are therefore accounting-only, on permitted dates.\n');
  }

  console.log('Posting vouchers…');

  // Dates are all 1st / 2nd / last-of-month so the same sample works on both a
  // licensed Tally and an Educational-mode one.
  const invoices = [
    { date: '2026-04-02', party: 'Ram Traders', reference: 'INV-1001', amount: 15340, gst: true },
    { date: '2026-05-01', party: 'Shreeji Enterprise', reference: 'INV-1002', amount: 62600, gst: true },
    { date: '2026-05-31', party: 'Shreeji Enterprise', reference: 'INV-1003', amount: 28400, gst: false },
    { date: '2026-07-01', party: 'Sitaram and Co', reference: 'INV-1004', amount: 18400, gst: false },
    { date: '2026-08-01', party: 'Nova Hardware', reference: 'INV-1005', amount: 3975, gst: false },
    { date: '2026-08-02', party: 'Ram Traders', reference: 'INV-1006', amount: 19800, gst: true },
  ];

  for (const invoice of invoices) {
    const totalTax = invoice.gst ? Math.round(invoice.amount * 18) / 100 : 0;
    const cgst = Math.round(totalTax * 50) / 100;
    const taxes = invoice.gst
      ? [{ ledger: 'CGST', amount: cgst }, { ledger: 'SGST', amount: Math.round((totalTax - cgst) * 100) / 100 }]
      : [];
    const total = fmt.money(invoice.amount + totalTax);

    // Posted with no stock lines, which the builder turns into an
    // accounting-only sale — the form an unlicensed Tally accepts.
    const xml = requests.salesVoucher({
      company,
      date: invoice.date,
      party: invoice.party,
      salesLedger: 'Sales',
      reference: invoice.reference,
      billRef: invoice.reference,
      narration: 'Sample entry created for testing Tally Desk',
      lines: [],
      taxes,
      total,
    });
    const { doc } = await tally.request(xml, cfg);
    const c = counters(doc);
    const status = c.created >= 1 ? 'ok' : `FAILED (exceptions=${c.exceptions} errors=${c.errors})`;
    console.log(`  ${invoice.reference}  ${invoice.party.padEnd(20)} ${total.toFixed(2).padStart(10)}  ${status}`);
  }

  // A part-payment, so Money Due shows a partly settled bill. This one goes
  // through the application's own posting path, proving that code end to end.
  api.clearCache();
  const receipt = await vouchers.postReceipt(cfg, {
    date: '2026-06-01',
    party: 'Ram Traders',
    depositLedger: 'HDFC Bank',
    amount: 8000,
    reference: 'NEFT-4471',
    narration: 'Part payment against INV-1001',
    againstBills: [{ name: 'INV-1001', amount: 8000 }],
    confirmed: true,
  });
  console.log(`  RECEIPT  ${receipt.record.party.padEnd(20)} ${receipt.record.total.toFixed(2).padStart(10)}  ok`);

  console.log('\nDone. Refresh the browser to see it.\n');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  if (err.problems) err.problems.forEach((p) => console.error(`  - ${p}`));
  if (err.detail) console.error(`  detail: ${err.detail}`);
  process.exit(1);
});
