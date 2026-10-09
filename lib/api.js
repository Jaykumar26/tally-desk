'use strict';

const tally = require('./tally');
const requests = require('./requests');
const xml = require('./xml');
const fmt = require('./format');

const { child, childrenNamed, findAll, findFirst, value, valueAny, textOf } = xml;

/*
 * Turns Tally's XML into the plain objects the browser consumes.
 *
 * Master collections are cached briefly: pulling every ledger and every bill
 * takes a second or two on a real company, and the screens re-read them
 * constantly while the user types in a search box.
 */

const cache = new Map();

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function clearCache() {
  cache.clear();
}

/**
 * A collection reply lists one element per object, named after the object type,
 * either directly under <ENVELOPE> or wrapped in <COLLECTION>. findAll copes
 * with both without caring which version produced it.
 */
function objects(doc, tagName) {
  return findAll(doc, tagName);
}

/**
 * The display name of a master. Tally puts it in the NAME attribute, and also
 * inside LANGUAGENAME.LIST for multi-language companies; the child <NAME>
 * element is absent on some builds, so all three are tried.
 */
function masterName(node) {
  const direct = value(node, 'NAME', '');
  if (direct) return direct;
  if (node.attrs.NAME) return node.attrs.NAME;
  const languageName = findFirst(node, 'NAME');
  return textOf(languageName);
}

function addressLines(node) {
  const list = child(node, 'ADDRESS.LIST');
  if (!list) return [];
  return childrenNamed(list, 'ADDRESS').map(textOf).filter(Boolean);
}

/* Ledger groups, named once because several screens classify by them. */
const CASH_BANK_GROUPS = /cash-in-hand|bank accounts|bank od|bank occ/i;
const SALES_GROUPS = /sales accounts/i;
const PURCHASE_GROUPS = /purchase accounts/i;

/* --------------------------------------------------------------- masters */

async function getCompanies(cfg) {
  const { doc } = await tally.request(requests.companies(), cfg);
  return objects(doc, 'COMPANY')
    .map((node) => ({
      name: masterName(node),
      booksFrom: fmt.toIsoDate(valueAny(node, ['BOOKSFROM', 'STARTINGFROM'])),
      startingFrom: fmt.toIsoDate(value(node, 'STARTINGFROM')),
      endingAt: fmt.toIsoDate(value(node, 'ENDINGAT')),
    }))
    .filter((c) => c.name);
}

/**
 * The company these requests actually land in. A blank setting means "whatever
 * is open in Tally", which is convenient but useless in an audit log, so the
 * real name is resolved before anything is recorded.
 */
async function activeCompany(cfg) {
  if (cfg.company) return cfg.company;
  return cached('activeCompany', cfg.cacheMs, async () => {
    const list = await getCompanies(cfg);
    return list.length ? list[0].name : '';
  });
}

/**
 * Whether Tally is licensed, and what that stops it doing.
 *
 * An unlicensed Tally runs in Educational mode, which silently refuses far more
 * than it explains: vouchers are only accepted on the 1st, 2nd and last day of a
 * month, and inventory entries and invoice mode are rejected outright. Tally
 * reports the refusal as EXCEPTIONS=1 with no message and, for a bad date, as
 * the misleading "Voucher date is missing". Detecting it up front is the only
 * way to say something useful about either failure.
 */
async function getLicense(cfg) {
  return cached('license', 60000, async () => {
    const read = async (param) => {
      try {
        const { doc } = await tally.request(requests.functionCall('$$LicenseInfo', param), cfg);
        const result = findFirst(doc, 'RESULT');
        const text = textOf(result);
        return /Function Execution Failed/i.test(text) ? '' : text;
      } catch {
        return '';
      }
    };

    const [educational, serial] = await Promise.all([read('IsEducationalMode'), read('SerialNumber')]);
    return {
      educational: /^yes$/i.test(educational),
      serialNumber: serial,
      // Educational mode accepts only these days of the month.
      allowedDays: /^yes$/i.test(educational) ? [1, 2, 'last'] : null,
    };
  });
}

