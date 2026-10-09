'use strict';

const { escapeXml } = require('./xml');
const { toTallyDate, money } = require('./format');

/*
 * Builders for the XML envelopes we send to Tally.
 *
 * Two request families are used:
 *   Export + Collection — pull masters (ledgers, bills, stock) as clean data,
 *                         shaped by a small TDL block we send along with it.
 *   Import + Data       — push vouchers back in.
 *
 * Collections are preferred over Tally's built-in reports because report XML is
 * display-oriented and changes between versions; a collection returns exactly
 * the fields named in <FETCH>.
 */

function staticVariablesBlock(vars) {
  const entries = Object.entries(vars).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const lines = entries.map(([key, val]) => `<${key}>${escapeXml(val)}</${key}>`);
  return `<STATICVARIABLES>${lines.join('')}</STATICVARIABLES>`;
}

/** Wraps a TDL collection definition in the Export envelope that delivers it. */
function collectionEnvelope({ id, company, tdl, staticVars = {} }) {
  const vars = staticVariablesBlock({
    SVEXPORTFORMAT: '$$SysName:XML',
    SVCURRENTCOMPANY: company || '',
    ...staticVars,
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>',
    `<ID>${escapeXml(id)}</ID></HEADER>`,
    `<BODY><DESC>${vars}`,
    tdl ? `<TDL><TDLMESSAGE>${tdl}</TDLMESSAGE></TDL>` : '',
    '</DESC></BODY></ENVELOPE>',
  ].join('');
}

/** Envelope for one of Tally's built-in reports (Export + Data). */
function reportEnvelope({ id, company, staticVars = {} }) {
  const vars = staticVariablesBlock({
    SVEXPORTFORMAT: '$$SysName:XML',
    SVCURRENTCOMPANY: company || '',
    ...staticVars,
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>',
    `<ID>${escapeXml(id)}</ID></HEADER>`,
    `<BODY><DESC>${vars}</DESC></BODY></ENVELOPE>`,
  ].join('');
}

const COLLECTION_FLAGS = 'ISMODIFY="No" ISFIXED="No" ISINITIALIZE="Yes" ISOPTION="No" ISINTERNAL="No"';

function simpleCollection(name, type, fetch) {
  return [
    `<COLLECTION NAME="${name}" ${COLLECTION_FLAGS}>`,
    `<TYPE>${type}</TYPE>`,
    `<FETCH>${fetch.join(',')}</FETCH>`,
    '</COLLECTION>',
  ].join('');
}

/* ---------------------------------------------------------------- masters */

/**
 * Companies currently open in Tally. SVIsSimpleCompany=No asks for the full
 * list rather than just the one in focus.
 */
function companies() {
  const tdl = [
    `<COLLECTION NAME="TDCompanies" ${COLLECTION_FLAGS}>`,
    '<TYPE>Company</TYPE>',
    '<NATIVEMETHOD>Name</NATIVEMETHOD>',
    '<NATIVEMETHOD>StartingFrom</NATIVEMETHOD>',
    '<NATIVEMETHOD>EndingAt</NATIVEMETHOD>',
    '<NATIVEMETHOD>BooksFrom</NATIVEMETHOD>',
    '</COLLECTION>',
  ].join('');
  return collectionEnvelope({ id: 'TDCompanies', tdl, staticVars: { SVIsSimpleCompany: 'No' } });
}

/** Every ledger with the fields the party screens need. */
function ledgers(company) {
  const tdl = simpleCollection('TDLedgers', 'Ledger', [
    'NAME', 'PARENT', 'OPENINGBALANCE', 'CLOSINGBALANCE',
    'LEDGERPHONE', 'LEDGERMOBILE', 'EMAIL', 'LEDGERCONTACT',
    'BILLCREDITPERIOD', 'ISBILLWISEON', 'PARTYGSTIN', 'ADDRESS', 'STATENAME', 'PINCODE',
  ]);
  return collectionEnvelope({ id: 'TDLedgers', company, tdl });
}

/**
 * Bill-wise outstanding references. No TDL <FILTER> is used: filter expressions
 * differ across Tally builds and a wrong one silently returns nothing, so the
 * settled bills are dropped in Node instead where the behaviour is testable.
 */
function bills(company) {
  const tdl = simpleCollection('TDBills', 'Bills', [
    'NAME', 'PARENT', 'BILLDATE', 'CLOSINGBALANCE', 'BILLCREDITPERIOD', 'ISADVANCE',
  ]);
  return collectionEnvelope({ id: 'TDBills', company, tdl });
}

/** Stock items with closing quantity, value and rate. */
function stockItems(company) {
  const tdl = simpleCollection('TDStockItems', 'StockItem', [
    'NAME', 'PARENT', 'BASEUNITS', 'CLOSINGBALANCE', 'CLOSINGVALUE', 'CLOSINGRATE',
    'STANDARDPRICE', 'GSTAPPLICABLE', 'PARTNO', 'DESCRIPTION',
  ]);
  return collectionEnvelope({ id: 'TDStockItems', company, tdl });
}

/** Voucher types, so the invoice screen offers the ones this company actually uses. */
function voucherTypes(company) {
  const tdl = simpleCollection('TDVoucherTypes', 'VoucherType', ['NAME', 'PARENT', 'NUMBERINGMETHOD']);
  return collectionEnvelope({ id: 'TDVoucherTypes', company, tdl });
}

/**
 * Vouchers touching one party, for the statement screen.
 *
 * Tally's own "Ledger Vouchers" report returns display XML whose tags move
 * between versions. A Voucher collection with an explicit date window is
 * steadier; entries are matched to the party in Node by scanning the ledger
 * entries, which also catches journals where the party is not the main party.
 */
function partyVouchers(company, fromIso, toIso) {
  const tdl = [
    `<COLLECTION NAME="TDPartyVouchers" ${COLLECTION_FLAGS}>`,
    '<TYPE>Voucher</TYPE>',
    // Inventory entries come along too, so a saved bill can be reprinted with
    // its item lines rather than just its total.
    '<FETCH>DATE,VOUCHERTYPENAME,VOUCHERNUMBER,NARRATION,PARTYLEDGERNAME,REFERENCE,ISCANCELLED,ISOPTIONAL,ALLLEDGERENTRIES.LIST,LEDGERENTRIES.LIST,ALLINVENTORYENTRIES.LIST</FETCH>',
    '</COLLECTION>',
  ].join('');
  return collectionEnvelope({
    id: 'TDPartyVouchers',
    company,
    tdl,
    staticVars: {
      SVFROMDATE: toTallyDate(fromIso),
      SVTODATE: toTallyDate(toIso),
    },
  });
}

/**
 * Fallback statement source: Tally's built-in report. Kept because on some
 * builds a Voucher collection is refused for non-admin users while the report
 * still works.
 */
function ledgerVouchersReport(company, ledgerName, fromIso, toIso) {
  return reportEnvelope({
    id: 'Ledger Vouchers',
    company,
    staticVars: {
      SVLEDGERNAME: ledgerName,
      SVFROMDATE: toTallyDate(fromIso),
      SVTODATE: toTallyDate(toIso),
    },
  });
}

/**
 * Calls one of Tally's built-in TDL functions. Used for licence questions,
 * which are not exposed as a collection.
 */
function functionCall(name, param) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>',
    `<TYPE>Function</TYPE><ID>${escapeXml(name)}</ID></HEADER>`,
    `<BODY><DESC><FUNCPARAMLIST><PARAM>${escapeXml(param)}</PARAM></FUNCPARAMLIST></DESC></BODY>`,
    '</ENVELOPE>',
  ].join('');
}

