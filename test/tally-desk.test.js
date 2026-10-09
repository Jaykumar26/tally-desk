'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const xml = require('../lib/xml');
const fmt = require('../lib/format');
const tally = require('../lib/tally');
const requests = require('../lib/requests');
const api = require('../lib/api');
const vouchers = require('../lib/vouchers');
const daybills = require('../lib/daybills');
const mock = require('../lib/mock-tally');

/* ------------------------------------------------------------ xml parsing */

test('parses nested elements, attributes and dotted tag names', () => {
  const doc = xml.parse(`
    <ENVELOPE>
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>20260815</DATE>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </ENVELOPE>`);

  const voucher = xml.findFirst(doc, 'VOUCHER');
  assert.equal(voucher.attrs.VCHTYPE, 'Sales');
  assert.equal(xml.value(voucher, 'DATE'), '20260815');

  const entry = xml.findFirst(voucher, 'ALLLEDGERENTRIES.LIST');
  assert.equal(xml.value(entry, 'LEDGERNAME'), 'Cash');
});

test('decodes entities and strips the control characters Tally uses to separate same-named masters', () => {
  const doc = xml.parse('<E><NAME>Ram &amp; Sons&#4;</NAME><NOTE>a &lt; b</NOTE></E>');
  const root = xml.findFirst(doc, 'E');
  assert.equal(xml.value(root, 'NAME'), 'Ram & Sons');
  assert.equal(xml.value(root, 'NOTE'), 'a < b');
});

test('a > inside an attribute value does not end the tag early', () => {
  const doc = xml.parse('<E><ITEM DESC="width > 10">ok</ITEM></E>');
  const item = xml.findFirst(doc, 'ITEM');
  assert.equal(item.attrs.DESC, 'width > 10');
  assert.equal(xml.textOf(item), 'ok');
});

test('a stray closing tag does not discard the rest of the document', () => {
  const doc = xml.parse('<E><A>1</A></ZZZ><B>2</B></E>');
  const root = xml.findFirst(doc, 'E');
  assert.equal(xml.value(root, 'B'), '2');
});

test('self-closing and empty elements read as empty, not missing', () => {
  const doc = xml.parse('<E><LINEERROR/><OTHER></OTHER></E>');
  assert.equal(xml.findAll(doc, 'LINEERROR').length, 1);
  assert.equal(xml.value(xml.findFirst(doc, 'E'), 'OTHER', 'fallback'), 'fallback');
});

/* ------------------------------------------------------------ conversions */

test('reads Tally quantities and rates', () => {
  assert.deepEqual(fmt.toQuantity('10 Nos'), { qty: 10, unit: 'Nos' });
  assert.deepEqual(fmt.toQuantity('-5.5 Kg'), { qty: -5.5, unit: 'Kg' });
  assert.deepEqual(fmt.toQuantity('2 Box of 12 Nos'), { qty: 2, unit: 'Box' });
  assert.deepEqual(fmt.toQuantity(''), { qty: 0, unit: '' });
  assert.deepEqual(fmt.toRate('450.00/Nos'), { rate: 450, unit: 'Nos' });
});

test('reads both Tally date formats and writes back the storage format', () => {
  assert.equal(fmt.toIsoDate('20260815'), '2026-08-15');
  assert.equal(fmt.toIsoDate('15-Aug-2026'), '2026-08-15');
  assert.equal(fmt.toIsoDate('rubbish'), '');
  assert.equal(fmt.toTallyDate('2026-08-15'), '20260815');
});

test('reads credit periods in days, weeks and months', () => {
  assert.equal(fmt.creditPeriodToDays('30 Days'), 30);
  assert.equal(fmt.creditPeriodToDays('2 Months'), 60);
  assert.equal(fmt.creditPeriodToDays(''), null);
});