/** True when `iso` is a day Educational-mode Tally will accept. */
function isDateAllowedInEducationalMode(iso) {
  if (!iso) return false;
  const [year, month, day] = iso.split('-').map(Number);
  if (day === 1 || day === 2) return true;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === lastDay;
}

async function getLedgers(cfg) {
  return cached(`ledgers:${cfg.company}`, cfg.cacheMs, async () => {
    const { doc } = await tally.request(requests.ledgers(cfg.company), cfg);
    return objects(doc, 'LEDGER')
      .map((node) => {
        return {
          name: masterName(node),
          group: value(node, 'PARENT'),
          // Tally exports balances credit-positive: a Debit balance arrives as a
          // NEGATIVE number, the same convention as voucher amounts. Verified
          // against TallyPrime — a debtor we had invoiced came back negative and
          // the Sales ledger came back positive. Flipped here so that everything
          // downstream can read positive as Debit, which is how a shop thinks
          // about it: positive means the party owes us.
          closing: -fmt.toNumber(value(node, 'CLOSINGBALANCE')),
          opening: -fmt.toNumber(value(node, 'OPENINGBALANCE')),
          phone: valueAny(node, ['LEDGERMOBILE', 'LEDGERPHONE']),
          contact: value(node, 'LEDGERCONTACT'),
          email: value(node, 'EMAIL'),
          gstin: value(node, 'PARTYGSTIN'),
          state: value(node, 'STATENAME'),
          pincode: value(node, 'PINCODE'),
          address: addressLines(node),
          creditDays: fmt.creditPeriodToDays(value(node, 'BILLCREDITPERIOD')),
          billwise: /yes/i.test(value(node, 'ISBILLWISEON')),
        };
      })
      .filter((l) => l.name);
  });
}

async function getStock(cfg) {
  return cached(`stock:${cfg.company}`, cfg.cacheMs, async () => {
    const { doc } = await tally.request(requests.stockItems(cfg.company), cfg);
    return objects(doc, 'STOCKITEM')
      .map((node) => {
        const balance = fmt.toQuantity(value(node, 'CLOSINGBALANCE'));
        const rate = fmt.toRate(value(node, 'CLOSINGRATE'));
        const standard = fmt.toRate(value(node, 'STANDARDPRICE'));
        const unit = value(node, 'BASEUNITS') || balance.unit || rate.unit;
        return {
          name: masterName(node),
          group: value(node, 'PARENT'),
          unit,
          quantity: balance.qty,
          value: fmt.toNumber(value(node, 'CLOSINGVALUE')),
          rate: rate.rate,
          standardPrice: standard.rate,
          partNo: value(node, 'PARTNO'),
          description: value(node, 'DESCRIPTION'),
        };
      })
      .filter((s) => s.name);
  });
}

async function getVoucherTypes(cfg) {
  return cached(`vchtypes:${cfg.company}`, cfg.cacheMs, async () => {
    const { doc } = await tally.request(requests.voucherTypes(cfg.company), cfg);
    return objects(doc, 'VOUCHERTYPE')
      .map((node) => ({ name: masterName(node), parent: value(node, 'PARENT') }))
      .filter((v) => v.name);
  });
}

/* ----------------------------------------------------------- outstanding */

/**
 * Pending bill references, newest information first.
 *
 * Every bill Tally knows about comes back, including settled ones with a zero
 * balance; those are dropped here rather than in a TDL filter (see requests.js).
 */
