'use strict';

/*
 * Adds GST details to the sample masters.
 *
 * A GST-enabled company will not accept an invoice whose party, stock item and
 * sales ledger carry no GST classification — Tally files the voucher under
 * exceptions instead of creating it, and reports EXCEPTIONS=1 with no message.
 * This fills in the minimum Tally needs to classify a supply:
 *
 *   party      state + registration type   (decides CGST/SGST vs IGST)
 *   stock item HSN + taxability + rate
 *   sales      GST applicable
 *   CGST/SGST  proper duty heads, not plain ledgers
 *
 * Safe to re-run: everything uses ACTION="Alter".
 *
 *   node scripts/add-gst-to-masters.js "Company Name" [State]
 */

const tally = require('../lib/tally');
const { escapeXml, findFirst, value } = require('../lib/xml');
const fmt = require('../lib/format');

const company = process.argv[2] || '';
const state = process.argv[3] || 'Kerala';

const cfg = {
  host: process.env.TALLY_HOST || '127.0.0.1',
  port: Number(process.env.TALLY_PORT) || 9000,
  company,
  timeoutMs: 60000,
};

// Tally prefixes certain option values with a control character. It is
// invisible in the UI but the value is rejected without it.
const OPT = '';
const APPLICABLE = `${OPT} Applicable`;
const ANY_STATE = `${OPT} Any`;

const PARTIES = ['Ram Traders', 'Shreeji Enterprise', 'Nova Hardware', 'Sitaram and Co', 'Anand Steel Supply'];

const ITEMS = [
  { name: 'MS Angle 40x40', hsn: '7216', rate: 18 },
  { name: 'MS Pipe 1 inch', hsn: '7306', rate: 18 },
  { name: 'Cement OPC 53', hsn: '2523', rate: 28 },
  { name: 'Plywood 19mm', hsn: '4412', rate: 18 },
  { name: 'Screws 2 inch', hsn: '7318', rate: 18 },
];

function masterImport(body) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST>',
    '<TYPE>Data</TYPE><ID>All Masters</ID></HEADER><BODY><DESC><STATICVARIABLES>',
    `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`,
    '</STATICVARIABLES></DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">',
    body,
    '</TALLYMESSAGE></DATA></BODY></ENVELOPE>',
  ].join('');
}

/** Reads TallyPrime's import counters. They live in IMPORTRESULT, not RESPONSE. */
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

async function send(label, body) {
  const { doc } = await tally.request(masterImport(body), cfg);
  const c = counters(doc);
  console.log(`  ${label.padEnd(16)} created=${c.created} altered=${c.altered} ignored=${c.ignored} errors=${c.errors} exceptions=${c.exceptions}`);
  return c;
}

// Parties are marked Unregistered on purpose: a Regular registration needs a
// GSTIN whose checksum Tally validates, and an invented one would be rejected.
const partyXml = (name) => [
  `<LEDGER NAME="${escapeXml(name)}" ACTION="Alter">`,
  `<NAME>${escapeXml(name)}</NAME>`,
  '<COUNTRYNAME>India</COUNTRYNAME>',
  `<LEDSTATENAME>${escapeXml(state)}</LEDSTATENAME>`,
  `<STATENAME>${escapeXml(state)}</STATENAME>`,
  '<GSTREGISTRATIONTYPE>Unregistered</GSTREGISTRATIONTYPE>',
  '<ISBILLWISEON>Yes</ISBILLWISEON>',
  '</LEDGER>',
].join('');

const salesLedgerXml = () => [
  '<LEDGER NAME="Sales" ACTION="Alter">',
  '<NAME>Sales</NAME>',
  '<PARENT>Sales Accounts</PARENT>',
  `<GSTAPPLICABLE>${APPLICABLE}</GSTAPPLICABLE>`,
  '<GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>',
  '</LEDGER>',
].join('');

const dutyLedgerXml = (name, head) => [
  `<LEDGER NAME="${escapeXml(name)}" ACTION="Alter">`,
  `<NAME>${escapeXml(name)}</NAME>`,
  '<PARENT>Duties &amp; Taxes</PARENT>',
  '<TAXTYPE>GST</TAXTYPE>',
  `<GSTDUTYHEAD>${escapeXml(head)}</GSTDUTYHEAD>`,
  '<ROUNDTYPE>Normal Rounding</ROUNDTYPE>',
  '<ROUNDLIMIT>1</ROUNDLIMIT>',
  '<AFFECTSSTOCK>No</AFFECTSSTOCK>',
  '</LEDGER>',
].join('');

const rateRow = (head, rate) =>
  `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD>`
  + '<GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>'
  + (rate === null ? '' : `<GSTRATE>${rate}</GSTRATE>`)
  + '</RATEDETAILS.LIST>';

const itemXml = (item) => [
  `<STOCKITEM NAME="${escapeXml(item.name)}" ACTION="Alter">`,
  `<NAME>${escapeXml(item.name)}</NAME>`,
  `<GSTAPPLICABLE>${APPLICABLE}</GSTAPPLICABLE>`,
  '<GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>',
  `<HSNCODE>${item.hsn}</HSNCODE>`,
  '<GSTDETAILS.LIST>',
  '<APPLICABLEFROM>20260401</APPLICABLEFROM>',
  `<HSNCODE>${item.hsn}</HSNCODE>`,
  '<TAXABILITY>Taxable</TAXABILITY>',
  '<ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>',
  '<STATEWISEDETAILS.LIST>',
  `<STATENAME>${ANY_STATE}</STATENAME>`,
  rateRow('IGST', item.rate),
  rateRow('CGST', item.rate / 2),
  rateRow('SGST/UTGST', item.rate / 2),
  rateRow('Cess', null),
  '</STATEWISEDETAILS.LIST>',
  '</GSTDETAILS.LIST>',
  '</STOCKITEM>',
].join('');

async function main() {
  if (!company) {
    console.error('Usage: node scripts/add-gst-to-masters.js "Company Name" [State]');
    process.exit(1);
  }
  console.log(`\nAdding GST details in "${company}" (state: ${state})\n`);

  await send('duty ledgers', dutyLedgerXml('CGST', 'Central Tax') + dutyLedgerXml('SGST', 'State Tax'));
  await send('sales ledger', salesLedgerXml());
  await send('parties', PARTIES.map(partyXml).join(''));
  await send('stock items', ITEMS.map(itemXml).join(''));

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  if (err.detail) console.error(`  detail: ${err.detail}`);
  process.exit(1);
});
