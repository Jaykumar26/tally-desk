'use strict';

const fs = require('node:fs');
const path = require('node:path');

const tally = require('./tally');
const requests = require('./requests');
const api = require('./api');
const fmt = require('./format');
const { value, findFirst } = require('./xml');

/*
 * Creating vouchers is the only thing here that changes Tally's data, so every
 * request goes through the same three steps: validate against the real masters,
 * build a preview the user confirms, then post and record what was posted.
 *
 * Nothing is posted without an explicit confirm from the browser, and anything
 * that succeeds is appended to a local log so a mis-entry can always be traced
 * back and cancelled inside Tally.
 */

class ValidationError extends Error {
  constructor(problems) {
    super(problems.join(' '));
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

/* ------------------------------------------------------------- validation */

function requireText(problems, field, label) {
  const text = String(field || '').trim();
  if (!text) problems.push(`${label} is required.`);
  return text;
}

function requireKnown(problems, name, pool, label) {
  if (!name) return name;
  if (!pool.includes(name)) {
    problems.push(`${label} "${name}" does not exist in Tally. Pick one from the list.`);
  }
  return name;
}

/**
 * Educational-mode Tally rejects most of what an invoice needs, but reports it
 * only as an unexplained exception counter. Catching it here turns a baffling
 * silent failure into a sentence that says what to do.
 */
async function educationalModeProblems(cfg, date, { needsInventory }) {
  const licence = await api.getLicense(cfg);
  if (!licence.educational) return [];

  const problems = [];
  if (needsInventory) {
    problems.push('This Tally is unlicensed (Educational mode), which cannot save invoices that carry stock items. Activate the Tally licence, or enter this bill in Tally directly.');
  }
  if (!api.isDateAllowedInEducationalMode(date)) {
    problems.push(`Educational mode only accepts vouchers dated the 1st, 2nd or last day of a month. ${date} will be refused.`);
  }
  return problems;
}

/*
 * The four stock vouchers are one voucher in two directions, so they share a
 * validator and a builder and cannot drift apart.
 */
const TRADING_KINDS = {
  sales: {
    inward: false, ledgerField: 'salesLedger', ledgerLabel: 'Sales ledger',
    defaultType: 'Sales', billType: 'New Ref', noun: 'Invoice',
  },
  purchase: {
    inward: true, ledgerField: 'purchaseLedger', ledgerLabel: 'Purchase ledger',
    defaultType: 'Purchase', billType: 'New Ref', noun: 'Purchase',
  },
  // A customer returning goods: they are credited and the stock comes back in,
  // so it runs in the same direction as a purchase.
  creditnote: {
    inward: true, ledgerField: 'returnLedger', ledgerLabel: 'Sales return ledger',
    defaultType: 'Credit Note', billType: 'Agst Ref', noun: 'Credit note',
  },
  // Goods returned to a supplier: the mirror of a sale.
  debitnote: {
    inward: false, ledgerField: 'returnLedger', ledgerLabel: 'Purchase return ledger',
    defaultType: 'Debit Note', billType: 'Agst Ref', noun: 'Debit note',
  },
};

/** Validates one of the four and returns exactly what will be posted. */
async function buildTradingPreview(cfg, input, kind) {
  const spec = TRADING_KINDS[kind];
  if (!spec) throw new Error(`Unknown trading voucher kind "${kind}".`);
  const isPurchase = spec.inward;
  const { ledgerLabel, defaultType } = spec;

  const problems = [];
  const [ledgers, stock] = await Promise.all([api.getLedgers(cfg), api.getStock(cfg)]);
  const ledgerNames = ledgers.map((l) => l.name);
  const stockByName = new Map(stock.map((s) => [s.name, s]));

  const date = fmt.toIsoDate(input.date) || fmt.todayIso();
  const party = requireText(problems, input.party, 'Party');
  const tradeLedger = requireText(problems, input[spec.ledgerField], ledgerLabel);
  requireKnown(problems, party, ledgerNames, 'Party');
  requireKnown(problems, tradeLedger, ledgerNames, ledgerLabel);

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const lines = [];
  rawLines.forEach((line, index) => {
    const item = String(line.item || '').trim();
    if (!item) return;
    const position = `Line ${index + 1}`;

    const stockItem = stockByName.get(item);
    if (!stockItem) {
      problems.push(`${position}: item "${item}" does not exist in Tally.`);
      return;
    }
    const quantity = fmt.toNumber(line.quantity);
    const rate = fmt.toNumber(line.rate);
    if (quantity <= 0) problems.push(`${position}: quantity must be more than zero.`);
    if (rate < 0) problems.push(`${position}: rate cannot be negative.`);

    lines.push({
      item,
      quantity,
      unit: String(line.unit || stockItem.unit || '').trim(),
      rate,
      amount: fmt.money(quantity * rate),
      // Advisory only: Tally allows negative stock unless the company forbids it.
      availableQty: stockItem.quantity,
    });
  });

  if (!lines.length) problems.push('Add at least one item.');

  const taxes = (Array.isArray(input.taxes) ? input.taxes : [])
    .map((tax) => ({ ledger: String(tax.ledger || '').trim(), amount: fmt.money(tax.amount) }))
    .filter((tax) => tax.ledger && tax.amount !== 0);
  for (const tax of taxes) requireKnown(problems, tax.ledger, ledgerNames, 'Tax ledger');

  const subtotal = fmt.money(lines.reduce((sum, l) => sum + l.amount, 0));
  const taxTotal = fmt.money(taxes.reduce((sum, t) => sum + t.amount, 0));
  const total = fmt.money(subtotal + taxTotal);
  if (total <= 0) problems.push('Invoice total must be more than zero.');

  problems.push(...await educationalModeProblems(cfg, date, { needsInventory: true }));

  if (problems.length) throw new ValidationError(problems);

  // A note settles against the original bill; a fresh invoice raises a new one.
  const billType = spec.billType;
  const billRef = String(
    billType === 'Agst Ref' ? (input.againstBill || input.reference) : input.reference || '',
  ).trim();

  // Taking stock off the shelf is worth flagging; bringing it in only adds.
  const shortages = spec.inward ? [] : lines.filter((l) => l.quantity > l.availableQty);
  const partySide = isPurchase ? 'Cr' : 'Dr';
  const tradeSide = isPurchase ? 'Dr' : 'Cr';

  return {
    kind,
    date,
    voucherType: String(input.voucherType || defaultType).trim() || defaultType,
    party,
    // Echoed under the name this screen uses, so each reads the field it knows.
    tradeLedger,
    [spec.ledgerField]: tradeLedger,
    reference: String(input.reference || '').trim(),
    againstBill: billType === 'Agst Ref' ? billRef : '',
    narration: String(input.narration || '').trim(),
    lines,
    taxes,
    subtotal,
    taxTotal,
    total,
    billRef,
    billType,
    warnings: shortages.map(
      (l) => `${l.item}: only ${l.availableQty} ${l.unit} in stock, billing ${l.quantity}.`,
    ),
    // Exactly what Tally will record, shown to the user before they confirm.
    entries: [
      { ledger: party, side: partySide, amount: total },
      ...lines.map((l) => ({ ledger: tradeLedger, side: tradeSide, amount: l.amount, note: `${l.item} x ${l.quantity}` })),
      ...taxes.map((t) => ({ ledger: t.ledger, side: tradeSide, amount: t.amount })),
    ],
  };
}

const buildSalesPreview = (cfg, input) => buildTradingPreview(cfg, input, 'sales');
const buildPurchasePreview = (cfg, input) => buildTradingPreview(cfg, input, 'purchase');
const buildCreditNotePreview = (cfg, input) => buildTradingPreview(cfg, input, 'creditnote');
const buildDebitNotePreview = (cfg, input) => buildTradingPreview(cfg, input, 'debitnote');

/**
 * Validates money received or paid out. Again one function, because a payment
 * is a receipt with the two sides swapped.
 */
async function buildSettlementPreview(cfg, input, kind) {
  const isPayment = kind === 'payment';
  const accountLabel = isPayment ? 'Paid from' : 'Received into';
  const defaultType = isPayment ? 'Payment' : 'Receipt';

  const problems = [];
  const [ledgers, bills] = await Promise.all([api.getLedgers(cfg), api.getBills(cfg)]);
  const ledgerNames = ledgers.map((l) => l.name);

  const date = fmt.toIsoDate(input.date) || fmt.todayIso();
  const party = requireText(problems, input.party, 'Party');
  const depositLedger = requireText(problems, input.depositLedger, accountLabel);
  requireKnown(problems, party, ledgerNames, 'Party');
  requireKnown(problems, depositLedger, ledgerNames, 'Received into');

  const amount = fmt.money(input.amount);
  if (amount <= 0) problems.push('Amount must be more than zero.');

  // Bill knock-off is optional; when used, the parts must add up to the total.
  // A receipt settles what they owe us, a payment what we owe them.
  const wantedKind = isPayment ? 'payable' : 'receivable';
  const openRefs = new Map(
    bills
      .filter((b) => b.party === party && b.kind === wantedKind)
      .map((b) => [b.ref, Math.abs(b.amount)]),
  );
  const againstBills = (Array.isArray(input.againstBills) ? input.againstBills : [])
    .map((bill) => ({ name: String(bill.name || '').trim(), amount: fmt.money(bill.amount) }))
    .filter((bill) => bill.name && bill.amount > 0);

  for (const bill of againstBills) {
    if (!openRefs.has(bill.name)) {
      problems.push(`Bill "${bill.name}" is not open for this party.`);
    } else if (bill.amount > openRefs.get(bill.name) + 0.01) {
      problems.push(`Bill "${bill.name}" is only ${openRefs.get(bill.name)} but ${bill.amount} is being settled.`);
    }
  }

  const allocated = fmt.money(againstBills.reduce((sum, b) => sum + b.amount, 0));
  if (againstBills.length && Math.abs(allocated - amount) > 0.01) {
    problems.push(`Bills settled add up to ${allocated}, but the ${defaultType.toLowerCase()} is for ${amount}.`);
  }

  // Neither carries stock, so only the date restriction can bite here.
  problems.push(...await educationalModeProblems(cfg, date, { needsInventory: false }));

  if (problems.length) throw new ValidationError(problems);

  const onAccountNote = isPayment
    ? 'No bills selected — this will sit as an on-account debit.'
    : 'No bills selected — this will sit as an on-account credit.';

  return {
    kind,
    date,
    voucherType: String(input.voucherType || defaultType).trim() || defaultType,
    party,
    depositLedger,
    amount,
    reference: String(input.reference || '').trim(),
    narration: String(input.narration || '').trim(),
    againstBills,
    warnings: againstBills.length ? [] : [onAccountNote],
    entries: isPayment
      ? [
        { ledger: party, side: 'Dr', amount },
        { ledger: depositLedger, side: 'Cr', amount },
      ]
      : [
        { ledger: depositLedger, side: 'Dr', amount },
        { ledger: party, side: 'Cr', amount },
      ],
  };
}

const buildReceiptPreview = (cfg, input) => buildSettlementPreview(cfg, input, 'receipt');
const buildPaymentPreview = (cfg, input) => buildSettlementPreview(cfg, input, 'payment');

// Shared with the options endpoint so "what counts as cash or bank" is defined
// in exactly one place.
const { CASH_BANK_GROUPS } = api;

/**
 * A contra moves money between the business's own accounts. Tally restricts a
 * Contra voucher to cash and bank ledgers, so the same rule is applied here —
 * otherwise the voucher is refused with no useful message.
 */
async function buildContraPreview(cfg, input) {
  const problems = [];
  const ledgers = await api.getLedgers(cfg);
  const byName = new Map(ledgers.map((l) => [l.name, l]));

  const date = fmt.toIsoDate(input.date) || fmt.todayIso();
  const fromLedger = requireText(problems, input.fromLedger, 'Paid from');
  const toLedger = requireText(problems, input.toLedger, 'Paid into');

  for (const [name, label] of [[fromLedger, 'Paid from'], [toLedger, 'Paid into']]) {
    if (!name) continue;
    const ledger = byName.get(name);
    if (!ledger) {
      problems.push(`${label} "${name}" does not exist in Tally. Pick one from the list.`);
    } else if (!CASH_BANK_GROUPS.test(ledger.group)) {
      problems.push(`${label} "${name}" is not a cash or bank account. A contra can only move money between those.`);
    }
  }

  if (fromLedger && fromLedger === toLedger) {
    problems.push('The money has to move between two different accounts.');
  }

  const amount = fmt.money(input.amount);
  if (amount <= 0) problems.push('Amount must be more than zero.');

  problems.push(...await educationalModeProblems(cfg, date, { needsInventory: false }));
  if (problems.length) throw new ValidationError(problems);

  const source = byName.get(fromLedger);
  const warnings = [];
  // Advisory: Tally permits an overdraft, the company may not intend one.
  if (source && source.closing < amount && /cash-in-hand/i.test(source.group)) {
    warnings.push(`${fromLedger} shows only ${source.closing.toFixed(2)} on hand.`);
  }

  return {
    kind: 'contra',
    date,
    voucherType: String(input.voucherType || 'Contra').trim() || 'Contra',
    fromLedger,
    toLedger,
    amount,
    reference: String(input.reference || '').trim(),
    narration: String(input.narration || '').trim(),
    warnings,
    entries: [
      { ledger: toLedger, side: 'Dr', amount },
      { ledger: fromLedger, side: 'Cr', amount },
    ],
  };
}

/**
 * A journal is free-form: any ledgers, any number of lines, as long as debits
 * equal credits. The balance check is the whole point — Tally will not accept
 * an unbalanced voucher and says so unhelpfully.
 */
async function buildJournalPreview(cfg, input) {
  const problems = [];
  const ledgers = await api.getLedgers(cfg);
  const byName = new Map(ledgers.map((l) => [l.name, l]));

  const date = fmt.toIsoDate(input.date) || fmt.todayIso();
  const rawEntries = Array.isArray(input.entries) ? input.entries : [];
  const entries = [];

  rawEntries.forEach((entry, index) => {
    const ledger = String(entry.ledger || '').trim();
    if (!ledger) return;
    const position = `Line ${index + 1}`;
    const amount = fmt.money(entry.amount);
    const side = entry.side === 'Cr' ? 'Cr' : 'Dr';

    if (!byName.has(ledger)) {
      problems.push(`${position}: ledger "${ledger}" does not exist in Tally.`);
      return;
    }
    if (amount <= 0) {
      problems.push(`${position}: amount must be more than zero.`);
      return;
    }

    const master = byName.get(ledger);
    const billRef = String(entry.billRef || '').trim();
    // Tally cannot post to a bill-wise party without telling it which bill.
    if (master.billwise && !billRef) {
      problems.push(`${position}: "${ledger}" keeps bill-wise details, so it needs a bill reference.`);
    }

    entries.push({ ledger, side, amount, billRef, group: master.group });
  });

  if (entries.length < 2) problems.push('A journal needs at least two lines — one debit and one credit.');

  const totalDebit = fmt.money(entries.filter((e) => e.side === 'Dr').reduce((sum, e) => sum + e.amount, 0));
  const totalCredit = fmt.money(entries.filter((e) => e.side === 'Cr').reduce((sum, e) => sum + e.amount, 0));

  if (entries.length >= 2 && Math.abs(totalDebit - totalCredit) > 0.01) {
    const difference = fmt.money(Math.abs(totalDebit - totalCredit));
    problems.push(`Debit and credit do not match: Dr ${totalDebit.toFixed(2)} against Cr ${totalCredit.toFixed(2)}, a difference of ${difference.toFixed(2)}.`);
  }
  if (entries.length >= 2 && (totalDebit === 0 || totalCredit === 0)) {
    problems.push('A journal needs at least one debit line and at least one credit line.');
  }

  problems.push(...await educationalModeProblems(cfg, date, { needsInventory: false }));
  if (problems.length) throw new ValidationError(problems);

  const warnings = [];
  // Tally itself warns about this: cash and bank belong in Contra or Payment.
  const cashLines = entries.filter((e) => CASH_BANK_GROUPS.test(e.group));
  if (cashLines.length) {
    warnings.push(`${cashLines.map((e) => e.ledger).join(', ')} is a cash or bank account. Tally normally expects those in a Contra, Payment or Receipt rather than a journal.`);
  }

  return {
    kind: 'journal',
    date,
    voucherType: String(input.voucherType || 'Journal').trim() || 'Journal',
    reference: String(input.reference || '').trim(),
    narration: String(input.narration || '').trim(),
    entries: entries.map(({ group, ...rest }) => rest),
    totalDebit,
    totalCredit,
    total: totalDebit,
    warnings,
  };
}

/* ----------------------------------------------------------------- posting */

/**
 * Reads Tally's import receipt. It answers with counters rather than an error
 * string, so a voucher that was quietly ignored looks like success unless
 * CREATED is checked.
 *
 * TallyPrime returns these inside <IMPORTRESULT>; older Tally.ERP 9 builds use
 * <RESPONSE>. Looking for only one of them reads every counter as zero, which
 * turns a successful import into a spurious "nothing was created" error.
 */
function readImportResult(doc) {
  const response = findFirst(doc, 'IMPORTRESULT') || findFirst(doc, 'RESPONSE') || doc;
  const counters = {
    created: fmt.toNumber(value(response, 'CREATED')),
    altered: fmt.toNumber(value(response, 'ALTERED')),
    ignored: fmt.toNumber(value(response, 'IGNORED')),
    errors: fmt.toNumber(value(response, 'ERRORS')),
    exceptions: fmt.toNumber(value(response, 'EXCEPTIONS')),
    lastVoucherId: value(response, 'LASTVCHID'),
  };

  if (counters.errors > 0 || counters.exceptions > 0) {
    throw new tally.TallyError(
      'Tally rejected the voucher. Open Tally and check the company is not in Educational mode and the date falls inside the current period.',
      'IMPORT_FAILED',
      JSON.stringify(counters),
    );
  }
  if (counters.created < 1) {
    throw new tally.TallyError(
      'Tally accepted the message but did not create a voucher. This usually means a required field is switched off in the voucher type.',
      'IMPORT_IGNORED',
      JSON.stringify(counters),
    );
  }
  return counters;
}

function logFile(cfg) {
  return path.join(cfg.dataDir, 'posted-vouchers.jsonl');
}

function recordPosted(cfg, entry) {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(logFile(cfg), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    // A failed log must never hide a voucher that Tally already accepted.
    console.error('[tally-desk] could not write the voucher log:', err.message);
  }
}

/** Last N posted vouchers, newest first. */
function recentlyPosted(cfg, limit = 25) {
  try {
    const text = fs.readFileSync(logFile(cfg), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/*
 * Every voucher type posts the same way: validate into a preview, build the
 * XML, send it, check the counters, log it. Only three things vary, so they are
 * declared here rather than repeated six times.
 */
const VOUCHER_KINDS = {
  sales: {
    preview: buildSalesPreview,
    build: (r) => requests.salesVoucher(r),
    describe: (p) => ({ party: p.party, total: p.total }),
  },
  purchase: {
    preview: buildPurchasePreview,
    build: (r) => requests.purchaseVoucher(r),
    describe: (p) => ({ party: p.party, total: p.total }),
  },
  creditnote: {
    preview: buildCreditNotePreview,
    build: (r) => requests.creditNoteVoucher(r),
    describe: (p) => ({ party: p.party, total: p.total }),
  },
  debitnote: {
    preview: buildDebitNotePreview,
    build: (r) => requests.debitNoteVoucher(r),
    describe: (p) => ({ party: p.party, total: p.total }),
  },
  receipt: {
    preview: buildReceiptPreview,
    build: (r) => requests.receiptVoucher(r),
    describe: (p) => ({ party: p.party, total: p.amount }),
  },
  payment: {
    preview: buildPaymentPreview,
    build: (r) => requests.paymentVoucher(r),
    describe: (p) => ({ party: p.party, total: p.amount }),
  },
  contra: {
    preview: buildContraPreview,
    build: (r) => requests.contraVoucher(r),
    describe: (p) => ({ party: `${p.fromLedger} → ${p.toLedger}`, total: p.amount }),
  },
  journal: {
    preview: buildJournalPreview,
    build: (r) => requests.journalVoucher(r),
    describe: (p) => ({ party: p.entries.map((e) => e.ledger).join(', '), total: p.totalDebit }),
  },
};

async function postVoucher(cfg, input, kind) {
  const spec = VOUCHER_KINDS[kind];
  if (!spec) throw new Error(`Unknown voucher kind "${kind}".`);

  const preview = await spec.preview(cfg, input);
  const company = await api.activeCompany(cfg);
  const { doc } = await tally.request(spec.build({ company: cfg.company, ...preview }), cfg);
  const result = readImportResult(doc);

  api.clearCache();
  const record = {
    postedAt: new Date().toISOString(),
    kind,
    company,
    date: preview.date,
    reference: preview.reference,
    tallyVoucherId: result.lastVoucherId,
    ...spec.describe(preview),
  };
  recordPosted(cfg, record);
  return { preview, result, record };
}

const postSales = (cfg, input) => postVoucher(cfg, input, 'sales');
const postPurchase = (cfg, input) => postVoucher(cfg, input, 'purchase');
const postCreditNote = (cfg, input) => postVoucher(cfg, input, 'creditnote');
const postDebitNote = (cfg, input) => postVoucher(cfg, input, 'debitnote');
const postReceipt = (cfg, input) => postVoucher(cfg, input, 'receipt');
const postPayment = (cfg, input) => postVoucher(cfg, input, 'payment');
const postContra = (cfg, input) => postVoucher(cfg, input, 'contra');
const postJournal = (cfg, input) => postVoucher(cfg, input, 'journal');

module.exports = {
  ValidationError,
  buildSalesPreview,
  buildPurchasePreview,
  buildCreditNotePreview,
  buildDebitNotePreview,
  buildReceiptPreview,
  buildPaymentPreview,
  buildContraPreview,
  buildJournalPreview,
  postSales,
  postPurchase,
  postCreditNote,
  postDebitNote,
  postReceipt,
  postPayment,
  postContra,
  postJournal,
  postVoucher,
  recordPosted,
  recentlyPosted,
};