async function getBills(cfg) {
  return cached(`bills:${cfg.company}`, cfg.cacheMs, async () => {
    const { doc } = await tally.request(requests.bills(cfg.company), cfg);
    const today = fmt.todayIso();

    // The collection is asked for by the type name "Bills", but TallyPrime
    // returns each object as <BILL>. Both spellings are accepted so a build
    // that uses the plural still works.
    const nodes = [...objects(doc, 'BILL'), ...objects(doc, 'BILLS')];

    return nodes
      .map((node) => {
        // Credit-positive, as with ledger balances: flip so that a positive
        // amount means the party owes us.
        const amount = -fmt.toNumber(value(node, 'CLOSINGBALANCE'));
        const date = fmt.toIsoDate(value(node, 'BILLDATE'));
        const creditDays = fmt.creditPeriodToDays(value(node, 'BILLCREDITPERIOD'));
        const dueDate = creditDays !== null && date ? fmt.addDays(date, creditDays) : date;
        return {
          ref: masterName(node),
          party: value(node, 'PARENT'),
          date,
          dueDate,
          amount,
          // Positive = the party owes us (Debit); negative = we owe them.
          kind: amount >= 0 ? 'receivable' : 'payable',
          age: fmt.daysBetween(date, today),
          overdueBy: Math.max(0, fmt.daysBetween(dueDate, today) || 0),
          isAdvance: /yes/i.test(value(node, 'ISADVANCE')),
        };
      })
      .filter((b) => b.party && Math.abs(b.amount) >= 0.01);
  });
}

const AGEING_BUCKETS = [
  { label: 'Not due', max: 0 },
  { label: '1-30 days', max: 30 },
  { label: '31-60 days', max: 60 },
  { label: '61-90 days', max: 90 },
  { label: 'Over 90 days', max: Infinity },
];

function bucketFor(overdueBy) {
  return AGEING_BUCKETS.find((b) => overdueBy <= b.max).label;
}

/** Outstanding bills grouped by party, biggest balance first. */
async function getOutstanding(cfg, kind = 'receivable') {
  const bills = await getBills(cfg);
  const wanted = bills.filter((b) => b.kind === kind);

  const byParty = new Map();
  for (const bill of wanted) {
    if (!byParty.has(bill.party)) {
      byParty.set(bill.party, { party: bill.party, total: 0, overdue: 0, oldestAge: 0, bills: [] });
    }
    const group = byParty.get(bill.party);
    const magnitude = Math.abs(bill.amount);
    group.total += magnitude;
    if (bill.overdueBy > 0) group.overdue += magnitude;
    group.oldestAge = Math.max(group.oldestAge, bill.age || 0);
    group.bills.push({ ...bill, amount: magnitude, bucket: bucketFor(bill.overdueBy) });
  }

  const parties = [...byParty.values()].sort((a, b) => b.total - a.total);
  for (const group of parties) group.bills.sort((a, b) => (a.date < b.date ? -1 : 1));

  const ageing = AGEING_BUCKETS.map((bucket) => ({
    label: bucket.label,
    amount: wanted
      .filter((b) => bucketFor(b.overdueBy) === bucket.label)
      .reduce((sum, b) => sum + Math.abs(b.amount), 0),
  })).filter((b) => b.amount > 0);

  return {
    kind,
    total: parties.reduce((sum, p) => sum + p.total, 0),
    overdue: parties.reduce((sum, p) => sum + p.overdue, 0),
    partyCount: parties.length,
    ageing,
    parties,
  };
}

/* ---------------------------------------------------------------- parties */

const PARTY_GROUPS = /sundry (debtors|creditors)|debtors|creditors/i;

function isPartyLedger(ledger) {
  return PARTY_GROUPS.test(ledger.group || '');
}