test('the financial year runs April to March', () => {
  assert.deepEqual(fmt.financialYear('2026-08-15'), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(fmt.financialYear('2026-02-10'), { from: '2025-04-01', to: '2026-03-31' });
});

/* -------------------------------------------------------------- transport */

test('response encoding is taken from the declaration, not assumed', () => {
  const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><E>caf\xe9</E>', 'latin1');
  assert.match(tally.decodeBody(latin1), /café/);

  const utf8 = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><E>café</E>', 'utf8');
  assert.match(tally.decodeBody(utf8), /café/);
});

/* ------------------------------------ conventions verified against TallyPrime */

test('balances arrive credit-positive and are flipped so Debit reads positive', async (t) => {
  // Confirmed against a live TallyPrime: an invoiced debtor comes back NEGATIVE
  // and the Sales ledger comes back POSITIVE. Getting this backwards silently
  // inverts every balance in the interface, so it is pinned here.
  const port = 19800 + Math.floor(Math.random() * 150);
  const server = mock.start(port);
  await new Promise((resolve) => server.once('listening', resolve));
  const cfg = { host: '127.0.0.1', port, company: mock.COMPANY, timeoutMs: 10000, cacheMs: 0 };
  t.after(() => { server.close(); api.clearCache(); });

  const raw = mock.respondTo('<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><ID>TDLedgers</ID></HEADER></ENVELOPE>');
  assert.match(raw, /<CLOSINGBALANCE>-48750\.00<\/CLOSINGBALANCE>/, 'a debtor must go out negative');

  const ledgers = await api.getLedgers(cfg);
  const debtor = ledgers.find((l) => l.name === 'Ram Traders');
  const sales = ledgers.find((l) => l.name === 'Sales');
  assert.equal(debtor.closing, 48750, 'a debtor should read positive after flipping');
  assert.ok(sales.closing < 0, 'a sales ledger holds a credit balance');
});

test('a Bills collection returns <BILL> elements, not <BILLS>', async (t) => {
  // TallyPrime names the objects after the singular type. Reading the plural
  // finds nothing and the Money Due screen silently shows zero.
  const port = 19960 + Math.floor(Math.random() * 30);
  const server = mock.start(port);
  await new Promise((resolve) => server.once('listening', resolve));
  const cfg = { host: '127.0.0.1', port, company: mock.COMPANY, timeoutMs: 10000, cacheMs: 0 };
  t.after(() => { server.close(); api.clearCache(); });

  const raw = mock.respondTo('<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><ID>TDBills</ID></HEADER></ENVELOPE>');
  assert.match(raw, /<BILL /);
  assert.doesNotMatch(raw, /<BILLS /);

  const bills = await api.getBills(cfg);
  assert.ok(bills.length > 0, 'bills must still be found');
  assert.ok(bills.some((b) => b.kind === 'receivable' && b.amount > 0));
});

test('import counters are read from IMPORTRESULT and from RESPONSE', () => {
  // TallyPrime answers with IMPORTRESULT; Tally.ERP 9 with RESPONSE. Reading
  // only one shape reports a successful import as "nothing was created".
  const prime = xml.parse('<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS><LASTVCHID>42</LASTVCHID></IMPORTRESULT></DATA></BODY></ENVELOPE>');
  const legacy = xml.parse('<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS><LASTVCHID>7</LASTVCHID></RESPONSE>');

  assert.equal(xml.value(xml.findFirst(prime, 'IMPORTRESULT'), 'LASTVCHID'), '42');
  assert.equal(xml.value(xml.findFirst(legacy, 'RESPONSE'), 'LASTVCHID'), '7');
});

test('the Educational-mode date rule matches Tally: 1st, 2nd and last of month', () => {
  // An unlicensed Tally refuses any other date, reporting it as the misleading
  // "Voucher date is missing".
  assert.equal(api.isDateAllowedInEducationalMode('2026-04-01'), true);
  assert.equal(api.isDateAllowedInEducationalMode('2026-04-02'), true);
  assert.equal(api.isDateAllowedInEducationalMode('2026-04-30'), true, '30 April is the last day');
  assert.equal(api.isDateAllowedInEducationalMode('2026-04-12'), false);
  assert.equal(api.isDateAllowedInEducationalMode('2026-02-28'), true, 'February 2026 is not a leap year');
  assert.equal(api.isDateAllowedInEducationalMode('2024-02-29'), true, 'February 2024 is a leap year');
  assert.equal(api.isDateAllowedInEducationalMode('2024-02-28'), false);
});

test('an invoice with no stock lines becomes an accounting-only sale', () => {
  // The only sales form an unlicensed Tally accepts, and a legitimate voucher
  // in its own right: the sales ledger is credited directly.
  const built = requests.salesVoucher({
    company: 'X', date: '2026-04-01', party: 'Ram Traders', salesLedger: 'Sales',
    billRef: 'INV-9', total: 1180, lines: [],
    taxes: [{ ledger: 'CGST', amount: 90 }, { ledger: 'SGST', amount: 90 }],
  });

  assert.match(built, /<ISINVOICE>No<\/ISINVOICE>/);
  assert.doesNotMatch(built, /ALLINVENTORYENTRIES/);

  const entries = xml.findAll(xml.parse(built), 'ALLLEDGERENTRIES.LIST');
  const sales = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Sales');
  // 1180 total less 180 of tax leaves 1000 credited to sales.
  assert.equal(xml.value(sales, 'AMOUNT'), '1000.00');
  assert.equal(xml.value(sales, 'ISDEEMEDPOSITIVE'), 'No');
});

/* -------------------------------------------------- voucher sign convention */

test('a sales voucher debits the party and credits sales and tax', () => {
  const built = requests.salesVoucher({
    company: 'X', date: '2026-08-15', party: 'Ram Traders', salesLedger: 'Sales',
    billRef: 'INV-1', total: 5900,
    lines: [{ item: 'Pipe', quantity: 10, unit: 'Nos', rate: 500, amount: 5000 }],
    taxes: [{ ledger: 'CGST', amount: 450 }, { ledger: 'SGST', amount: 450 }],
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const party = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Ram Traders');

  // Negative amount plus ISDEEMEDPOSITIVE=Yes is how Tally spells a Debit.
  assert.equal(xml.value(party, 'AMOUNT'), '-5900.00');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'Yes');

  const bill = xml.findFirst(party, 'BILLALLOCATIONS.LIST');
  assert.equal(xml.value(bill, 'BILLTYPE'), 'New Ref');
  assert.equal(xml.value(bill, 'AMOUNT'), '-5900.00');

  const cgst = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'CGST');
  assert.equal(xml.value(cgst, 'AMOUNT'), '450.00');
  assert.equal(xml.value(cgst, 'ISDEEMEDPOSITIVE'), 'No');

  const stock = xml.findFirst(doc, 'ALLINVENTORYENTRIES.LIST');
  assert.equal(xml.value(stock, 'ACTUALQTY'), '10 Nos');
  assert.equal(xml.value(stock, 'RATE'), '500.00/Nos');
  assert.equal(xml.value(xml.findFirst(stock, 'ACCOUNTINGALLOCATIONS.LIST'), 'LEDGERNAME'), 'Sales');
});

test('a receipt credits the party against the named bill and debits cash', () => {
  const built = requests.receiptVoucher({
    company: 'X', date: '2026-08-15', party: 'Ram Traders', depositLedger: 'Cash',
    amount: 22750, againstBills: [{ name: 'INV-1042', amount: 22750 }],
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const party = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Ram Traders');
  const cash = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Cash');

  assert.equal(xml.value(party, 'AMOUNT'), '22750.00');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'No');
  assert.equal(xml.value(xml.findFirst(party, 'BILLALLOCATIONS.LIST'), 'BILLTYPE'), 'Agst Ref');
  assert.equal(xml.value(cash, 'AMOUNT'), '-22750.00');
  assert.equal(xml.value(cash, 'ISDEEMEDPOSITIVE'), 'Yes');
});

test('a receipt with no bills selected lands on account', () => {
  const built = requests.receiptVoucher({
    company: 'X', date: '2026-08-15', party: 'Ram Traders', depositLedger: 'Cash', amount: 500,
  });
  assert.match(built, /<BILLTYPE>On Account<\/BILLTYPE>/);
});

test('a purchase mirrors a sale: party credited, stock inward', () => {
  const built = requests.purchaseVoucher({
    company: 'X', date: '2026-08-01', party: 'Anand Steel Supply', purchaseLedger: 'Purchase',
    billRef: 'PUR-9', total: 11800,
    lines: [{ item: 'MS Angle 40x40', quantity: 100, unit: 'Kg', rate: 100, amount: 10000 }],
    taxes: [{ ledger: 'CGST', amount: 900 }, { ledger: 'SGST', amount: 900 }],
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const party = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Anand Steel Supply');
  const cgst = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'CGST');

  // The supplier is credited, the exact opposite of a sale.
  assert.equal(xml.value(party, 'AMOUNT'), '11800.00');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'No');
  assert.equal(xml.value(cgst, 'AMOUNT'), '-900.00', 'input tax is a debit');

  // Stock coming in is a debit on the inventory entry.
  const stock = xml.findFirst(doc, 'ALLINVENTORYENTRIES.LIST');
  assert.equal(xml.value(stock, 'AMOUNT'), '-10000.00');
  assert.equal(xml.value(stock, 'ISDEEMEDPOSITIVE'), 'Yes');
  assert.equal(xml.value(xml.findFirst(stock, 'ACCOUNTINGALLOCATIONS.LIST'), 'LEDGERNAME'), 'Purchase');
});

test('a payment mirrors a receipt: party debited, cash credited', () => {
  const built = requests.paymentVoucher({
    company: 'X', date: '2026-08-01', party: 'Anand Steel Supply', depositLedger: 'HDFC Bank',
    amount: 5000, againstBills: [{ name: 'PUR-556', amount: 5000 }],
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const party = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Anand Steel Supply');
  const bank = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'HDFC Bank');

  assert.equal(xml.value(party, 'AMOUNT'), '-5000.00', 'paying a supplier debits them');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'Yes');
  assert.equal(xml.value(bank, 'AMOUNT'), '5000.00', 'money leaving the bank is a credit');
  assert.equal(xml.value(xml.findFirst(party, 'BILLALLOCATIONS.LIST'), 'AMOUNT'), '-5000.00');
});

test('a credit note credits the customer and takes the stock back in', () => {
  const built = requests.creditNoteVoucher({
    company: 'X', date: '2026-08-01', party: 'Ram Traders', returnLedger: 'Sales',
    billRef: 'INV-1001', billType: 'Agst Ref', total: 1180,
    lines: [{ item: 'MS Pipe 1 inch', quantity: 2, unit: 'Nos', rate: 500, amount: 1000 }],
    taxes: [{ ledger: 'CGST', amount: 90 }, { ledger: 'SGST', amount: 90 }],
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const party = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Ram Traders');
  const cgst = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'CGST');

  // Goods coming back reduce what the customer owes, so they are credited.
  assert.equal(xml.value(party, 'AMOUNT'), '1180.00');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'No');
  assert.equal(xml.value(cgst, 'AMOUNT'), '-90.00', 'the tax charged is reversed');

  // It settles the original invoice rather than raising a new reference.
  const bill = xml.findFirst(party, 'BILLALLOCATIONS.LIST');
  assert.equal(xml.value(bill, 'NAME'), 'INV-1001');
  assert.equal(xml.value(bill, 'BILLTYPE'), 'Agst Ref');

  // Stock returns to the shelf: inward, so a debit on the inventory entry.
  const stock = xml.findFirst(doc, 'ALLINVENTORYENTRIES.LIST');
  assert.equal(xml.value(stock, 'AMOUNT'), '-1000.00');
  assert.equal(xml.value(stock, 'ISDEEMEDPOSITIVE'), 'Yes');
});

test('a debit note is the mirror of a credit note', () => {
  const built = requests.debitNoteVoucher({
    company: 'X', date: '2026-08-01', party: 'Anand Steel Supply', returnLedger: 'Purchase',
    billRef: 'PUR-556', billType: 'Agst Ref', total: 1000,
    lines: [{ item: 'MS Angle 40x40', quantity: 10, unit: 'Kg', rate: 100, amount: 1000 }],
    taxes: [],
  });

  const doc = xml.parse(built);
  const party = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST')
    .find((e) => xml.value(e, 'LEDGERNAME') === 'Anand Steel Supply');
  const stock = xml.findFirst(doc, 'ALLINVENTORYENTRIES.LIST');

  // Sending goods back reduces what we owe, so the supplier is debited.
  assert.equal(xml.value(party, 'AMOUNT'), '-1000.00');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'Yes');
  // The stock leaves us: outward.
  assert.equal(xml.value(stock, 'AMOUNT'), '1000.00');
  assert.equal(xml.value(stock, 'ISDEEMEDPOSITIVE'), 'No');
  assert.equal(xml.value(xml.findFirst(party, 'BILLALLOCATIONS.LIST'), 'BILLTYPE'), 'Agst Ref');
});

test('a contra debits the destination and credits the source', () => {
  const built = requests.contraVoucher({
    company: 'X', date: '2026-08-01', fromLedger: 'HDFC Bank', toLedger: 'Cash',
    amount: 5000, reference: 'CHQ-11',
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const cash = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Cash');
  const bank = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'HDFC Bank');

  assert.equal(xml.value(doc, 'ENVELOPE') !== undefined, true);
  assert.equal(xml.value(cash, 'AMOUNT'), '-5000.00', 'money arriving is a debit');
  assert.equal(xml.value(cash, 'ISDEEMEDPOSITIVE'), 'Yes');
  assert.equal(xml.value(bank, 'AMOUNT'), '5000.00', 'money leaving is a credit');
  assert.equal(xml.value(bank, 'ISDEEMEDPOSITIVE'), 'No');
  assert.doesNotMatch(built, /BILLALLOCATIONS/, 'a contra has no bills');
});

test('a journal writes each line on the side it was given', () => {
  const built = requests.journalVoucher({
    company: 'X', date: '2026-08-01', narration: 'Year end adjustment',
    entries: [
      { ledger: 'Rent', side: 'Dr', amount: 12000 },
      { ledger: 'Ram Traders', side: 'Cr', amount: 12000, billRef: 'ADJ-1' },
    ],
  });

  const doc = xml.parse(built);
  const entries = xml.findAll(doc, 'ALLLEDGERENTRIES.LIST');
  const rent = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Rent');
  const party = entries.find((e) => xml.value(e, 'LEDGERNAME') === 'Ram Traders');

  assert.equal(xml.value(rent, 'AMOUNT'), '-12000.00');
  assert.equal(xml.value(rent, 'ISDEEMEDPOSITIVE'), 'Yes');
  assert.equal(xml.value(party, 'AMOUNT'), '12000.00');
  assert.equal(xml.value(party, 'ISDEEMEDPOSITIVE'), 'No');

  // A bill-wise party line must carry its allocation, on the same side.
  const bill = xml.findFirst(party, 'BILLALLOCATIONS.LIST');
  assert.equal(xml.value(bill, 'NAME'), 'ADJ-1');
  assert.equal(xml.value(bill, 'AMOUNT'), '12000.00');
});

test('ampersands in a party name are escaped, not sent raw', () => {
  const built = requests.receiptVoucher({
    company: 'X', date: '2026-08-15', party: 'Sitaram & Co', depositLedger: 'Cash', amount: 100,
  });
  assert.match(built, /Sitaram &amp; Co/);
  assert.doesNotMatch(built, /Sitaram & Co/);
});

/* ------------------------------------------------ end to end via the mock */

test('reads and writes against a stand-in gateway', async (t) => {
  const port = 19100 + Math.floor(Math.random() * 400);
  const server = mock.start(port);
  await new Promise((resolve) => server.once('listening', resolve));

  const cfg = {
    host: '127.0.0.1',
    port,
    company: mock.COMPANY,
    timeoutMs: 10000,
    cacheMs: 0,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tallydesk-')),
  };
  t.after(() => { server.close(); api.clearCache(); });

  await t.test('receivables exclude settled bills and payables', async () => {
    const due = await api.getOutstanding(cfg, 'receivable');
    // INV-0980 has a zero balance and must not appear.
    const refs = due.parties.flatMap((p) => p.bills.map((b) => b.ref));
    assert.ok(!refs.includes('INV-0980'));
    assert.ok(!refs.some((r) => r.startsWith('PUR-')));
    assert.equal(due.total, 194950);
    assert.equal(due.parties[0].party, 'Shreeji Enterprise');
  });

  await t.test('payables are the credit-balance bills, reported as positive amounts', async () => {
    const owed = await api.getOutstanding(cfg, 'payable');
    assert.equal(owed.total, 93200);
    assert.ok(owed.parties.every((p) => p.total > 0));
  });

  await t.test('party search ranks a prefix match above a match in the middle', async () => {
    const found = await api.findParties(cfg, 'ram');
    assert.equal(found[0].name, 'Ram Traders');
    assert.ok(found.some((p) => p.name === 'Sitaram & Co'));
  });

  await t.test('a statement shows the party side of each voucher with a running balance', async () => {
    const statement = await api.getStatement(cfg, 'Ram Traders', '2026-04-01', '2026-08-15');
    assert.equal(statement.rows.length, 3);
    assert.equal(statement.rows[0].debit, 22750);
    assert.equal(statement.rows[1].credit, 18000);
    assert.equal(statement.rows[2].balance, 30750);
  });

  await t.test('an unknown item is refused before anything is sent', async () => {
    await assert.rejects(
      () => vouchers.buildSalesPreview(cfg, {
        party: 'Ram Traders', salesLedger: 'Sales',
        lines: [{ item: 'Not A Real Item', quantity: 1, rate: 10 }],
      }),
      (err) => err.problems.some((p) => /does not exist/.test(p)),
    );
  });

  await t.test('billing more than is in stock is allowed but warned about', async () => {
    const preview = await vouchers.buildSalesPreview(cfg, {
      party: 'Ram Traders', salesLedger: 'Sales',
      lines: [{ item: 'Paint Emulsion 20L', quantity: 20, rate: 4300 }],
    });
    assert.equal(preview.warnings.length, 1);
    assert.match(preview.warnings[0], /only 8/);
  });

  await t.test('a receipt whose bills do not add up to the total is refused', async () => {
    await assert.rejects(
      () => vouchers.buildReceiptPreview(cfg, {
        party: 'Ram Traders', depositLedger: 'Cash', amount: 50000,
        againstBills: [{ name: 'INV-1042', amount: 22750 }],
      }),
      (err) => err.problems.some((p) => /add up to/.test(p)),
    );
  });

  await t.test('a receipt against another party\'s bill is refused', async () => {
    await assert.rejects(
      () => vouchers.buildReceiptPreview(cfg, {
        party: 'Ram Traders', depositLedger: 'Cash', amount: 8600,
        againstBills: [{ name: 'INV-1101', amount: 8600 }],
      }),
      (err) => err.problems.some((p) => /not open for this party/.test(p)),
    );
  });

  await t.test('a contra between two of the same account is refused', async () => {
    await assert.rejects(
      () => vouchers.buildContraPreview(cfg, { fromLedger: 'Cash', toLedger: 'Cash', amount: 100 }),
      (err) => err.problems.some((p) => /two different accounts/.test(p)),
    );
  });

  await t.test('a contra involving a non-cash ledger is refused', async () => {
    await assert.rejects(
      () => vouchers.buildContraPreview(cfg, { fromLedger: 'Cash', toLedger: 'Ram Traders', amount: 100 }),
      (err) => err.problems.some((p) => /not a cash or bank account/.test(p)),
    );
  });

  await t.test('a valid contra previews both sides', async () => {
    const preview = await vouchers.buildContraPreview(cfg, {
      date: '2026-08-15', fromLedger: 'HDFC Bank', toLedger: 'Cash', amount: 5000,
    });
    assert.equal(preview.entries.find((e) => e.ledger === 'Cash').side, 'Dr');
    assert.equal(preview.entries.find((e) => e.ledger === 'HDFC Bank').side, 'Cr');
    assert.equal(preview.amount, 5000);
  });

  await t.test('an unbalanced journal is refused, naming the difference', async () => {
    await assert.rejects(
      () => vouchers.buildJournalPreview(cfg, {
        entries: [
          { ledger: 'Sales', side: 'Dr', amount: 1000 },
          { ledger: 'Purchase', side: 'Cr', amount: 900 },
        ],
      }),
      (err) => err.problems.some((p) => /difference of 100/.test(p)),
    );
  });

  await t.test('a journal that is all on one side is refused', async () => {
    await assert.rejects(
      () => vouchers.buildJournalPreview(cfg, {
        entries: [
          { ledger: 'Sales', side: 'Dr', amount: 500 },
          { ledger: 'Purchase', side: 'Dr', amount: 500 },
        ],
      }),
      (err) => err.problems.some((p) => /at least one debit line and at least one credit/.test(p)),
    );
  });

  await t.test('a journal line on a bill-wise party needs a bill reference', async () => {
    await assert.rejects(
      () => vouchers.buildJournalPreview(cfg, {
        entries: [
          { ledger: 'Ram Traders', side: 'Dr', amount: 500 },
          { ledger: 'Sales', side: 'Cr', amount: 500 },
        ],
      }),
      (err) => err.problems.some((p) => /needs a bill reference/.test(p)),
    );
  });

  await t.test('a balanced journal previews and warns about cash lines', async () => {
    const preview = await vouchers.buildJournalPreview(cfg, {
      date: '2026-08-15',
      entries: [
        { ledger: 'Ram Traders', side: 'Dr', amount: 500, billRef: 'ADJ-1' },
        { ledger: 'Cash', side: 'Cr', amount: 500 },
      ],
    });
    assert.equal(preview.totalDebit, 500);
    assert.equal(preview.totalCredit, 500);
    // Tally expects cash in a Contra/Payment/Receipt, so the preview says so.
    assert.ok(preview.warnings.some((w) => /Cash/.test(w)));
  });

  await t.test('a posted voucher is recorded in the local log', async () => {
    const before = vouchers.recentlyPosted(cfg).length;
    const { record } = await vouchers.postReceipt(cfg, {
      date: '2026-08-15', party: 'Ram Traders', depositLedger: 'Cash', amount: 22750,
      againstBills: [{ name: 'INV-1042', amount: 22750 }],
    });
    assert.equal(record.total, 22750);
    assert.equal(record.company, mock.COMPANY);
    assert.equal(vouchers.recentlyPosted(cfg).length, before + 1);
  });
});

/* ---------------------------------------------------------- day bills */

test('a day bill accumulates a customer\'s visits and totals them', (t) => {
  const cfg = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tallydesk-db-')) };

  const { bill, reused } = daybills.create(cfg, {
    party: 'Ram Traders', date: '2026-08-16', salesLedger: 'Sales', gstPercent: 18,
  });
  assert.equal(reused, false);

  // Morning: three items.
  daybills.addLines(cfg, bill.id, [
    { item: 'MS Pipe 1 inch', quantity: 2, unit: 'Nos', rate: 500 },
    { item: 'Cement OPC 53', quantity: 3, unit: 'Bag', rate: 400 },
    { item: 'Plywood 19mm', quantity: 1, unit: 'Nos', rate: 2000 },
  ]);

  // Evening: the same customer returns for four more.
  const after = daybills.addLines(cfg, bill.id, [
    { item: 'Screws 2 inch', quantity: 4, unit: 'Bag', rate: 250 },
  ]);

  assert.equal(after.lines.length, 4, 'the second visit appends, it does not replace');
  assert.equal(after.subtotal, 5200);
  assert.equal(after.taxTotal, 936);
  assert.equal(after.total, 6136);
  // The two GST halves must add back to the exact tax.
  assert.equal(after.gstSplit.cgst + after.gstSplit.sgst, after.taxTotal);
});

test('a second bill for the same customer on the same day reuses the first', () => {
  const cfg = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tallydesk-db-')) };

  const first = daybills.create(cfg, { party: 'Ram Traders', date: '2026-08-16' });
  const second = daybills.create(cfg, { party: 'Ram Traders', date: '2026-08-16' });
  assert.equal(second.reused, true);
  assert.equal(second.bill.id, first.bill.id, 'the evening visit must land on the morning bill');

  // A different day is a genuinely different bill.
  const nextDay = daybills.create(cfg, { party: 'Ram Traders', date: '2026-08-17' });
  assert.equal(nextDay.reused, false);
  assert.notEqual(nextDay.bill.id, first.bill.id);
});

test('day bills survive a restart and an unsaved one is never dropped by age', () => {
  const cfg = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tallydesk-db-')) };

  const { bill } = daybills.create(cfg, { party: 'Nova Hardware', date: '2026-08-10' });
  daybills.addLines(cfg, bill.id, [{ item: 'Screws 2 inch', quantity: 1, unit: 'Bag', rate: 250 }]);

  // Nothing cached: this reads the file back exactly as a restarted server would.
  const listedToday = daybills.list(cfg, { date: '2026-08-16' });
  assert.equal(listedToday.length, 1, 'a bill left open days ago must still show');
  assert.equal(listedToday[0].party, 'Nova Hardware');
  assert.equal(listedToday[0].total, 250);
});

test('removing a line and discarding a bill both work', () => {
  const cfg = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tallydesk-db-')) };
  const { bill } = daybills.create(cfg, { party: 'Ram Traders', date: '2026-08-16' });
  daybills.addLines(cfg, bill.id, [
    { item: 'A', quantity: 1, unit: 'Nos', rate: 100 },
    { item: 'B', quantity: 1, unit: 'Nos', rate: 200 },
  ]);

  const trimmed = daybills.removeLine(cfg, bill.id, 0);
  assert.equal(trimmed.lines.length, 1);
  assert.equal(trimmed.lines[0].item, 'B');

  daybills.discard(cfg, bill.id);
  assert.equal(daybills.list(cfg, {}).length, 0);
  assert.throws(() => daybills.removeLine(cfg, bill.id, 0), /no longer exists/);
});

test('a day bill converts into the ordinary sales payload, GST and all', () => {
  const cfg = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tallydesk-db-')) };
  const { bill } = daybills.create(cfg, {
    party: 'Ram Traders', date: '2026-08-16', salesLedger: 'Sales', gstPercent: 18, reference: 'DAY-1',
  });
  const full = daybills.addLines(cfg, bill.id, [{ item: 'MS Pipe 1 inch', quantity: 2, unit: 'Nos', rate: 500 }]);

  const payload = daybills.toSalesInput(full, ['CGST', 'SGST']);
  assert.equal(payload.party, 'Ram Traders');
  assert.equal(payload.salesLedger, 'Sales');
  assert.equal(payload.reference, 'DAY-1');
  assert.deepEqual(payload.lines, [{ item: 'MS Pipe 1 inch', quantity: 2, unit: 'Nos', rate: 500 }]);
  assert.deepEqual(payload.taxes, [{ ledger: 'CGST', amount: 90 }, { ledger: 'SGST', amount: 90 }]);

  // With no GST ledgers in the company the tax is dropped rather than guessed at.
  assert.deepEqual(daybills.toSalesInput(full, []).taxes, []);
});

test('a gateway that is not there produces an instruction, not a stack trace', async () => {
  await assert.rejects(
    () => api.getCompanies({ host: '127.0.0.1', port: 1, timeoutMs: 2000, cacheMs: 0 }),
    (err) => err.name === 'TallyError' && /Connectivity/.test(err.message),
  );
});

test('an error reported by Tally is surfaced as its message', async () => {
  const port = 19600 + Math.floor(Math.random() * 300);
  const server = mock.start(port);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    await assert.rejects(
      () => tally.request(requests.collectionEnvelope({ id: 'NoSuchThing' }), {
        host: '127.0.0.1', port, timeoutMs: 5000,
      }),
      (err) => err.code === 'TALLY_REJECTED' && /NoSuchThing/.test(err.message),
    );
  } finally {
    server.close();
  }
});