/* --------------------------------------------------------------- vouchers */

/**
 * Import envelope for one voucher.
 *
 * Sign convention, which Tally does not document well and which is easy to get
 * backwards: a NEGATIVE amount is a Debit and carries ISDEEMEDPOSITIVE=Yes; a
 * POSITIVE amount is a Credit with ISDEEMEDPOSITIVE=No. The two must agree or
 * Tally accepts the voucher and shows it inside out.
 */
function importVoucher(company, voucherXml) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>',
    '<BODY><DESC>',
    staticVariablesBlock({ SVCURRENTCOMPANY: company || '' }),
    '</DESC><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">',
    voucherXml,
    '</TALLYMESSAGE></DATA></BODY></ENVELOPE>',
  ].join('');
}

function ledgerEntry({ ledger, amount, isDebit, billAllocations = [] }) {
  const signed = money(isDebit ? -Math.abs(amount) : Math.abs(amount));
  const bills = billAllocations
    .map((bill) => [
      '<BILLALLOCATIONS.LIST>',
      `<NAME>${escapeXml(bill.name)}</NAME>`,
      `<BILLTYPE>${escapeXml(bill.type)}</BILLTYPE>`,
      `<AMOUNT>${money(isDebit ? -Math.abs(bill.amount) : Math.abs(bill.amount)).toFixed(2)}</AMOUNT>`,
      '</BILLALLOCATIONS.LIST>',
    ].join(''))
    .join('');

  return [
    '<ALLLEDGERENTRIES.LIST>',
    `<LEDGERNAME>${escapeXml(ledger)}</LEDGERNAME>`,
    `<ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
    `<AMOUNT>${signed.toFixed(2)}</AMOUNT>`,
    bills,
    '</ALLLEDGERENTRIES.LIST>',
  ].join('');
}

/**
 * One stock line of a trading voucher.
 *
 * Stock going out (a sale) is a credit to the trading ledger: positive amount,
 * ISDEEMEDPOSITIVE=No. Stock coming in (a purchase) is the mirror image.
 */
function inventoryEntry({ item, quantity, unit, rate, amount, tradeLedger, isInward }) {
  const qtyText = `${quantity} ${unit}`.trim();
  const signed = money(isInward ? -Math.abs(amount) : Math.abs(amount)).toFixed(2);
  const deemedPositive = isInward ? 'Yes' : 'No';

  return [
    '<ALLINVENTORYENTRIES.LIST>',
    `<STOCKITEMNAME>${escapeXml(item)}</STOCKITEMNAME>`,
    `<ISDEEMEDPOSITIVE>${deemedPositive}</ISDEEMEDPOSITIVE>`,
    `<RATE>${money(rate).toFixed(2)}${unit ? `/${escapeXml(unit)}` : ''}</RATE>`,
    `<AMOUNT>${signed}</AMOUNT>`,
    `<ACTUALQTY>${escapeXml(qtyText)}</ACTUALQTY>`,
    `<BILLEDQTY>${escapeXml(qtyText)}</BILLEDQTY>`,
    '<ACCOUNTINGALLOCATIONS.LIST>',
    `<LEDGERNAME>${escapeXml(tradeLedger)}</LEDGERNAME>`,
    `<ISDEEMEDPOSITIVE>${deemedPositive}</ISDEEMEDPOSITIVE>`,
    `<AMOUNT>${signed}</AMOUNT>`,
    '</ACCOUNTINGALLOCATIONS.LIST>',
    '</ALLINVENTORYENTRIES.LIST>',
  ].join('');
}

/**
 * A sales or purchase invoice. The two are the same voucher with every sign
 * reversed, so they share one builder rather than two that can drift apart:
 *
 *   sale      party Dr, sales ledger and tax Cr, stock outward
 *   purchase  party Cr, purchase ledger and tax Dr, stock inward
 */
function tradingVoucher({
  kind,
  inward,
  company,
  date,
  voucherType,
  party,
  tradeLedger,
  reference = '',
  narration = '',
  lines = [],
  taxes = [],
  total,
  billRef = '',
  billType = 'New Ref',
}) {
  // "inward" means stock coming in and the party credited — a purchase, or a
  // credit note for goods a customer returned. Sales and debit notes are the
  // mirror of it.
  const isPurchase = inward === undefined ? kind === 'purchase' : Boolean(inward);
  const tallyDate = toTallyDate(date);

  // Without stock lines this becomes an accounting-only invoice: the trading
  // ledger is posted directly instead of through inventory allocations. It is
  // also the only form an unlicensed Tally will accept.
  const accountingOnly = lines.length === 0;
  const inventory = accountingOnly
    ? ''
    : lines.map((line) => inventoryEntry({ ...line, tradeLedger, isInward: isPurchase })).join('');
  const tradeEntry = accountingOnly
    ? ledgerEntry({
      ledger: tradeLedger,
      amount: total - taxes.reduce((sum, t) => sum + t.amount, 0),
      isDebit: isPurchase,
    })
    : '';

  const partyEntry = ledgerEntry({
    ledger: party,
    amount: total,
    isDebit: !isPurchase,
    billAllocations: billRef ? [{ name: billRef, type: billType, amount: total }] : [],
  });
  const taxEntries = taxes
    .map((tax) => ledgerEntry({ ledger: tax.ledger, amount: tax.amount, isDebit: isPurchase }))
    .join('');

  const voucher = [
    `<VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create"${accountingOnly ? '' : ' OBJVIEW="Invoice Voucher View"'}>`,
    `<DATE>${tallyDate}</DATE>`,
    `<EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
    `<PARTYLEDGERNAME>${escapeXml(party)}</PARTYLEDGERNAME>`,
    `<PARTYNAME>${escapeXml(party)}</PARTYNAME>`,
    reference ? `<REFERENCE>${escapeXml(reference)}</REFERENCE>` : '',
    narration ? `<NARRATION>${escapeXml(narration)}</NARRATION>` : '',
    accountingOnly ? '' : '<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>',
    `<ISINVOICE>${accountingOnly ? 'No' : 'Yes'}</ISINVOICE>`,
    partyEntry,
    tradeEntry,
    taxEntries,
    inventory,
    '</VOUCHER>',
  ].join('');

  return importVoucher(company, voucher);
}

/** Party debited for the total; sales and tax credited; stock issued. */
function salesVoucher({ salesLedger, voucherType = 'Sales', ...rest }) {
  return tradingVoucher({ kind: 'sales', voucherType, tradeLedger: salesLedger, ...rest });
}

/** Party credited for the total; purchase and tax debited; stock received. */
function purchaseVoucher({ purchaseLedger, voucherType = 'Purchase', ...rest }) {
  return tradingVoucher({ kind: 'purchase', voucherType, tradeLedger: purchaseLedger, ...rest });
}

/**
 * A credit note: goods a customer sent back. The customer is credited and the
 * stock comes back in, so it runs in the same direction as a purchase.
 */
function creditNoteVoucher({ returnLedger, voucherType = 'Credit Note', ...rest }) {
  return tradingVoucher({ kind: 'creditnote', inward: true, voucherType, tradeLedger: returnLedger, ...rest });
}

/**
 * A debit note: goods sent back to a supplier. The supplier is debited and the
 * stock goes out, the same direction as a sale.
 */
function debitNoteVoucher({ returnLedger, voucherType = 'Debit Note', ...rest }) {
  return tradingVoucher({ kind: 'debitnote', inward: false, voucherType, tradeLedger: returnLedger, ...rest });
}

/**
 * A receipt: cash or bank debited, party credited. When bills are supplied the
 * receipt is knocked off against them ("Agst Ref"); otherwise it lands as an
 * on-account credit.
 */
function settlementVoucher({
  kind,
  company,
  date,
  voucherType,
  party,
  depositLedger,
  amount,
  reference = '',
  narration = '',
  againstBills = [],
}) {
  const isPayment = kind === 'payment';
  const tallyDate = toTallyDate(date);

  const allocations = againstBills.length
    ? againstBills.map((bill) => ({ name: bill.name, type: 'Agst Ref', amount: bill.amount }))
    : [{ name: reference || `On Account ${tallyDate}`, type: 'On Account', amount }];

  const voucher = [
    `<VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create">`,
    `<DATE>${tallyDate}</DATE>`,
    `<EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
    `<PARTYLEDGERNAME>${escapeXml(party)}</PARTYLEDGERNAME>`,
    reference ? `<REFERENCE>${escapeXml(reference)}</REFERENCE>` : '',
    narration ? `<NARRATION>${escapeXml(narration)}</NARRATION>` : '',
    // Money in: party credited, cash/bank debited. Money out is the reverse.
    ledgerEntry({ ledger: party, amount, isDebit: isPayment, billAllocations: allocations }),
    ledgerEntry({ ledger: depositLedger, amount, isDebit: !isPayment }),
    '</VOUCHER>',
  ].join('');

  return importVoucher(company, voucher);
}

/** Money received: cash or bank debited, party credited. */
function receiptVoucher({ voucherType = 'Receipt', ...rest }) {
  return settlementVoucher({ kind: 'receipt', voucherType, ...rest });
}

/** Money paid out: party debited, cash or bank credited. */
function paymentVoucher({ voucherType = 'Payment', ...rest }) {
  return settlementVoucher({ kind: 'payment', voucherType, ...rest });
}

/**
 * A contra: money moved between the business's own cash and bank accounts.
 * The destination is debited, the source credited. No party, no bills.
 */
function contraVoucher({
  company,
  date,
  voucherType = 'Contra',
  fromLedger,
  toLedger,
  amount,
  reference = '',
  narration = '',
}) {
  const tallyDate = toTallyDate(date);
  const voucher = [
    `<VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create">`,
    `<DATE>${tallyDate}</DATE>`,
    `<EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
    reference ? `<REFERENCE>${escapeXml(reference)}</REFERENCE>` : '',
    narration ? `<NARRATION>${escapeXml(narration)}</NARRATION>` : '',
    ledgerEntry({ ledger: toLedger, amount, isDebit: true }),
    ledgerEntry({ ledger: fromLedger, amount, isDebit: false }),
    '</VOUCHER>',
  ].join('');

  return importVoucher(company, voucher);
}

/**
 * A journal: any number of debit and credit lines that balance.
 *
 * A line naming a bill-wise party carries a bill allocation, because Tally
 * cannot post to such a ledger without one and will otherwise leave the amount
 * dangling as unallocated.
 */
function journalVoucher({
  company,
  date,
  voucherType = 'Journal',
  entries = [],
  reference = '',
  narration = '',
}) {
  const tallyDate = toTallyDate(date);
  const lines = entries
    .map((entry) => ledgerEntry({
      ledger: entry.ledger,
      amount: entry.amount,
      isDebit: entry.side === 'Dr',
      billAllocations: entry.billRef
        ? [{ name: entry.billRef, type: entry.billType || 'New Ref', amount: entry.amount }]
        : [],
    }))
    .join('');

  const voucher = [
    `<VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create">`,
    `<DATE>${tallyDate}</DATE>`,
    `<EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
    reference ? `<REFERENCE>${escapeXml(reference)}</REFERENCE>` : '',
    narration ? `<NARRATION>${escapeXml(narration)}</NARRATION>` : '',
    lines,
    '</VOUCHER>',
  ].join('');

  return importVoucher(company, voucher);
}

module.exports = {
  companies,
  ledgers,
  bills,
  stockItems,
  voucherTypes,
  partyVouchers,
  ledgerVouchersReport,
  functionCall,
  salesVoucher,
  purchaseVoucher,
  creditNoteVoucher,
  debitNoteVoucher,
  receiptVoucher,
  paymentVoucher,
  contraVoucher,
  journalVoucher,
  collectionEnvelope,
  reportEnvelope,
};