function normalise(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Ranked substring search. Exact prefix beats a word-start match, which beats a
 * match anywhere — so typing "ram" puts "Ram Traders" above "Sitaram & Co".
 */
function search(items, query, keyOf, limit = 50) {
  const needle = normalise(query);
  if (!needle) return items.slice(0, limit);

  const scored = [];
  for (const item of items) {
    const hay = normalise(keyOf(item));
    if (!hay.includes(needle)) continue;
    let score = 2;
    if (hay.startsWith(needle)) score = 0;
    else if (hay.includes(` ${needle}`)) score = 1;
    scored.push({ item, score, length: hay.length });
  }

  scored.sort((a, b) => a.score - b.score || a.length - b.length);
  return scored.slice(0, limit).map((s) => s.item);
}

async function findParties(cfg, query, { partiesOnly = true, limit = 50 } = {}) {
  const ledgers = await getLedgers(cfg);
  const pool = partiesOnly ? ledgers.filter(isPartyLedger) : ledgers;
  return search(pool, query, (l) => l.name, limit);
}

async function getParty(cfg, name) {
  const [ledgers, bills] = await Promise.all([getLedgers(cfg), getBills(cfg)]);
  const ledger = ledgers.find((l) => l.name === name)
    || ledgers.find((l) => normalise(l.name) === normalise(name));
  if (!ledger) return null;

  const partyBills = bills
    .filter((b) => b.party === ledger.name)
    .map((b) => ({ ...b, bucket: bucketFor(b.overdueBy) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    ...ledger,
    bills: partyBills,
    billsTotal: partyBills.reduce((sum, b) => sum + b.amount, 0),
  };
}

/* -------------------------------------------------------------- statement */

/**
 * The party's side of every voucher in the window.
 *
 * Each voucher is scanned for a ledger entry naming the party, so a journal or
 * a contra that touches the party is picked up even though its PARTYLEDGERNAME
 * says otherwise. Negative entry amounts are Debits.
 */
async function getStatement(cfg, name, fromIso, toIso) {
  const { doc } = await tally.request(requests.partyVouchers(cfg.company, fromIso, toIso), cfg);
  const target = normalise(name);
  const rows = [];

  for (const node of objects(doc, 'VOUCHER')) {
    if (/yes/i.test(value(node, 'ISCANCELLED'))) continue;
    if (/yes/i.test(value(node, 'ISOPTIONAL'))) continue;

    const entries = [
      ...findAll(node, 'ALLLEDGERENTRIES.LIST'),
      ...findAll(node, 'LEDGERENTRIES.LIST'),
    ];
    const mine = entries.filter((entry) => normalise(value(entry, 'LEDGERNAME')) === target);
    if (!mine.length) continue;

    const amount = mine.reduce((sum, entry) => sum + fmt.toNumber(value(entry, 'AMOUNT')), 0);
    const counterparties = entries
      .map((entry) => value(entry, 'LEDGERNAME'))
      .filter((ledgerName) => normalise(ledgerName) !== target);

    rows.push({
      date: fmt.toIsoDate(value(node, 'DATE')),
      voucherType: value(node, 'VOUCHERTYPENAME'),
      voucherNo: value(node, 'VOUCHERNUMBER'),
      reference: value(node, 'REFERENCE'),
      narration: value(node, 'NARRATION'),
      against: [...new Set(counterparties)].slice(0, 3).join(', '),
      debit: amount < 0 ? Math.abs(amount) : 0,
      credit: amount > 0 ? amount : 0,
    });
  }

  rows.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));

  let running = 0;
  for (const row of rows) {
    running += row.debit - row.credit;
    row.balance = running;
  }

  const ledgers = await getLedgers(cfg);
  const ledger = ledgers.find((l) => normalise(l.name) === target);

  return {
    party: ledger ? ledger.name : name,
    from: fromIso,
    to: toIso,
    closing: ledger ? ledger.closing : null,
    totalDebit: rows.reduce((sum, r) => sum + r.debit, 0),
    totalCredit: rows.reduce((sum, r) => sum + r.credit, 0),
    rows,
  };
}

/* ------------------------------------------------------- one saved bill */

/** Reads the item lines off a saved voucher. */
function inventoryLines(node) {
  return findAll(node, 'ALLINVENTORYENTRIES.LIST').map((entry) => {
    const billed = fmt.toQuantity(valueAny(entry, ['BILLEDQTY', 'ACTUALQTY']));
    const rate = fmt.toRate(value(entry, 'RATE'));
    return {
      item: value(entry, 'STOCKITEMNAME'),
      quantity: Math.abs(billed.qty),
      unit: billed.unit || rate.unit,
      rate: rate.rate,
      amount: Math.abs(fmt.toNumber(value(entry, 'AMOUNT'))),
      // Which ledger the value went to, so it is not double-counted as a charge.
      ledger: value(findFirst(entry, 'ACCOUNTINGALLOCATIONS.LIST'), 'LEDGERNAME'),
    };
  }).filter((l) => l.item);
}

/**
 * Turns one voucher element into the shape a printed bill needs: the party,
 * the items, and any tax or charge lines that are not already accounted for
 * inside the item allocations.
 */
function voucherDetail(node) {
  const party = value(node, 'PARTYLEDGERNAME');
  const entries = [
    ...findAll(node, 'ALLLEDGERENTRIES.LIST'),
    ...findAll(node, 'LEDGERENTRIES.LIST'),
  ];
  const lines = inventoryLines(node);
  const itemLedgers = new Set(lines.map((l) => l.ledger).filter(Boolean));

  const partyEntry = entries.find((e) => value(e, 'LEDGERNAME') === party);
  const total = partyEntry ? Math.abs(fmt.toNumber(value(partyEntry, 'AMOUNT'))) : 0;

  // Everything that is not the party and not the ledger the items already went
  // to: GST, freight, rounding. These print under the item list.
  const charges = entries
    .filter((e) => {
      const ledger = value(e, 'LEDGERNAME');
      return ledger && ledger !== party && !itemLedgers.has(ledger);
    })
    .map((e) => ({
      ledger: value(e, 'LEDGERNAME'),
      amount: Math.abs(fmt.toNumber(value(e, 'AMOUNT'))),
    }))
    .filter((c) => c.amount > 0);

  const subtotal = lines.length
    ? fmt.money(lines.reduce((sum, l) => sum + l.amount, 0))
    : fmt.money(total - charges.reduce((sum, c) => sum + c.amount, 0));

  return {
    date: fmt.toIsoDate(value(node, 'DATE')),
    voucherType: value(node, 'VOUCHERTYPENAME'),
    voucherNumber: value(node, 'VOUCHERNUMBER'),
    reference: value(node, 'REFERENCE'),
    narration: value(node, 'NARRATION'),
    party,
    lines,
    charges,
    subtotal,
    total: fmt.money(total),
    // An accounting-only voucher has no stock lines; the caller shows the
    // charge lines as the body instead of an empty table.
    hasItems: lines.length > 0,
  };
}

/**
 * Finds one saved voucher so it can be reprinted, matched either on its own
 * reference or on the bill reference it raised.
 *
 * Searches the voucher's own date first — a shop can have thousands in a year
 * and pulling the whole window to find one bill is wasteful — then widens to
 * the financial year if that misses.
 */
async function findVoucher(cfg, { reference, party, date }) {
  const wanted = String(reference || '').trim().toLowerCase();
  if (!wanted) return null;

  const year = fmt.financialYear(date || fmt.todayIso());
  const windows = [];
  if (date) windows.push([date, date]);
  windows.push([year.from, year.to]);

  for (const [from, to] of windows) {
    const { doc } = await tally.request(requests.partyVouchers(cfg.company, from, to), cfg);

    for (const node of objects(doc, 'VOUCHER')) {
      if (/yes/i.test(value(node, 'ISCANCELLED'))) continue;
      if (party && value(node, 'PARTYLEDGERNAME') !== party) continue;

      const ownRef = value(node, 'REFERENCE').trim().toLowerCase();
      const billRefs = findAll(node, 'BILLALLOCATIONS.LIST')
        .map((b) => value(b, 'NAME').trim().toLowerCase());

      if (ownRef === wanted || billRefs.includes(wanted)) return voucherDetail(node);
    }
  }
  return null;
}

/* ------------------------------------------------------------ day summary */

/**
 * Everything entered on one day, grouped the way a shopkeeper closes up:
 * what was sold, what came in, what went out, and where the cash stands.
 *
 * Built from the day's vouchers rather than a Tally report, because a Voucher
 * collection returns the same fields on every build while report XML does not.
 */
async function getDaySummary(cfg, dateIso) {
  const { doc } = await tally.request(requests.partyVouchers(cfg.company, dateIso, dateIso), cfg);

  const byType = new Map();
  const entries = [];

  for (const node of objects(doc, 'VOUCHER')) {
    if (/yes/i.test(value(node, 'ISCANCELLED'))) continue;
    if (/yes/i.test(value(node, 'ISOPTIONAL'))) continue;

    const date = fmt.toIsoDate(value(node, 'DATE'));
    if (date !== dateIso) continue;

    const lines = [
      ...findAll(node, 'ALLLEDGERENTRIES.LIST'),
      ...findAll(node, 'LEDGERENTRIES.LIST'),
    ];
    // A balanced voucher's credits equal its debits, so either side is its
    // value. Credits are the positive amounts.
    const total = fmt.money(
      lines.reduce((sum, entry) => {
        const amount = fmt.toNumber(value(entry, 'AMOUNT'));
        return amount > 0 ? sum + amount : sum;
      }, 0),
    );

    const type = value(node, 'VOUCHERTYPENAME') || 'Other';
    if (!byType.has(type)) byType.set(type, { type, count: 0, total: 0 });
    const group = byType.get(type);
    group.count += 1;
    group.total = fmt.money(group.total + total);

    entries.push({
      type,
      voucherNo: value(node, 'VOUCHERNUMBER'),
      party: value(node, 'PARTYLEDGERNAME'),
      reference: value(node, 'REFERENCE'),
      narration: value(node, 'NARRATION'),
      total,
    });
  }

  const ledgers = await getLedgers(cfg);
  const cashBank = ledgers
    .filter((l) => CASH_BANK_GROUPS.test(l.group))
    .map((l) => ({ name: l.name, group: l.group, balance: l.closing }))
    .sort((a, b) => b.balance - a.balance);

  const totalFor = (pattern) => [...byType.values()]
    .filter((g) => pattern.test(g.type))
    .reduce((sum, g) => sum + g.total, 0);

  return {
    date: dateIso,
    voucherCount: entries.length,
    byType: [...byType.values()].sort((a, b) => b.total - a.total),
    entries,
    sales: fmt.money(totalFor(/sale/i)),
    purchases: fmt.money(totalFor(/purchase/i)),
    received: fmt.money(totalFor(/receipt/i)),
    paid: fmt.money(totalFor(/payment/i)),
    cashBank,
    cashBankTotal: fmt.money(cashBank.reduce((sum, l) => sum + l.balance, 0)),
  };
}

/* ------------------------------------------------------------ voucher aids */


/** The ledger and voucher-type choices the entry screens offer. */
async function getVoucherOptions(cfg) {
  const [ledgers, types] = await Promise.all([getLedgers(cfg), getVoucherTypes(cfg)]);
  const named = (pattern) => types.filter((t) => pattern.test(t.parent) || pattern.test(t.name)).map((t) => t.name);

  return {
    parties: ledgers.filter(isPartyLedger).map((l) => ({ name: l.name, closing: l.closing })),
    salesLedgers: ledgers.filter((l) => SALES_GROUPS.test(l.group)).map((l) => l.name),
    purchaseLedgers: ledgers.filter((l) => PURCHASE_GROUPS.test(l.group)).map((l) => l.name),
    depositLedgers: ledgers.filter((l) => CASH_BANK_GROUPS.test(l.group)).map((l) => l.name),
    taxLedgers: ledgers.filter((l) => /duties & taxes/i.test(l.group)).map((l) => l.name),
    // A journal may touch any ledger, so it gets the full list along with the
    // bill-wise flag, which decides whether a line needs a bill reference.
    allLedgers: ledgers.map((l) => ({
      name: l.name, group: l.group, billwise: l.billwise, closing: l.closing,
    })),
    salesTypes: named(/^sales$/i),
    purchaseTypes: named(/^purchase$/i),
    creditNoteTypes: named(/^credit note$/i),
    debitNoteTypes: named(/^debit note$/i),
    receiptTypes: named(/^receipt$/i),
    paymentTypes: named(/^payment$/i),
    contraTypes: named(/^contra$/i),
    journalTypes: named(/^journal$/i),
  };
}

module.exports = {
  clearCache,
  getCompanies,
  activeCompany,
  getLicense,
  isDateAllowedInEducationalMode,
  getLedgers,
  getStock,
  getVoucherTypes,
  getBills,
  getOutstanding,
  getDaySummary,
  findVoucher,
  findParties,
  getParty,
  getStatement,
  getVoucherOptions,
  search,
  isPartyLedger,
  CASH_BANK_GROUPS,
};
