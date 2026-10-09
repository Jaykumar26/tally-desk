'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fmt = require('./format');

/*
 * Running bills for the day.
 *
 * A customer buys three things in the morning and four more at night. Rather
 * than two vouchers, the second visit is appended to the first bill, and the
 * whole thing goes to Tally once at the end of the day.
 *
 * These live only in a local file until they are saved. That is the entire
 * point — and also the risk, so:
 *   - the file is written atomically, never left half-updated by a crash
 *   - an unsaved bill is never deleted by age; it stays until saved or discarded
 *   - saving is the ordinary sales path, with the same preview and confirmation
 */

function storeFile(cfg) {
  return path.join(cfg.dataDir, 'day-bills.json');
}

function readStore(cfg) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(cfg), 'utf8'));
    return Array.isArray(parsed.bills) ? parsed : { bills: [] };
  } catch {
    // Missing or unreadable: start empty rather than crash the screen.
    return { bills: [] };
  }
}

/**
 * Writes through a temporary file and renames it into place, so an interrupted
 * write cannot leave a day's takings as a truncated JSON file.
 */
function writeStore(cfg, store) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const target = storeFile(cfg);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

let counter = 0;
function newId() {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

function lineAmount(line) {
  return fmt.money(fmt.toNumber(line.quantity) * fmt.toNumber(line.rate));
}

/** Totals a bill, including the GST split its own screen would apply. */
function summarise(bill) {
  const subtotal = fmt.money(bill.lines.reduce((sum, l) => sum + lineAmount(l), 0));
  const totalTax = bill.gstPercent ? Math.round(subtotal * bill.gstPercent) / 100 : 0;
  const cgst = Math.round(totalTax * 50) / 100;
  const sgst = Math.round((totalTax - cgst) * 100) / 100;

  return {
    ...bill,
    lines: bill.lines.map((l) => ({ ...l, amount: lineAmount(l) })),
    subtotal,
    taxTotal: fmt.money(totalTax),
    total: fmt.money(subtotal + totalTax),
    gstSplit: bill.gstPercent ? { cgst, sgst } : null,
    itemCount: bill.lines.length,
    quantityCount: bill.lines.reduce((sum, l) => sum + fmt.toNumber(l.quantity), 0),
  };
}

function list(cfg, { date } = {}) {
  const { bills } = readStore(cfg);
  // Older unsaved bills are always included: a bill left open overnight must
  // not silently disappear from the screen the next morning.
  const wanted = date ? bills.filter((b) => b.date === date || b.date < date) : bills;
  return wanted
    .map(summarise)
    .sort((a, b) => (a.date === b.date ? b.updatedAt.localeCompare(a.updatedAt) : a.date.localeCompare(b.date)));
}

function get(cfg, id) {
  const bill = readStore(cfg).bills.find((b) => b.id === id);
  return bill ? summarise(bill) : null;
}

function mutate(cfg, id, change) {
  const store = readStore(cfg);
  const index = store.bills.findIndex((b) => b.id === id);
  if (index === -1) {
    const err = new Error('That day bill no longer exists. It may already have been saved to Tally.');
    err.status = 404;
    throw err;
  }
  const updated = change({ ...store.bills[index] });
  updated.updatedAt = new Date().toISOString();
  store.bills[index] = updated;
  writeStore(cfg, store);
  return summarise(updated);
}

function create(cfg, input) {
  const party = String(input.party || '').trim();
  if (!party) {
    const err = new Error('Choose a customer for the bill.');
    err.status = 400;
    throw err;
  }

  const store = readStore(cfg);
  const date = fmt.toIsoDate(input.date) || fmt.todayIso();

  // One running bill per customer per day is the whole idea, so reuse an open
  // one rather than starting a second that would post as a separate voucher.
  const existing = store.bills.find((b) => b.party === party && b.date === date);
  if (existing) return { bill: summarise(existing), reused: true };

  const now = new Date().toISOString();
  const bill = {
    id: newId(),
    date,
    party,
    salesLedger: String(input.salesLedger || '').trim(),
    voucherType: String(input.voucherType || 'Sales').trim() || 'Sales',
    reference: String(input.reference || '').trim(),
    narration: String(input.narration || '').trim(),
    gstPercent: fmt.toNumber(input.gstPercent),
    lines: [],
    createdAt: now,
    updatedAt: now,
  };

  store.bills.push(bill);
  writeStore(cfg, store);
  return { bill: summarise(bill), reused: false };
}

/**
 * Appends a visit's items. Each line remembers when it was added, so the
 * evening's items can be told apart from the morning's on screen.
 */
function addLines(cfg, id, rawLines) {
  const lines = (Array.isArray(rawLines) ? rawLines : [])
    .map((line) => ({
      item: String(line.item || '').trim(),
      quantity: fmt.toNumber(line.quantity),
      unit: String(line.unit || '').trim(),
      rate: fmt.toNumber(line.rate),
      addedAt: new Date().toISOString(),
    }))
    .filter((line) => line.item);

  if (!lines.length) {
    const err = new Error('Add at least one item.');
    err.status = 400;
    throw err;
  }
  const bad = lines.find((l) => l.quantity <= 0);
  if (bad) {
    const err = new Error(`Quantity for "${bad.item}" must be more than zero.`);
    err.status = 400;
    throw err;
  }

  return mutate(cfg, id, (bill) => ({ ...bill, lines: [...bill.lines, ...lines] }));
}

function removeLine(cfg, id, index) {
  return mutate(cfg, id, (bill) => {
    if (index < 0 || index >= bill.lines.length) {
      const err = new Error('That line is no longer on the bill.');
      err.status = 400;
      throw err;
    }
    return { ...bill, lines: bill.lines.filter((_, i) => i !== index) };
  });
}

const EDITABLE = ['salesLedger', 'voucherType', 'reference', 'narration'];

function update(cfg, id, patch) {
  return mutate(cfg, id, (bill) => {
    const next = { ...bill };
    for (const field of EDITABLE) {
      if (typeof patch[field] === 'string') next[field] = patch[field].trim();
    }
    if (patch.gstPercent !== undefined) next.gstPercent = fmt.toNumber(patch.gstPercent);
    return next;
  });
}

function discard(cfg, id) {
  const store = readStore(cfg);
  const before = store.bills.length;
  store.bills = store.bills.filter((b) => b.id !== id);
  if (store.bills.length === before) {
    const err = new Error('That day bill no longer exists.');
    err.status = 404;
    throw err;
  }
  writeStore(cfg, store);
  return { removed: true };
}

/** Removes a bill once Tally has accepted it. */
function markSaved(cfg, id) {
  const store = readStore(cfg);
  store.bills = store.bills.filter((b) => b.id !== id);
  writeStore(cfg, store);
}

/** Shapes a day bill into the payload the ordinary sales path expects. */
function toSalesInput(bill, taxLedgers = []) {
  const summary = summarise(bill);
  const cgst = taxLedgers.find((l) => /cgst/i.test(l));
  const sgst = taxLedgers.find((l) => /sgst/i.test(l));

  const taxes = summary.gstSplit && cgst && sgst
    ? [
      { ledger: cgst, amount: summary.gstSplit.cgst },
      { ledger: sgst, amount: summary.gstSplit.sgst },
    ]
    : [];

  return {
    date: summary.date,
    party: summary.party,
    salesLedger: summary.salesLedger,
    voucherType: summary.voucherType,
    reference: summary.reference,
    narration: summary.narration,
    lines: summary.lines.map(({ item, quantity, unit, rate }) => ({ item, quantity, unit, rate })),
    taxes,
  };
}

module.exports = {
  list,
  get,
  create,
  addLines,
  removeLine,
  update,
  discard,
  markSaved,
  summarise,
  toSalesInput,
};
