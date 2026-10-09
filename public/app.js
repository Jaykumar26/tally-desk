'use strict';

/*
 * Tally Desk — browser side.
 *
 * Everything reads from the local server, which does the talking to Tally.
 * Two rules shape this file:
 *   1. Nothing is written to Tally without a preview the user confirms.
 *   2. Any failure is shown in plain words, never as a status code.
 *
 * All user-facing wording lives in LABELS so the screens can be translated
 * without hunting through the logic.
 */

const LABELS = {
  connected: 'Tally connected',
  disconnected: 'Tally not connected',
  checking: 'Checking…',
  loading: 'Loading…',
  nothingDue: 'Nothing pending. All bills are settled.',
  noResults: 'Nothing matched that search.',
  saved: 'Saved in Tally',
};

/* ------------------------------------------------------------- utilities */

const $ = (id) => document.getElementById(id);

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const money = (n) => INR.format(Number(n) || 0);
const qty = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(Number(n) || 0);

function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Renders an ISO date as 15-Aug-2026, which is how Tally itself shows dates. */
function showDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d}-${months[Number(m) - 1] || m}-${y}`;
}

function todayIso() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

/** Calls the local server and turns any failure into a thrown Error with a readable message. */
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new Error('The Tally Desk program is not running. Close this tab and start it again.');
  }

  const payload = await response.json().catch(() => ({ error: 'The reply from the program could not be read.' }));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.problems = payload.problems;
    error.detail = payload.detail;
    throw error;
  }
  return payload;
}

let toastTimer = null;
function toast(message, bad = false) {
  const host = $('toast');
  host.innerHTML = `<div class="msg${bad ? ' bad' : ''}">${esc(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.innerHTML = ''; }, bad ? 8000 : 4000);
}

function noticeHtml(kind, title, lines = []) {
  const list = lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  return `<div class="notice ${kind}"><strong>${esc(title)}</strong>${list}</div>`;
}

function showError(hostId, err) {
  $(hostId).innerHTML = noticeHtml('error', err.message, err.problems || []);
}

function clearNode(hostId) {
  $(hostId).innerHTML = '';
}

function spinner(hostId) {
  $(hostId).innerHTML = `<p class="empty"><span class="spin">◠</span> ${LABELS.loading}</p>`;
}

/** Promise-based confirmation modal. Resolves true only on the confirm button. */
function confirmModal({ title, bodyHtml, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const host = $('modalHost');
    host.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal">
          <h2>${esc(title)}</h2>
          ${bodyHtml}
          <div class="actions">
            <button class="btn" data-act="cancel">Go back</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;

    const close = (result) => {
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };

    host.querySelector('[data-act="cancel"]').onclick = () => close(false);
    host.querySelector('[data-act="ok"]').onclick = () => close(true);
    host.querySelector('.modal-backdrop').onclick = (e) => {
      if (e.target.classList.contains('modal-backdrop')) close(false);
    };
    document.addEventListener('keydown', onKey);
    host.querySelector('[data-act="ok"]').focus();
  });
}

/** Waits for typing to stop before searching, so every keystroke is not a request. */
function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------------------------------------------ state */

const state = {
  connected: false,
  company: '',
  outstanding: { kind: 'receivable', data: null, filter: '' },
  parties: [],
  stock: [],
  options: null,
  licence: {},
  selectedParty: null,
  dayBills: [],
  diagnostic: null,
};

/* ----------------------------------------------------------- text scaling */

function applyTextScale(step) {
  const clamped = Math.min(1.6, Math.max(0.85, step));
  document.documentElement.style.setProperty('--step', clamped);
  localStorage.setItem('tallydesk.textScale', String(clamped));
  return clamped;
}

let textScale = applyTextScale(Number(localStorage.getItem('tallydesk.textScale')) || 1);
$('textBigger').onclick = () => { textScale = applyTextScale(textScale + 0.1); };
$('textSmaller').onclick = () => { textScale = applyTextScale(textScale - 0.1); };

/* ------------------------------------------------------------------- tabs */

// Each loader is wrapped rather than referenced directly: several are const
// arrows defined further down the file, and naming them here would read them
// before they exist.
const VIEW_LOADERS = {
  outstanding: () => loadOutstanding(),
  parties: () => renderPartyResults(''),
  stock: () => loadStock(),
  daybills: () => loadDayBills(),
  dayend: () => loadDayEnd(),
  invoice: () => loadInvoiceView(),
  purchase: () => loadPurchaseView(),
  creditnote: () => loadCreditNoteView(),
  debitnote: () => loadDebitNoteView(),
  receipt: () => loadReceiptView(),
  payment: () => loadPaymentView(),
  contra: () => loadContraView(),
  journal: () => loadJournalView(),
  settings: () => loadSettings(),
};

// The same function keys Tally uses for these vouchers, so the habit carries
// over. F1 is left alone because the browser owns help, and Payment moves to
// Alt+F5 because F5 alone reloads the page.
const VIEW_KEYS = { F4: 'contra', F6: 'receipt', F7: 'journal', F8: 'invoice', F9: 'purchase' };
const ALT_VIEW_KEYS = { F5: 'payment' };
// Tally puts the two notes on Ctrl+F8 and Ctrl+F9.
const CTRL_VIEW_KEYS = { F8: 'creditnote', F9: 'debitnote' };

// What the breadcrumb strip calls each screen.
const SCREEN_TITLES = {
  outstanding: 'Money Due',
  parties: 'Parties',
  stock: 'Stock Summary',
  daybills: 'Day Bills',
  dayend: 'Day End Summary',
  invoice: 'Sales Voucher',
  purchase: 'Purchase Voucher',
  creditnote: 'Credit Note',
  debitnote: 'Debit Note',
  receipt: 'Receipt Voucher',
  payment: 'Payment Voucher',
  contra: 'Contra Voucher',
  journal: 'Journal Voucher',
  settings: 'Configuration',
};

function showView(name) {
  $('screenTitle').textContent = SCREEN_TITLES[name] || name;
  for (const tab of $('tabs').querySelectorAll('button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  }
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${name}`;
  }
  location.hash = name;
  const load = VIEW_LOADERS[name];
  if (load) load();
}

$('tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-view]');
  if (button) showView(button.dataset.view);
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey) return;
  let view;
  if (e.ctrlKey) view = CTRL_VIEW_KEYS[e.key];
  else if (e.altKey) view = ALT_VIEW_KEYS[e.key];
  else view = VIEW_KEYS[e.key];
  if (!view) return;
  e.preventDefault();
  showView(view);
});

/* ----------------------------------------------------------------- status */

async function refreshStatus() {
  const pill = $('statusPill');
  const text = $('statusText');
  pill.className = 'pill busy';
  text.textContent = LABELS.checking;

  try {
    const status = await api('/api/status');
    state.connected = status.connected;
    state.company = status.company;

    if (status.connected) {
      pill.className = 'pill ok';
      text.textContent = LABELS.connected;
      $('companyLabel').textContent = status.company || 'No company selected';
      $('gatewayLabel').textContent = `Tally at ${status.gateway}`;
      state.licence = status.licence || {};

      // An unlicensed Tally refuses most writes without saying why, so say it here.
      $('globalError').innerHTML = state.licence.educational
        ? noticeHtml('warn', 'This Tally is unlicensed (Educational mode). Reading works fully; saving is limited:', [
          'Bills with stock items cannot be saved — Tally refuses them.',
          'Vouchers are only accepted dated the 1st, 2nd or last day of a month.',
          'Receipts on those dates work normally.',
        ])
        : '';
    } else {
      pill.className = 'pill bad';
      text.textContent = LABELS.disconnected;
      $('companyLabel').textContent = '—';
      // Most useful precisely when it is not connecting: say where it tried.
      $('gatewayLabel').textContent = `Tally at ${status.gateway}`;
      $('globalError').innerHTML = noticeHtml('error', status.error, [
        'Open TallyPrime and load the company.',
        'Press F1 → Settings → Connectivity and set "TallyPrime acts as" to Both.',
        'If Tally is showing a dialog box on screen, close it.',
      ]);
    }
  } catch (err) {
    pill.className = 'pill bad';
    text.textContent = LABELS.disconnected;
    $('globalError').innerHTML = noticeHtml('error', err.message);
  }
  return state.connected;
}

$('statusPill').onclick = async () => {
  if (await refreshStatus()) {
    await api('/api/refresh', { method: 'POST', body: '{}' });
    showView(location.hash.slice(1) || 'outstanding');
  }
};

/* ------------------------------------------------------------ Money Due */

function ageTag(bill) {
  if (bill.overdueBy > 60) return `<span class="tag late">${bill.overdueBy} days late</span>`;
  if (bill.overdueBy > 0) return `<span class="tag soon">${bill.overdueBy} days late</span>`;
  return '<span class="tag fine">Not due</span>';
}

function renderOutstanding() {
  const data = state.outstanding.data;
  if (!data) return;

  const owedLabel = data.kind === 'receivable' ? 'They owe us' : 'We owe them';
  $('outstandingTiles').innerHTML = [
    `<div class="tile"><div class="label">${esc(owedLabel)}</div><div class="figure">${money(data.total)}</div></div>`,
    `<div class="tile ${data.overdue > 0 ? 'bad' : ''}"><div class="label">Overdue</div><div class="figure">${money(data.overdue)}</div></div>`,
    `<div class="tile"><div class="label">Parties</div><div class="figure">${data.partyCount}</div></div>`,
  ].join('');

  $('outstandingAgeing').innerHTML = data.ageing.length
    ? `<div class="card"><h3 style="margin-top:0">By age</h3><div class="tiles">${
      data.ageing.map((b) => `<div class="tile ${/90|61/.test(b.label) ? 'warn' : ''}">
        <div class="label">${esc(b.label)}</div><div class="figure">${money(b.amount)}</div></div>`).join('')
    }</div></div>`
    : '';

  const needle = state.outstanding.filter.trim().toLowerCase();
  const parties = needle
    ? data.parties.filter((p) => p.party.toLowerCase().includes(needle))
    : data.parties;

  if (!parties.length) {
    $('outstandingList').innerHTML = `<p class="empty">${needle ? LABELS.noResults : LABELS.nothingDue}</p>`;
    return;
  }

  $('outstandingList').innerHTML = parties.map((group) => `
    <details class="party">
      <summary>
        <span>${esc(group.party)}</span>
        ${group.overdue > 0 ? `<span class="tag late">${money(group.overdue)} overdue</span>` : ''}
        <span class="amount">${money(group.total)}</span>
      </summary>
      <div class="body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Bill</th><th>Date</th><th>Due</th><th>Status</th>
              <th class="num">Amount</th><th></th></tr></thead>
            <tbody>
              ${group.bills.map((bill) => `
                <tr>
                  <td>${esc(bill.ref)}</td>
                  <td>${showDate(bill.date)}</td>
                  <td>${showDate(bill.dueDate)}</td>
                  <td>${ageTag(bill)}</td>
                  <td class="num">${money(bill.amount)}</td>
                  <td><button class="btn small" data-print-bill="${esc(bill.ref)}"
                        data-bill-party="${esc(group.party)}" data-bill-date="${esc(bill.date)}"
                        title="Print this bill for the customer">Print</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="row" style="margin-top:.75rem">
          <button class="btn small" data-open-party="${esc(group.party)}">Open party</button>
          <button class="btn small" data-print-party="${esc(group.party)}">Print bill-wise</button>
          ${group.bills.length && state.outstanding.kind === 'receivable'
            ? `<button class="btn small primary" data-receipt-party="${esc(group.party)}">Record receipt</button>` : ''}
        </div>
      </div>
    </details>`).join('');
}

async function loadOutstanding(refresh = false) {
  spinner('outstandingList');
  try {
    state.outstanding.data = await api(
      `/api/outstanding?kind=${state.outstanding.kind}${refresh ? '&refresh=1' : ''}`,
    );
    renderOutstanding();
  } catch (err) {
    showError('outstandingList', err);
  }
}

$('btnReceivable').onclick = () => setOutstandingKind('receivable');
$('btnPayable').onclick = () => setOutstandingKind('payable');

function setOutstandingKind(kind) {
  state.outstanding.kind = kind;
  $('btnReceivable').setAttribute('aria-pressed', String(kind === 'receivable'));
  $('btnPayable').setAttribute('aria-pressed', String(kind === 'payable'));
  loadOutstanding();
}

$('outstandingSearch').addEventListener('input', debounce((e) => {
  state.outstanding.filter = e.target.value;
  renderOutstanding();
}, 150));

$('btnRefreshOutstanding').onclick = () => loadOutstanding(true);

$('btnPrintOutstanding').onclick = () => {
  const data = state.outstanding.data;
  if (!data) return toast('Nothing loaded yet.', true);
  // Prints what is on screen, so a search for one name prints just that name.
  const needle = state.outstanding.filter.trim().toLowerCase();
  const groups = needle
    ? data.parties.filter((p) => p.party.toLowerCase().includes(needle))
    : data.parties;
  printBillWise({ kind: data.kind, groups, ageing: needle ? null : data.ageing, asOn: todayIso() });
};

$('outstandingList').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-party]');
  if (open) {
    showView('parties');
    $('partySearch').value = open.dataset.openParty;
    selectParty(open.dataset.openParty);
    return;
  }
  const printBillBtn = e.target.closest('[data-print-bill]');
  if (printBillBtn) {
    printSavedBill({
      ref: printBillBtn.dataset.printBill,
      party: printBillBtn.dataset.billParty,
      date: printBillBtn.dataset.billDate,
    });
    return;
  }

  const printParty = e.target.closest('[data-print-party]');
  if (printParty) {
    const data = state.outstanding.data;
    const group = data.parties.find((p) => p.party === printParty.dataset.printParty);
    const known = (state.parties || []).find((p) => p.name === group.party);
    printBillWise({
      kind: data.kind,
      groups: [group],
      asOn: todayIso(),
      party: known || { name: group.party },
    });
    return;
  }

  const receipt = e.target.closest('[data-receipt-party]');
  if (receipt) {
    showView('receipt');
    receiptScreen.setParty(receipt.dataset.receiptParty);
  }
});

/* -------------------------------------------------------------- Parties */

async function renderPartyResults(query) {
  const host = $('partyResults');
  try {
    const { items } = await api(`/api/parties?q=${encodeURIComponent(query)}&all=${$('partyAll').checked ? 1 : 0}`);
    state.parties = items;

    if (!items.length) {
      host.innerHTML = `<p class="empty">${LABELS.noResults}</p>`;
      return;
    }
    host.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Group</th><th class="num">Balance</th><th></th></tr></thead>
      <tbody>${items.map((p) => `
        <tr>
          <td><strong>${esc(p.name)}</strong>${p.phone ? `<br><span class="tag">${esc(p.phone)}</span>` : ''}</td>
          <td>${esc(p.group)}</td>
          <td class="num">${money(Math.abs(p.closing))} ${p.closing >= 0 ? 'Dr' : 'Cr'}</td>
          <td><button class="btn small" data-party="${esc(p.name)}">View</button></td>
        </tr>`).join('')}
      </tbody></table></div>`;
  } catch (err) {
    showError('partyResults', err);
  }
}

$('partySearch').addEventListener('input', debounce((e) => renderPartyResults(e.target.value), 250));
$('partyAll').addEventListener('change', () => renderPartyResults($('partySearch').value));
$('partyResults').addEventListener('click', (e) => {
  const button = e.target.closest('[data-party]');
  if (button) selectParty(button.dataset.party);
});

// Bill rows appear on several screens; one handler covers them all.
for (const hostId of ['partyDetail', 'dayendEntries']) {
  $(hostId).addEventListener('click', (e) => {
    const button = e.target.closest('[data-print-bill]');
    if (!button) return;
    printSavedBill({
      ref: button.dataset.printBill,
      party: button.dataset.billParty,
      date: button.dataset.billDate,
    });
  });
}

async function selectParty(name) {
  const host = $('partyDetail');
  spinner('partyDetail');
  try {
    const party = await api(`/api/party?name=${encodeURIComponent(name)}`);
    state.selectedParty = party;

    const owes = party.closing >= 0;
    host.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">${esc(party.name)}</h3>
        <div class="tiles">
          <div class="tile ${owes ? '' : 'warn'}">
            <div class="label">${owes ? 'They owe us' : 'We owe them'}</div>
            <div class="figure">${money(Math.abs(party.closing))}</div>
          </div>
          <div class="tile"><div class="label">Open bills</div><div class="figure">${party.bills.length}</div></div>
        </div>
        <p class="hint" style="margin:0">
          ${esc(party.group)}${party.phone ? ` &nbsp;·&nbsp; ${esc(party.phone)}` : ''}${party.gstin ? ` &nbsp;·&nbsp; GSTIN ${esc(party.gstin)}` : ''}
          ${party.address.length ? `<br>${esc(party.address.join(', '))}` : ''}
          ${party.creditDays ? `<br>Credit period: ${party.creditDays} days` : ''}
        </p>
      </div>

      ${party.bills.length ? `
      <div class="card">
        <div class="row" style="align-items:center">
          <h3 style="margin:0">Open bills</h3>
          <div class="spacer"></div>
          <button class="btn small" id="btnPrintPartyBills">Print bill-wise</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Bill</th><th>Date</th><th>Due</th><th>Status</th>
            <th class="num">Amount</th><th></th></tr></thead>
          <tbody>${party.bills.map((b) => `
            <tr><td>${esc(b.ref)}</td><td>${showDate(b.date)}</td><td>${showDate(b.dueDate)}</td>
            <td>${ageTag(b)}</td><td class="num">${money(Math.abs(b.amount))}</td>
            <td><button class="btn small" data-print-bill="${esc(b.ref)}"
                  data-bill-party="${esc(party.name)}" data-bill-date="${esc(b.date)}"
                  title="Print this bill for the customer">Print</button></td></tr>`).join('')}
          </tbody>
        </table></div>
      </div>` : ''}

      <div class="card">
        <h3 style="margin-top:0">Statement</h3>
        <div class="row">
          <div><label for="stFrom">From</label><input type="date" id="stFrom"></div>
          <div><label for="stTo">To</label><input type="date" id="stTo"></div>
          <button class="btn" id="btnStatement">Show</button>
        </div>
        <div id="statementOut"></div>
      </div>`;

    const year = todayIso() >= `${new Date().getFullYear()}-04-01`
      ? `${new Date().getFullYear()}-04-01`
      : `${new Date().getFullYear() - 1}-04-01`;
    $('stFrom').value = year;
    $('stTo').value = todayIso();
    const printBills = $('btnPrintPartyBills');
    if (printBills) {
      printBills.onclick = () => printBillWise({
        // A party's own bills are all one side; take it from the first bill.
        kind: party.bills[0].kind,
        groups: [{
          party: party.name,
          total: party.bills.reduce((sum, b) => sum + Math.abs(b.amount), 0),
          bills: party.bills,
        }],
        asOn: todayIso(),
        party,
      });
    }
    $('btnStatement').onclick = () => loadStatement(party.name);
    loadStatement(party.name);
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError('partyDetail', err);
  }
}

async function loadStatement(name) {
  spinner('statementOut');
  try {
    const from = $('stFrom').value;
    const to = $('stTo').value;
    const data = await api(`/api/statement?name=${encodeURIComponent(name)}&from=${from}&to=${to}`);

    if (!data.rows.length) {
      $('statementOut').innerHTML = '<p class="empty">No entries in this period.</p>';
      return;
    }
    $('statementOut').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Against</th>
        <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody>${data.rows.map((r) => `
        <tr>
          <td>${showDate(r.date)}</td><td>${esc(r.voucherType)}</td><td>${esc(r.voucherNo)}</td>
          <td>${esc(r.against)}</td>
          <td class="num">${r.debit ? money(r.debit) : ''}</td>
          <td class="num">${r.credit ? money(r.credit) : ''}</td>
          <td class="num">${money(Math.abs(r.balance))} ${r.balance >= 0 ? 'Dr' : 'Cr'}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <th colspan="4">Period total</th>
        <th class="num">${money(data.totalDebit)}</th>
        <th class="num">${money(data.totalCredit)}</th>
        <th class="num"></th>
      </tr></tfoot>
    </table></div>`;
  } catch (err) {
    showError('statementOut', err);
  }
}

/* ---------------------------------------------------------------- Stock */

async function loadStock(refresh = false) {
  spinner('stockList');
  try {
    const query = $('stockSearch').value;
    const data = await api(`/api/stock?q=${encodeURIComponent(query)}${refresh ? '&refresh=1' : ''}`);
    state.stock = data.items;

    $('stockTiles').innerHTML = `
      <div class="tile"><div class="label">Items</div><div class="figure">${data.totalItems}</div></div>
      <div class="tile"><div class="label">Stock value</div><div class="figure">${money(data.totalValue)}</div></div>`;

    if (!data.items.length) {
      $('stockList').innerHTML = `<p class="empty">${LABELS.noResults}</p>`;
      return;
    }
    $('stockList').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Group</th><th class="num">Quantity</th>
        <th class="num">Rate</th><th class="num">Value</th></tr></thead>
      <tbody>${data.items.map((i) => `
        <tr>
          <td><strong>${esc(i.name)}</strong>${i.partNo ? `<br><span class="tag">${esc(i.partNo)}</span>` : ''}</td>
          <td>${esc(i.group)}</td>
          <td class="num">${i.quantity <= 0 ? '<span class="tag late">Out of stock</span>' : `${qty(i.quantity)} ${esc(i.unit)}`}</td>
          <td class="num">${i.rate ? money(i.rate) : '—'}</td>
          <td class="num">${money(i.value)}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
  } catch (err) {
    showError('stockList', err);
  }
}

$('stockSearch').addEventListener('input', debounce(() => loadStock(), 250));
$('btnRefreshStock').onclick = () => loadStock(true);

/* --------------------------------------------------- shared master lists */

/** Loads party/ledger/item choices once per view entry and fills the datalists. */
async function loadOptions(force = false) {
  if (state.options && !force) return state.options;
  const [options, stock] = await Promise.all([
    api('/api/voucher-options'),
    api('/api/stock?limit=5000'),
  ]);
  state.options = options;
  state.stock = stock.items;

  $('listParties').innerHTML = options.parties.map((p) => `<option value="${esc(p.name)}">`).join('');
  $('listItems').innerHTML = stock.items.map((i) => `<option value="${esc(i.name)}">`).join('');
  // A journal may name any ledger, not just a party.
  $('listLedgers').innerHTML = options.allLedgers.map((l) => `<option value="${esc(l.name)}">`).join('');
  return options;
}

function fillSelect(select, values, { placeholder = '' } = {}) {
  const previous = select.value;
  select.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '')
    + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (values.includes(previous)) select.value = previous;
}

/* ------------------------------------------- entry screens: shared pieces */

function previewTableHtml(preview) {
  const rows = preview.entries.map((e) => `
    <tr>
      <td>${esc(e.ledger)}${e.note ? `<br><span class="tag">${esc(e.note)}</span>` : ''}</td>
      <td>${e.side}</td>
      <td class="num">${money(e.amount)}</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Ledger</th><th>Dr/Cr</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/**
 * GST is split evenly into CGST and SGST, which is right for a trade inside the
 * same state — the common case at a counter. Interstate needs an IGST ledger;
 * if the company has no CGST/SGST ledgers the tax is skipped and the user is
 * told, rather than the bill silently posting without tax.
 */
function gstTaxes(subtotal, percent) {
  if (!percent || !state.options) return { taxes: [], note: '' };

  const ledgers = (state.options && state.options.taxLedgers) || [];
  const cgst = ledgers.find((l) => /cgst/i.test(l));
  const sgst = ledgers.find((l) => /sgst/i.test(l));
  if (!cgst || !sgst) {
    return { taxes: [], note: 'This company has no CGST/SGST ledgers, so GST was not added. Add the tax in Tally afterwards.' };
  }

  // Round the whole tax first, then split it, so the two halves always add back
  // to the exact figure. Halving first leaves a stray paisa on odd subtotals.
  const totalTax = Math.round(subtotal * percent) / 100;
  const cgstAmount = Math.round(totalTax * 50) / 100;
  const sgstAmount = Math.round((totalTax - cgstAmount) * 100) / 100;
  return { taxes: [{ ledger: cgst, amount: cgstAmount }, { ledger: sgst, amount: sgstAmount }], note: '' };
}

/** A stock line, shared by the Sales, Purchase and Day Bill screens. */
function stockLineRow({ onChange, rateFor }) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" class="ln-item" list="listItems" placeholder="Item name" autocomplete="off"></td>
    <td><input type="number" class="ln-qty" min="0" step="any" value="1"></td>
    <td><input type="text" class="ln-unit" readonly tabindex="-1"></td>
    <td><input type="number" class="ln-rate" min="0" step="any" value="0"></td>
    <td class="num ln-amount">₹0.00</td>
    <td><button class="btn small danger ln-remove" title="Remove this line" aria-label="Remove this line">✕</button></td>`;

  const itemInput = row.querySelector('.ln-item');
  itemInput.addEventListener('change', () => {
    // Pre-fill unit and a sensible rate from the stock master, then let the
    // user override either.
    const match = state.stock.find((i) => i.name === itemInput.value);
    if (!match) return;
    row.querySelector('.ln-unit').value = match.unit || '';
    const rateInput = row.querySelector('.ln-rate');
    if (Number(rateInput.value) === 0) rateInput.value = rateFor(match);
    onChange();
  });
  row.addEventListener('input', onChange);
  row.querySelector('.ln-remove').onclick = () => { row.remove(); onChange(); };
  return row;
}

function readStockLines(tbody) {
  return [...tbody.querySelectorAll('tr')].map((row) => ({
    item: row.querySelector('.ln-item').value.trim(),
    quantity: Number(row.querySelector('.ln-qty').value) || 0,
    unit: row.querySelector('.ln-unit').value.trim(),
    rate: Number(row.querySelector('.ln-rate').value) || 0,
  })).filter((line) => line.item);
}

/* ------------------------------------------------------------ Day Bills */

/*
 * A running bill per customer per day. Items are appended as the customer comes
 * back, and the whole bill goes to Tally once, at closing time.
 *
 * Until then it lives only on this computer, so the screen says so plainly and
 * every total is labelled as not yet in Tally.
 */

function dayBillCard(bill, isStale) {
  const lines = bill.lines.map((line, index) => `
    <tr>
      <td>${esc(line.item)}</td>
      <td class="num">${qty(line.quantity)} ${esc(line.unit)}</td>
      <td class="num">${money(line.rate)}</td>
      <td class="num">${money(line.amount)}</td>
      <td><span class="tag">${esc(shortTime(line.addedAt))}</span></td>
      <td><button class="btn small danger" data-remove-line="${index}" data-bill="${esc(bill.id)}"
            title="Remove this item" aria-label="Remove this item">✕</button></td>
    </tr>`).join('');

  return `
    <details class="party" data-daybill="${esc(bill.id)}">
      <summary>
        <span>${esc(bill.party)}</span>
        ${isStale ? `<span class="tag late">from ${showDate(bill.date)}</span>` : ''}
        <span class="tag">${bill.itemCount} item${bill.itemCount === 1 ? '' : 's'}</span>
        <span class="amount">${money(bill.total)}</span>
      </summary>
      <div class="body">
        ${bill.lines.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th>
            <th class="num">Amount</th><th>Added</th><th></th></tr></thead>
          <tbody>${lines}</tbody>
          <tfoot>
            <tr><th colspan="3">Subtotal</th><th class="num">${money(bill.subtotal)}</th><th colspan="2"></th></tr>
            ${bill.taxTotal ? `<tr><th colspan="3">GST ${bill.gstPercent}%</th><th class="num">${money(bill.taxTotal)}</th><th colspan="2"></th></tr>` : ''}
            <tr><th colspan="3">Total</th><th class="num">${money(bill.total)}</th><th colspan="2"></th></tr>
          </tfoot>
        </table></div>` : '<p class="empty">Nothing on this bill yet.</p>'}

        <h3>Add items</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th style="min-width:12rem">Item</th><th class="num" style="width:6rem">Qty</th>
              <th style="width:5rem">Unit</th><th class="num" style="width:7rem">Rate</th>
              <th class="num" style="width:8rem">Amount</th><th style="width:3rem"></th></tr></thead>
            <tbody data-append-lines="${esc(bill.id)}"></tbody>
          </table>
        </div>
        <div class="row" style="margin-top:.6rem">
          <button class="btn small" data-add-row="${esc(bill.id)}">+ Another item</button>
          <button class="btn small primary" data-append="${esc(bill.id)}">Add to bill</button>
          <div class="spacer"></div>
          <button class="btn small" data-print="${esc(bill.id)}">Print bill</button>
          <button class="btn small danger" data-discard="${esc(bill.id)}">Discard bill</button>
          <button class="btn primary" data-save="${esc(bill.id)}">Save to Tally</button>
        </div>
      </div>
    </details>`;
}

/** "9:12 am" — enough to tell the morning visit from the evening one. */
function shortTime(iso) {
  if (!iso) return '';
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

async function loadDayBills() {
  try {
    const options = await loadOptions();
    fillSelect($('dbSalesLedger'), options.salesLedgers, { placeholder: 'Choose a sales ledger' });

    const data = await api('/api/daybills');
    state.dayBills = data.items;
    const today = todayIso();

    const total = data.items.reduce((sum, b) => sum + b.total, 0);
    $('daybillsTiles').innerHTML = `
      <div class="tile"><div class="label">Open bills</div><div class="figure">${data.items.length}</div></div>
      <div class="tile warn"><div class="label">Not yet in Tally</div><div class="figure">${money(total)}</div></div>`;

    $('daybillsNotSaved').hidden = data.items.length === 0;
    $('daybillsFooter').hidden = data.items.length === 0;
    $('daybillsList').innerHTML = data.items.length
      ? data.items.map((b) => dayBillCard(b, b.date !== today)).join('')
      : '<p class="empty">No bills open. Start one above when a customer buys something.</p>';

    // Re-open whichever bills the user had expanded, so adding an item does not
    // collapse the card underneath them.
    for (const id of openDayBillIds) {
      const node = $('daybillsList').querySelector(`[data-daybill="${CSS.escape(id)}"]`);
      if (node) node.open = true;
    }
    for (const tbody of $('daybillsList').querySelectorAll('[data-append-lines]')) {
      appendRow(tbody);
    }
  } catch (err) {
    showError('daybillsMessages', err);
  }
}

const openDayBillIds = new Set();

$('daybillsList').addEventListener('toggle', (e) => {
  const card = e.target.closest('[data-daybill]');
  if (!card) return;
  if (card.open) openDayBillIds.add(card.dataset.daybill);
  else openDayBillIds.delete(card.dataset.daybill);
}, true);

function appendRow(tbody) {
  const row = stockLineRow({
    onChange: () => {
      for (const r of tbody.querySelectorAll('tr')) {
        const amount = (Number(r.querySelector('.ln-qty').value) || 0)
          * (Number(r.querySelector('.ln-rate').value) || 0);
        r.querySelector('.ln-amount').textContent = money(amount);
      }
    },
    rateFor: (item) => item.standardPrice || item.rate || 0,
  });
  tbody.appendChild(row);
  return row;
}

$('btnStartDayBill').onclick = async () => {
  clearNode('daybillsMessages');
  const party = $('dbParty').value.trim();
  if (!party) return toast('Type a customer name first.', true);

  try {
    const { reused } = await api('/api/daybills/create', {
      method: 'POST',
      body: JSON.stringify({
        party,
        salesLedger: $('dbSalesLedger').value,
        gstPercent: Number($('dbGst').value) || 0,
      }),
    });
    toast(reused ? `${party} already has a bill open today — opened it.` : `Bill opened for ${party}`);
    $('dbParty').value = '';
    await loadDayBills();
    // Expand the bill just opened so items can go straight in.
    const card = $('daybillsList').querySelector('[data-daybill]');
    if (card && !reused) card.open = true;
  } catch (err) {
    showError('daybillsMessages', err);
  }
};

$('daybillsList').addEventListener('click', async (e) => {
  const target = (attr) => e.target.closest(`[${attr}]`);
  clearNode('daybillsMessages');

  const addRow = target('data-add-row');
  if (addRow) {
    const tbody = $('daybillsList').querySelector(`[data-append-lines="${CSS.escape(addRow.dataset.addRow)}"]`);
    appendRow(tbody).querySelector('.ln-item').focus();
    return;
  }

  const append = target('data-append');
  if (append) {
    const id = append.dataset.append;
    const tbody = $('daybillsList').querySelector(`[data-append-lines="${CSS.escape(id)}"]`);
    const lines = readStockLines(tbody);
    if (!lines.length) return toast('Fill in an item first.', true);
    try {
      await api('/api/daybills/add-lines', { method: 'POST', body: JSON.stringify({ id, lines }) });
      toast(`${lines.length} item${lines.length === 1 ? '' : 's'} added`);
      openDayBillIds.add(id);
      await loadDayBills();
    } catch (err) {
      showError('daybillsMessages', err);
    }
    return;
  }

  const removeLine = target('data-remove-line');
  if (removeLine) {
    try {
      await api('/api/daybills/remove-line', {
        method: 'POST',
        body: JSON.stringify({ id: removeLine.dataset.bill, index: Number(removeLine.dataset.removeLine) }),
      });
      await loadDayBills();
    } catch (err) {
      showError('daybillsMessages', err);
    }
    return;
  }

  const print = target('data-print');
  if (print) {
    const bill = state.dayBills.find((b) => b.id === print.dataset.print);
    printBill({
      title: 'Bill',
      partyLabel: 'Customer',
      party: bill.party,
      date: bill.date,
      reference: bill.reference,
      lines: bill.lines,
      subtotal: bill.subtotal,
      taxes: bill.gstSplit
        ? [{ ledger: `CGST ${bill.gstPercent / 2}%`, amount: bill.gstSplit.cgst },
          { ledger: `SGST ${bill.gstPercent / 2}%`, amount: bill.gstSplit.sgst }]
        : [],
      total: bill.total,
      // Printed before it reaches Tally, and the paper should say so.
      unsaved: true,
    });
    return;
  }

  const discard = target('data-discard');
  if (discard) {
    const bill = state.dayBills.find((b) => b.id === discard.dataset.discard);
    const ok = await confirmModal({
      title: 'Discard this bill?',
      bodyHtml: `<p>${esc(bill.party)} — ${bill.itemCount} item(s), ${money(bill.total)}.</p>
                 <p class="hint">It was never sent to Tally, so nothing there changes. This cannot be undone.</p>`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/daybills/discard', { method: 'POST', body: JSON.stringify({ id: bill.id }) });
      toast('Bill discarded');
      await loadDayBills();
    } catch (err) {
      showError('daybillsMessages', err);
    }
    return;
  }

  const save = target('data-save');
  if (save) await saveDayBill(save.dataset.save);
});

async function saveDayBill(id) {
  let preview;
  try {
    preview = await api('/api/daybills/preview', { method: 'POST', body: JSON.stringify({ id }) });
  } catch (err) {
    showError('daybillsMessages', err);
    return;
  }

  const body = `
    <p><strong>${esc(preview.party)}</strong> &nbsp;·&nbsp; ${showDate(preview.date)}
       &nbsp;·&nbsp; ${preview.lines.length} item${preview.lines.length === 1 ? '' : 's'}</p>
    ${preview.warnings.length ? noticeHtml('warn', 'Please check:', preview.warnings) : ''}
    ${previewTableHtml(preview)}
    <p style="text-align:right;font-size:1.2rem;margin-top:.75rem"><strong>Total ${money(preview.total)}</strong></p>
    <p class="hint">The day bill is removed from this screen once Tally accepts it.</p>`;

  if (!await confirmModal({ title: 'Save this day bill to Tally?', bodyHtml: body, confirmLabel: 'Save in Tally' })) return;

  try {
    const result = await api('/api/daybills/save', { method: 'POST', body: JSON.stringify({ id, confirmed: true }) });
    toast(`${LABELS.saved} — ${money(result.record.total)} for ${result.record.party}`);
    openDayBillIds.delete(id);
    state.options = null;
    await loadDayBills();
  } catch (err) {
    showError('daybillsMessages', err);
    toast(err.message, true);
  }
}

$('btnSaveAllDayBills').onclick = async () => {
  clearNode('daybillsMessages');
  const bills = state.dayBills;
  if (!bills.length) return;

  const total = bills.reduce((sum, b) => sum + b.total, 0);
  const body = `
    <p>${bills.length} bill${bills.length === 1 ? '' : 's'} will be saved as separate vouchers:</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Customer</th><th>Date</th><th class="num">Items</th><th class="num">Total</th></tr></thead>
      <tbody>${bills.map((b) => `<tr><td>${esc(b.party)}</td><td>${showDate(b.date)}</td>
        <td class="num">${b.itemCount}</td><td class="num">${money(b.total)}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><th colspan="3">Total</th><th class="num">${money(total)}</th></tr></tfoot>
    </table></div>
    <p class="hint">Each is saved on its own. If one is refused the others still go through, and you will be told which.</p>`;

  if (!await confirmModal({ title: 'Save all day bills to Tally?', bodyHtml: body, confirmLabel: `Save ${bills.length} bills` })) return;

  try {
    const result = await api('/api/daybills/save-all', {
      method: 'POST',
      body: JSON.stringify({ ids: bills.map((b) => b.id), confirmed: true }),
    });
    state.options = null;
    await loadDayBills();

    if (result.failed.length) {
      $('daybillsMessages').innerHTML = noticeHtml(
        'error',
        `${result.saved.length} saved, ${result.failed.length} could not be saved:`,
        result.failed.map((f) => `${f.party}: ${f.error}`),
      );
      toast(`${result.saved.length} saved, ${result.failed.length} failed`, true);
    } else {
      toast(`${LABELS.saved} — ${result.saved.length} bill${result.saved.length === 1 ? '' : 's'}`);
    }
  } catch (err) {
    showError('daybillsMessages', err);
  }
};

/* ------------------------------------------- Sales and Purchase screens */

/**
 * Sales and Purchase are one screen with the direction reversed, so a single
 * controller drives both and they cannot drift apart. Each instance is handed
 * the ids of its own fields.
 */
function invoiceScreen(spec) {
  const el = (key) => $(spec.ids[key]);

  function recalc() {
    let subtotal = 0;
    for (const row of el('lines').querySelectorAll('tr')) {
      const amount = (Number(row.querySelector('.ln-qty').value) || 0)
        * (Number(row.querySelector('.ln-rate').value) || 0);
      row.querySelector('.ln-amount').textContent = money(amount);
      subtotal += amount;
    }
    const { taxes, note } = gstTaxes(subtotal, Number(el('gst').value) || 0);
    const total = subtotal + taxes.reduce((sum, t) => sum + t.amount, 0);
    el('total').textContent = money(total);
    el('messages').innerHTML = note ? noticeHtml('warn', note) : '';
    return { subtotal, taxes, total };
  }

  function addLine() {
    el('lines').appendChild(stockLineRow({ onChange: recalc, rateFor: spec.rateFor }));
  }

  function clear() {
    el('party').value = '';
    el('reference').value = '';
    el('narration').value = '';
    el('gst').value = '0';
    el('balance').textContent = '';
    el('lines').innerHTML = '';
    addLine();
    clearNode(spec.ids.messages);
    recalc();
  }

  /**
   * A note settles against the bill it reverses, so the original is offered
   * rather than typed. Leaving it blank raises a fresh reference instead.
   */
  async function loadAgainstBills() {
    if (!spec.ids.against) return;
    const select = el('against');
    const name = el('party').value.trim();
    if (!name) {
      select.innerHTML = '<option value="">Choose a party first</option>';
      return;
    }
    try {
      const party = await api('/api/party?name=' + encodeURIComponent(name));
      const bills = party.bills.filter((b) => b.kind === spec.billKind);
      select.innerHTML = '<option value="">No bill \u2014 raise a new reference</option>'
        + bills.map((b) => '<option value="' + esc(b.ref) + '">' + esc(b.ref)
          + ' \u2014 ' + money(Math.abs(b.amount)) + '</option>').join('');
    } catch {
      select.innerHTML = '<option value="">Could not read their bills</option>';
    }
  }

  async function load() {
    try {
      const options = await loadOptions();
      fillSelect(el('ledger'), options[spec.ledgerOptions], { placeholder: spec.ledgerPlaceholder });
      fillSelect(el('type'), options[spec.typeOptions].length ? options[spec.typeOptions] : [spec.defaultType]);
      if (!el('date').value) el('date').value = todayIso();
      if (!el('lines').children.length) addLine();
      recalc();
      if (!options[spec.ledgerOptions].length) {
        el('messages').innerHTML = noticeHtml('error', spec.noLedgerError);
      }
    } catch (err) {
      showError(spec.ids.messages, err);
    }
  }

  /** What is on the form right now, so it can be printed before it is saved. */
  function currentEntry() {
    const { subtotal, taxes, total } = recalc();
    return {
      title: spec.printTitle || spec.defaultType,
      party: el('party').value.trim(),
      date: el('date').value,
      reference: el('reference').value.trim(),
      lines: readStockLines(el('lines')).map((l) => ({ ...l, amount: l.quantity * l.rate })),
      subtotal,
      taxes,
      taxTotal: taxes.reduce((sum, t) => sum + t.amount, 0),
      total,
      narration: el('narration').value.trim(),
    };
  }

  async function submit() {
    clearNode(spec.ids.messages);
    const { taxes } = recalc();
    const payload = {
      date: el('date').value,
      voucherType: el('type').value,
      party: el('party').value.trim(),
      [spec.ledgerField]: el('ledger').value,
      reference: el('reference').value.trim(),
      narration: el('narration').value.trim(),
      lines: readStockLines(el('lines')),
      taxes,
      ...(spec.ids.against ? { againstBill: el('against').value } : {}),
    };

    let preview;
    try {
      preview = await api(`/api/preview/${spec.kind}`, { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
      showError(spec.ids.messages, err);
      return;
    }

    const body = `
      <p><strong>${esc(preview.party)}</strong> &nbsp;·&nbsp; ${showDate(preview.date)}
         ${preview.reference ? ` &nbsp;·&nbsp; ${esc(preview.reference)}` : ''}</p>
      ${preview.warnings.length ? noticeHtml('warn', 'Please check:', preview.warnings) : ''}
      ${previewTableHtml(preview)}
      <p style="text-align:right;font-size:1.2rem;margin-top:.75rem">
        <strong>Total ${money(preview.total)}</strong></p>
      <p class="hint">This will create a ${esc(preview.voucherType)} voucher in ${esc(state.company)}.</p>`;

    if (!await confirmModal({ title: spec.confirmTitle, bodyHtml: body, confirmLabel: 'Save in Tally' })) return;

    try {
      const result = await api(`/api/post/${spec.kind}`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, confirmed: true }),
      });
      toast(`${LABELS.saved} — ${money(result.record.total)} for ${result.record.party}`);
      clear();
      state.options = null;
    } catch (err) {
      showError(spec.ids.messages, err);
      toast(err.message, true);
    }
  }

  el('addLine').onclick = () => {
    addLine();
    el('lines').lastElementChild.querySelector('.ln-item').focus();
  };
  el('gst').onchange = recalc;
  el('clear').onclick = clear;
  el('preview').onclick = submit;
  if (spec.ids.print) {
    // Prints what is on screen, saved or not, so a customer can be handed the
    // bill while the entry is still being checked.
    $(spec.ids.print).onclick = () => printBill({ ...currentEntry(), unsaved: true });
  }
  el('party').addEventListener('change', () => {
    const party = (state.options?.parties || []).find((p) => p.name === el('party').value);
    el('balance').textContent = party ? spec.partyBalanceText(party) : '';
    loadAgainstBills();
  });

  return { load, currentEntry };
}

const salesScreen = invoiceScreen({
  kind: 'sales',
  ledgerField: 'salesLedger',
  ledgerOptions: 'salesLedgers',
  typeOptions: 'salesTypes',
  defaultType: 'Sales',
  ledgerPlaceholder: 'Choose a sales ledger',
  noLedgerError: 'No sales ledger was found in this company, so a bill cannot be made from here.',
  confirmTitle: 'Save this bill in Tally?',
  // Selling price if the company keeps one, else the last known rate.
  rateFor: (item) => item.standardPrice || item.rate || 0,
  partyBalanceText: (p) => `Current balance: ${money(Math.abs(p.closing))} ${p.closing >= 0 ? 'due from them' : 'due to them'}`,
  ids: {
    party: 'invParty', print: 'btnPrintInvoice', date: 'invDate', type: 'invType', ledger: 'invSalesLedger',
    reference: 'invReference', lines: 'invLines', gst: 'invGst', total: 'invTotal',
    narration: 'invNarration', messages: 'invoiceMessages', balance: 'invPartyBalance',
    addLine: 'btnAddLine', clear: 'btnClearInvoice', preview: 'btnPreviewInvoice',
  },
});

const purchaseScreen = invoiceScreen({
  kind: 'purchase',
  ledgerField: 'purchaseLedger',
  ledgerOptions: 'purchaseLedgers',
  typeOptions: 'purchaseTypes',
  defaultType: 'Purchase',
  ledgerPlaceholder: 'Choose a purchase ledger',
  noLedgerError: 'No purchase ledger was found in this company, so a purchase cannot be entered from here.',
  confirmTitle: 'Save this purchase in Tally?',
  // Cost rate, not the selling price.
  rateFor: (item) => item.rate || 0,
  partyBalanceText: (p) => `Current balance: ${money(Math.abs(p.closing))} ${p.closing >= 0 ? 'due from them' : 'due to them'}`,
  ids: {
    party: 'purParty', print: 'btnPrintPurchase', date: 'purDate', type: 'purType', ledger: 'purLedger',
    reference: 'purReference', lines: 'purLines', gst: 'purGst', total: 'purTotal',
    narration: 'purNarration', messages: 'purchaseMessages', balance: 'purPartyBalance',
    addLine: 'btnAddPurLine', clear: 'btnClearPurchase', preview: 'btnPreviewPurchase',
  },
});

const creditNoteScreen = invoiceScreen({
  kind: 'creditnote',
  ledgerField: 'returnLedger',
  // A return is normally posted to a ledger in the same group as the original.
  ledgerOptions: 'salesLedgers',
  typeOptions: 'creditNoteTypes',
  defaultType: 'Credit Note',
  printTitle: 'Credit Note',
  billKind: 'receivable',
  ledgerPlaceholder: 'Choose a sales return ledger',
  noLedgerError: 'No sales ledger was found in this company, so a credit note cannot be made from here.',
  confirmTitle: 'Save this credit note in Tally?',
  rateFor: (item) => item.standardPrice || item.rate || 0,
  partyBalanceText: (p) => 'Current balance: ' + money(Math.abs(p.closing))
    + (p.closing >= 0 ? ' due from them' : ' due to them'),
  ids: {
    party: 'crnParty', print: 'btnPrintCrn', date: 'crnDate', type: 'crnType', ledger: 'crnLedger',
    against: 'crnAgainst', reference: 'crnReference', lines: 'crnLines', gst: 'crnGst',
    total: 'crnTotal', narration: 'crnNarration', messages: 'creditnoteMessages',
    balance: 'crnPartyBalance', addLine: 'btnAddCrnLine', clear: 'btnClearCrn',
    preview: 'btnPreviewCrn',
  },
});

const debitNoteScreen = invoiceScreen({
  kind: 'debitnote',
  ledgerField: 'returnLedger',
  ledgerOptions: 'purchaseLedgers',
  typeOptions: 'debitNoteTypes',
  defaultType: 'Debit Note',
  printTitle: 'Debit Note',
  billKind: 'payable',
  ledgerPlaceholder: 'Choose a purchase return ledger',
  noLedgerError: 'No purchase ledger was found in this company, so a debit note cannot be made from here.',
  confirmTitle: 'Save this debit note in Tally?',
  rateFor: (item) => item.rate || 0,
  partyBalanceText: (p) => 'Current balance: ' + money(Math.abs(p.closing))
    + (p.closing >= 0 ? ' due from them' : ' due to them'),
  ids: {
    party: 'dbnParty', print: 'btnPrintDbn', date: 'dbnDate', type: 'dbnType', ledger: 'dbnLedger',
    against: 'dbnAgainst', reference: 'dbnReference', lines: 'dbnLines', gst: 'dbnGst',
    total: 'dbnTotal', narration: 'dbnNarration', messages: 'debitnoteMessages',
    balance: 'dbnPartyBalance', addLine: 'btnAddDbnLine', clear: 'btnClearDbn',
    preview: 'btnPreviewDbn',
  },
});

const loadInvoiceView = () => salesScreen.load();
const loadPurchaseView = () => purchaseScreen.load();
const loadCreditNoteView = () => creditNoteScreen.load();
const loadDebitNoteView = () => debitNoteScreen.load();

/* ------------------------------------------ Receipt and Payment screens */

/**
 * Money in and money out. Identical but for which bills are offered and which
 * way the entry falls, so again one controller.
 */
function settlementScreen(spec) {
  const el = (key) => $(spec.ids[key]);
  let openBills = [];

  function readPickedBills() {
    return [...el('bills').querySelectorAll('.bill-pick:checked')].map((box) => {
      const index = Number(box.dataset.index);
      const amountInput = el('bills').querySelector(`.bill-amount[data-index="${index}"]`);
      return { name: openBills[index].ref, amount: Number(amountInput.value) || 0 };
    }).filter((b) => b.amount > 0);
  }

  /** Keeps the total equal to the bills ticked, so the two cannot disagree. */
  function syncAmount() {
    const picked = readPickedBills();
    if (!picked.length) return;
    el('amount').value = picked.reduce((sum, b) => sum + b.amount, 0).toFixed(2);
  }

  async function loadBills() {
    const name = el('party').value.trim();
    if (!name) return;
    spinner(spec.ids.bills);
    try {
      const party = await api(`/api/party?name=${encodeURIComponent(name)}`);
      openBills = party.bills.filter((b) => b.kind === spec.billKind);

      if (!openBills.length) {
        el('bills').innerHTML = `<p class="empty">No open bills for this party. The ${spec.noun} will be recorded on account.</p>`;
        return;
      }
      el('bills').innerHTML = `
        <div class="row" style="margin-bottom:.5rem">
          <button class="btn small" data-act="all">Select all</button>
          <button class="btn small" data-act="none">Clear</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th style="width:3rem"></th><th>Bill</th><th>Date</th><th>Status</th>
            <th class="num">Open</th><th class="num" style="width:9rem">Settling</th></tr></thead>
          <tbody>${openBills.map((b, index) => `
            <tr>
              <td><input type="checkbox" class="bill-pick" data-index="${index}" style="width:1.3rem;height:1.3rem"></td>
              <td>${esc(b.ref)}</td>
              <td>${showDate(b.date)}</td>
              <td>${ageTag(b)}</td>
              <td class="num">${money(Math.abs(b.amount))}</td>
              <td><input type="number" class="bill-amount" data-index="${index}" min="0" step="0.01" value="${Math.abs(b.amount).toFixed(2)}" disabled></td>
            </tr>`).join('')}
          </tbody>
        </table></div>`;
    } catch (err) {
      showError(spec.ids.bills, err);
    }
  }

  function clear() {
    el('party').value = '';
    el('amount').value = '0';
    el('reference').value = '';
    el('narration').value = '';
    el('bills').innerHTML = `<p class="empty">Choose a party to see their open bills.</p>`;
    openBills = [];
    clearNode(spec.ids.messages);
  }

  async function load() {
    try {
      const options = await loadOptions();
      fillSelect(el('deposit'), options.depositLedgers, { placeholder: 'Choose cash or bank' });
      fillSelect(el('type'), options[spec.typeOptions].length ? options[spec.typeOptions] : [spec.defaultType]);
      if (!el('date').value) el('date').value = todayIso();
      if (!options.depositLedgers.length) {
        el('messages').innerHTML = noticeHtml('error', 'No cash or bank ledger was found in this company.');
      }
    } catch (err) {
      showError(spec.ids.messages, err);
    }
  }

  async function submit() {
    clearNode(spec.ids.messages);
    const payload = {
      date: el('date').value,
      voucherType: el('type') ? el('type').value : spec.defaultType,
      party: el('party').value.trim(),
      depositLedger: el('deposit').value,
      amount: Number(el('amount').value) || 0,
      reference: el('reference').value.trim(),
      narration: el('narration').value.trim(),
      againstBills: readPickedBills(),
    };

    let preview;
    try {
      preview = await api(`/api/preview/${spec.kind}`, { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
      showError(spec.ids.messages, err);
      return;
    }

    const body = `
      <p><strong>${esc(preview.party)}</strong> &nbsp;·&nbsp; ${showDate(preview.date)}</p>
      ${preview.warnings.length ? noticeHtml('warn', 'Please check:', preview.warnings) : ''}
      ${previewTableHtml(preview)}
      ${preview.againstBills.length ? `<p class="hint">Settles: ${preview.againstBills.map((b) => `${esc(b.name)} (${money(b.amount)})`).join(', ')}</p>` : ''}
      <p style="text-align:right;font-size:1.2rem;margin-top:.75rem"><strong>Total ${money(preview.amount)}</strong></p>`;

    if (!await confirmModal({ title: spec.confirmTitle, bodyHtml: body, confirmLabel: 'Save in Tally' })) return;

    try {
      const result = await api(`/api/post/${spec.kind}`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, confirmed: true }),
      });
      toast(`${LABELS.saved} — ${money(result.record.total)} ${spec.toastPreposition} ${result.record.party}`);
      clear();
      state.options = null;
    } catch (err) {
      showError(spec.ids.messages, err);
      toast(err.message, true);
    }
  }

  el('bills').addEventListener('click', (e) => {
    const action = e.target.closest('[data-act]');
    if (!action) return;
    for (const box of el('bills').querySelectorAll('.bill-pick')) {
      box.checked = action.dataset.act === 'all';
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  el('bills').addEventListener('change', (e) => {
    const box = e.target.closest('.bill-pick');
    if (box) {
      el('bills').querySelector(`.bill-amount[data-index="${box.dataset.index}"]`).disabled = !box.checked;
    }
    syncAmount();
  });
  el('bills').addEventListener('input', (e) => {
    if (e.target.classList.contains('bill-amount')) syncAmount();
  });
  el('party').addEventListener('change', loadBills);
  el('clear').onclick = clear;
  el('preview').onclick = submit;

  return { load, loadBills, setParty: (name) => { el('party').value = name; return loadBills(); } };
}

const receiptScreen = settlementScreen({
  kind: 'receipt',
  billKind: 'receivable',
  noun: 'receipt',
  typeOptions: 'receiptTypes',
  defaultType: 'Receipt',
  confirmTitle: 'Save this receipt in Tally?',
  toastPreposition: 'from',
  ids: {
    party: 'rcpParty', date: 'rcpDate', deposit: 'rcpDeposit', amount: 'rcpAmount',
    reference: 'rcpReference', narration: 'rcpNarration', bills: 'rcpBills',
    messages: 'receiptMessages', type: 'rcpType',
    clear: 'btnClearReceipt', preview: 'btnPreviewReceipt',
  },
});

const paymentScreen = settlementScreen({
  kind: 'payment',
  billKind: 'payable',
  noun: 'payment',
  typeOptions: 'paymentTypes',
  defaultType: 'Payment',
  confirmTitle: 'Save this payment in Tally?',
  toastPreposition: 'to',
  ids: {
    party: 'payParty', date: 'payDate', deposit: 'payDeposit', amount: 'payAmount',
    reference: 'payReference', narration: 'payNarration', bills: 'payBills',
    messages: 'paymentMessages', type: 'payType',
    clear: 'btnClearPayment', preview: 'btnPreviewPayment',
  },
});

const loadReceiptView = () => receiptScreen.load();
const loadPaymentView = () => paymentScreen.load();

/* --------------------------------------------------------------- Contra */

async function loadContraView() {
  try {
    const options = await loadOptions();
    fillSelect($('conFrom'), options.depositLedgers, { placeholder: 'Choose an account' });
    fillSelect($('conTo'), options.depositLedgers, { placeholder: 'Choose an account' });
    fillSelect($('conType'), options.contraTypes.length ? options.contraTypes : ['Contra']);
    if (!$('conDate').value) $('conDate').value = todayIso();

    if (options.depositLedgers.length < 2) {
      $('contraMessages').innerHTML = noticeHtml('error',
        'A contra needs at least two cash or bank accounts, and this company has fewer than that.');
    }
    showContraBalances();
  } catch (err) {
    showError('contraMessages', err);
  }
}

/** Shows what each side currently holds, so a transfer can be sanity-checked. */
function showContraBalances() {
  const ledgers = (state.options && state.options.allLedgers) || [];
  const balanceOf = (name) => {
    const found = ledgers.find((l) => l.name === name);
    return found ? `${name}: ${money(Math.abs(found.closing || 0))}` : '';
  };
  const parts = [balanceOf($('conFrom').value), balanceOf($('conTo').value)].filter(Boolean);
  $('conBalances').textContent = parts.join('   ·   ');
}

$('conFrom').addEventListener('change', showContraBalances);
$('conTo').addEventListener('change', showContraBalances);

$('btnSwapContra').onclick = () => {
  const from = $('conFrom').value;
  $('conFrom').value = $('conTo').value;
  $('conTo').value = from;
  showContraBalances();
};

$('btnClearContra').onclick = () => {
  $('conAmount').value = '0';
  $('conReference').value = '';
  $('conNarration').value = '';
  clearNode('contraMessages');
};

$('btnPreviewContra').onclick = async () => {
  clearNode('contraMessages');
  const payload = {
    date: $('conDate').value,
    voucherType: $('conType').value,
    fromLedger: $('conFrom').value,
    toLedger: $('conTo').value,
    amount: Number($('conAmount').value) || 0,
    reference: $('conReference').value.trim(),
    narration: $('conNarration').value.trim(),
  };

  let preview;
  try {
    preview = await api('/api/preview/contra', { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    showError('contraMessages', err);
    return;
  }

  const body = `
    <p><strong>${esc(preview.fromLedger)}</strong> &rarr; <strong>${esc(preview.toLedger)}</strong>
       &nbsp;·&nbsp; ${showDate(preview.date)}</p>
    ${preview.warnings.length ? noticeHtml('warn', 'Please check:', preview.warnings) : ''}
    ${previewTableHtml(preview)}
    <p style="text-align:right;font-size:1.2rem;margin-top:.75rem"><strong>Total ${money(preview.amount)}</strong></p>`;

  if (!await confirmModal({ title: 'Save this transfer in Tally?', bodyHtml: body, confirmLabel: 'Save in Tally' })) return;

  try {
    const result = await api('/api/post/contra', {
      method: 'POST',
      body: JSON.stringify({ ...payload, confirmed: true }),
    });
    toast(`${LABELS.saved} — ${money(result.record.total)} moved`);
    $('btnClearContra').click();
    state.options = null;
  } catch (err) {
    showError('contraMessages', err);
    toast(err.message, true);
  }
};

/* -------------------------------------------------------------- Journal */

function journalLineRow() {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" class="jl-ledger" list="listLedgers" placeholder="Ledger name" autocomplete="off"></td>
    <td>
      <select class="jl-side">
        <option value="Dr">Dr</option>
        <option value="Cr">Cr</option>
      </select>
    </td>
    <td><input type="number" class="jl-amount" min="0" step="0.01" value="0"></td>
    <td><input type="text" class="jl-bill" placeholder="—" disabled title="Only needed for bill-wise parties"></td>
    <td><button class="btn small danger jl-remove" title="Remove this line" aria-label="Remove this line">✕</button></td>`;

  const ledgerInput = row.querySelector('.jl-ledger');
  ledgerInput.addEventListener('change', () => {
    // A bill-wise party cannot be posted to without naming a bill, so the field
    // only opens up for those ledgers.
    const all = (state.options && state.options.allLedgers) || [];
    const match = all.find((l) => l.name === ledgerInput.value);
    const bill = row.querySelector('.jl-bill');
    bill.disabled = !(match && match.billwise);
    bill.placeholder = bill.disabled ? '—' : 'Bill name (required)';
    recalcJournal();
  });
  row.addEventListener('input', recalcJournal);
  row.querySelector('.jl-side').addEventListener('change', recalcJournal);
  row.querySelector('.jl-remove').onclick = () => { row.remove(); recalcJournal(); };
  return row;
}

function readJournalEntries() {
  return [...$('jrnLines').querySelectorAll('tr')].map((row) => ({
    ledger: row.querySelector('.jl-ledger').value.trim(),
    side: row.querySelector('.jl-side').value,
    amount: Number(row.querySelector('.jl-amount').value) || 0,
    billRef: row.querySelector('.jl-bill').value.trim(),
  })).filter((entry) => entry.ledger);
}

/** Live running total, so the two sides can be seen to match before saving. */
function recalcJournal() {
  const entries = readJournalEntries();
  const debit = entries.filter((e) => e.side === 'Dr').reduce((sum, e) => sum + e.amount, 0);
  const credit = entries.filter((e) => e.side === 'Cr').reduce((sum, e) => sum + e.amount, 0);
  const difference = Math.round((debit - credit) * 100) / 100;

  $('jrnTotals').textContent = `Dr ${money(debit)} / Cr ${money(credit)}`;
  const badge = $('jrnBalance');
  if (!entries.length) {
    badge.className = 'tag';
    badge.textContent = 'No entries yet';
  } else if (difference === 0) {
    badge.className = 'tag fine';
    badge.textContent = 'Balanced';
  } else {
    badge.className = 'tag late';
    badge.textContent = `${difference > 0 ? 'Debit' : 'Credit'} higher by ${money(Math.abs(difference))}`;
  }
  return { debit, credit, difference };
}

async function loadJournalView() {
  try {
    const options = await loadOptions();
    fillSelect($('jrnType'), options.journalTypes.length ? options.journalTypes : ['Journal']);
    if (!$('jrnDate').value) $('jrnDate').value = todayIso();
    if (!$('jrnLines').children.length) {
      // Open with one debit and one credit line, the shape of every journal.
      $('jrnLines').appendChild(journalLineRow());
      const credit = journalLineRow();
      credit.querySelector('.jl-side').value = 'Cr';
      $('jrnLines').appendChild(credit);
    }
    recalcJournal();
  } catch (err) {
    showError('journalMessages', err);
  }
}

$('btnAddJrnLine').onclick = () => {
  $('jrnLines').appendChild(journalLineRow());
  $('jrnLines').lastElementChild.querySelector('.jl-ledger').focus();
};

$('btnClearJournal').onclick = () => {
  $('jrnReference').value = '';
  $('jrnNarration').value = '';
  $('jrnLines').innerHTML = '';
  $('jrnLines').appendChild(journalLineRow());
  const credit = journalLineRow();
  credit.querySelector('.jl-side').value = 'Cr';
  $('jrnLines').appendChild(credit);
  clearNode('journalMessages');
  recalcJournal();
};

$('btnPreviewJournal').onclick = async () => {
  clearNode('journalMessages');
  const payload = {
    date: $('jrnDate').value,
    voucherType: $('jrnType').value,
    reference: $('jrnReference').value.trim(),
    narration: $('jrnNarration').value.trim(),
    entries: readJournalEntries(),
  };

  let preview;
  try {
    preview = await api('/api/preview/journal', { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    showError('journalMessages', err);
    return;
  }

  const body = `
    <p>${showDate(preview.date)}${preview.reference ? ` &nbsp;·&nbsp; ${esc(preview.reference)}` : ''}</p>
    ${preview.warnings.length ? noticeHtml('warn', 'Please check:', preview.warnings) : ''}
    ${previewTableHtml(preview)}
    <p style="text-align:right;font-size:1.2rem;margin-top:.75rem">
      <strong>Dr ${money(preview.totalDebit)} &nbsp; Cr ${money(preview.totalCredit)}</strong></p>`;

  if (!await confirmModal({ title: 'Save this journal in Tally?', bodyHtml: body, confirmLabel: 'Save in Tally' })) return;

  try {
    const result = await api('/api/post/journal', {
      method: 'POST',
      body: JSON.stringify({ ...payload, confirmed: true }),
    });
    toast(`${LABELS.saved} — journal for ${money(result.record.total)}`);
    $('btnClearJournal').click();
    state.options = null;
  } catch (err) {
    showError('journalMessages', err);
    toast(err.message, true);
  }
};

/* ---------------------------------------------------------------- printing */

/*
 * Printing opens a small window carrying its own stylesheet rather than
 * printing this page. The screens are full of buttons and panels that have no
 * business on a customer's copy, and a print-only stylesheet for all of them
 * would be a second layout to keep in step with the first.
 */

const PRINT_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Tahoma, sans-serif;
    color: #000; background: #fff;
    margin: 0; padding: 14mm 12mm;
    font-size: 11pt; line-height: 1.35;
  }
  .doc-head { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 10px; }
  .doc-company { font-size: 15pt; font-weight: 700; letter-spacing: .02em; }
  .doc-title { font-size: 11pt; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; margin-top: 4px; }
  .doc-meta { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; font-size: 10.5pt; }
  .doc-meta .cap { color: #444; text-transform: uppercase; font-size: 8.5pt; letter-spacing: .08em; display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #000; padding: 4px 6px; text-align: left; }
  th { background: #e8e8e8; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { font-weight: 700; }
  .grand td { font-size: 12pt; }
  .note { margin-top: 10px; font-size: 10pt; }
  .sign { margin-top: 26mm; display: flex; justify-content: space-between; font-size: 10pt; }
  .sign div { border-top: 1px solid #000; padding-top: 4px; min-width: 55mm; text-align: center; }
  .foot { margin-top: 8px; font-size: 8.5pt; color: #555; text-align: center; }
  tr.party-head td { background: #e2e2e2; font-weight: 700; }
  tr.subtotal td { background: #f2f2f2; font-weight: 700; }
  tr.overdue td.days { font-weight: 700; }
  .ageing { margin-top: 12px; }
  .ageing table { width: auto; min-width: 60%; }
  @page { margin: 10mm; }
`;

/**
 * Opens the print dialog on a standalone document. Returns false when the
 * browser blocked the window, so the caller can say something useful instead
 * of appearing to do nothing.
 */
function openPrintWindow(title, bodyHtml) {
  const win = window.open('', '_blank', 'width=880,height=900');
  if (!win) {
    toast('The browser blocked the print window. Allow pop-ups for this page and try again.', true);
    return false;
  }
  win.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>'
    + '<style>' + PRINT_CSS + '</style></head><body>' + bodyHtml + '</body></html>',
  );
  win.document.close();
  win.focus();
  // Let the document lay out before the dialog freezes it.
  setTimeout(() => win.print(), 250);
  return true;
}

/** A bill or note, laid out as something you would hand across the counter. */
function printBill(entry) {
  const taxes = entry.taxes || [];
  if (!entry.lines.length && !taxes.length) {
    return toast('Nothing to print — add an item first.', true);
  }
  if (!entry.party) return toast('Choose a party before printing.', true);

  // With stock lines the bill itemises quantity and rate. Without them — an
  // accounting-only voucher — it lists the ledger amounts as particulars, which
  // is what Tally prints for the same voucher.
  const itemised = entry.lines.length > 0;
  const columns = itemised ? 5 : 2;

  const rows = itemised
    ? entry.lines.map((line, index) => `
      <tr>
        <td class="num">${index + 1}</td>
        <td>${esc(line.item)}</td>
        <td class="num">${qty(line.quantity)} ${esc(line.unit || '')}</td>
        <td class="num">${money(line.rate)}</td>
        <td class="num">${money(line.amount)}</td>
      </tr>`).join('')
    : taxes.map((charge) => `
      <tr><td>${esc(charge.ledger)}</td><td class="num">${money(charge.amount)}</td></tr>`).join('');

  const head = itemised
    ? `<tr><th class="num" style="width:8%">#</th><th>Item</th>
         <th class="num" style="width:18%">Quantity</th>
         <th class="num" style="width:16%">Rate</th>
         <th class="num" style="width:20%">Amount</th></tr>`
    : '<tr><th>Particulars</th><th class="num" style="width:28%">Amount</th></tr>';

  const taxRows = itemised
    ? taxes.map((tax) => `
      <tr><td colspan="4">${esc(tax.ledger)}</td><td class="num">${money(tax.amount)}</td></tr>`).join('')
    : '';

  const body = `
    <div class="doc-head">
      <div class="doc-company">${esc(state.company || 'Company')}</div>
      <div class="doc-title">${esc(entry.title || 'Invoice')}</div>
    </div>

    <div class="doc-meta">
      <div><span class="cap">${esc(entry.partyLabel || 'Party')}</span><strong>${esc(entry.party)}</strong></div>
      <div><span class="cap">Reference</span>${esc(entry.reference || '—')}</div>
      <div><span class="cap">Date</span>${showDate(entry.date)}</div>
    </div>

    <table>
      <thead>${head}</thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${itemised
          ? `<tr><td colspan="4">Subtotal</td><td class="num">${money(entry.subtotal)}</td></tr>${taxRows}`
          : ''}
        <tr class="grand"><td colspan="${columns - 1}">Total</td>
          <td class="num">${money(entry.total)}</td></tr>
      </tfoot>
    </table>

    ${entry.narration ? `<p class="note"><strong>Note:</strong> ${esc(entry.narration)}</p>` : ''}
    ${entry.unsaved ? '<p class="note"><em>Not yet recorded in Tally.</em></p>' : ''}

    <div class="sign">
      <div>Customer's signature</div>
      <div>for ${esc(state.company || 'Company')}</div>
    </div>
    <div class="foot">Printed ${showDate(todayIso())} from Tally Desk</div>`;

  return openPrintWindow(`${entry.title || 'Invoice'} — ${entry.party}`, body);
}

/**
 * Reprints a bill that is already in Tally, so a customer can be given a copy
 * long after it was entered. The voucher is read back from Tally rather than
 * reconstructed from what this program remembers sending.
 */
async function printSavedBill({ ref, party, date, label }) {
  toast('Fetching the bill from Tally…');
  let voucher;
  try {
    const search = new URLSearchParams({ ref, party: party || '', date: date || '' });
    voucher = await api(`/api/voucher?${search}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }

  printBill({
    title: voucher.voucherType || label || 'Invoice',
    partyLabel: 'Customer',
    party: voucher.party,
    date: voucher.date,
    reference: voucher.reference || voucher.voucherNumber,
    lines: voucher.lines,
    subtotal: voucher.subtotal,
    // On an itemised bill these are the taxes; on an accounting-only one they
    // are the particulars, and printBill lays each out accordingly.
    taxes: voucher.charges,
    total: voucher.total,
    narration: voucher.narration,
  });
}

/**
 * A bill-wise outstanding statement: every unsettled bill, its age and what is
 * left on it. For one party this is the reminder you hand across the counter;
 * for all of them it is the collection list to work through.
 */
function printBillWise({ kind, groups, ageing, asOn, party }) {
  if (!groups.length) return toast('Nothing outstanding to print.', true);

  const owed = kind === 'payable';
  const heading = owed ? 'Bill-wise Payable' : 'Bill-wise Outstanding';
  const grandTotal = groups.reduce((sum, g) => sum + g.total, 0);
  const single = groups.length === 1 && party;

  // One party prints as a plain list; several are grouped with subtotals.
  const rows = groups.map((group) => {
    const bills = group.bills.map((bill, index) => `
      <tr class="${bill.overdueBy > 0 ? 'overdue' : ''}">
        <td class="num">${index + 1}</td>
        <td>${esc(bill.ref)}</td>
        <td>${showDate(bill.date)}</td>
        <td>${showDate(bill.dueDate)}</td>
        <td class="num days">${bill.overdueBy > 0 ? `${bill.overdueBy} days` : 'Not due'}</td>
        <td class="num">${money(Math.abs(bill.amount))}</td>
      </tr>`).join('');

    if (single) return bills;
    return `
      <tr class="party-head"><td colspan="6">${esc(group.party)}</td></tr>
      ${bills}
      <tr class="subtotal"><td colspan="5">${esc(group.party)} total</td>
        <td class="num">${money(group.total)}</td></tr>`;
  }).join('');

  const contact = single && party
    ? [party.phone, party.gstin ? `GSTIN ${party.gstin}` : '', (party.address || []).join(', ')]
      .filter(Boolean).join(' · ')
    : '';

  const ageingTable = (ageing || []).length ? `
    <div class="ageing">
      <table>
        <thead><tr><th>Age</th><th class="num">Amount</th></tr></thead>
        <tbody>${ageing.map((b) => `<tr><td>${esc(b.label)}</td>
          <td class="num">${money(b.amount)}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : '';

  const body = `
    <div class="doc-head">
      <div class="doc-company">${esc(state.company || 'Company')}</div>
      <div class="doc-title">${esc(heading)}</div>
    </div>

    <div class="doc-meta">
      <div><span class="cap">${single ? (owed ? 'Supplier' : 'Customer') : 'Parties'}</span>
        <strong>${single ? esc(groups[0].party) : `${groups.length} in the list`}</strong></div>
      <div><span class="cap">As on</span>${showDate(asOn)}</div>
      <div><span class="cap">${owed ? 'We owe' : 'Due to us'}</span><strong>${money(grandTotal)}</strong></div>
    </div>
    ${contact ? `<p class="note">${esc(contact)}</p>` : ''}

    <table>
      <thead>
        <tr><th class="num" style="width:7%">#</th><th>Bill</th>
          <th style="width:15%">Bill date</th><th style="width:15%">Due date</th>
          <th class="num" style="width:14%">Overdue</th>
          <th class="num" style="width:19%">Amount</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="grand"><td colspan="5">Total ${owed ? 'payable' : 'outstanding'}</td>
          <td class="num">${money(grandTotal)}</td></tr>
      </tfoot>
    </table>

    ${ageingTable}

    <p class="note">${owed
      ? 'Amounts we owe, bill by bill, as recorded in Tally.'
      : 'Please arrange payment of the overdue bills above. Amounts as recorded in Tally.'}</p>
    <div class="foot">Printed ${showDate(todayIso())} from Tally Desk</div>`;

  return openPrintWindow(
    single ? `${heading} — ${groups[0].party}` : heading,
    body,
  );
}

/* --------------------------------------------------------------- Day End */

/**
 * The closing report. Reads the day's vouchers back out of Tally rather than
 * totalling what this program happened to send, so entries made directly in
 * Tally are counted too.
 */
async function loadDayEnd() {
  if (!$('deDate').value) $('deDate').value = todayIso();
  spinner('dayendByType');
  clearNode('dayendMessages');

  try {
    const data = await api(`/api/dayend?date=${encodeURIComponent($('deDate').value)}`);
    state.dayEnd = data;

    $('dayendTiles').innerHTML = [
      ['Sales', data.sales], ['Received', data.received],
      ['Purchases', data.purchases], ['Paid out', data.paid],
    ].map(([label, amount]) => `
      <div class="tile"><div class="label">${label}</div><div class="figure">${money(amount)}</div></div>`).join('')
      + `<div class="tile"><div class="label">Vouchers</div><div class="figure">${data.voucherCount}</div></div>`;

    // Anything still sitting in Day Bills has not reached Tally, and closing the
    // day without noticing that is exactly the mistake worth shouting about.
    $('dayendOpenBills').innerHTML = data.openDayBills.length
      ? noticeHtml('warn',
        `${data.openDayBills.length} day bill${data.openDayBills.length === 1 ? '' : 's'} worth ${money(data.openDayBillsTotal)} still not saved to Tally:`,
        data.openDayBills.map((b) => `${b.party} — ${b.itemCount} item(s), ${money(b.total)}`))
      : '';

    $('dayendByType').innerHTML = data.byType.length
      ? `<div class="card"><h3 style="margin-top:0">By voucher type</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Voucher type</th><th class="num">Count</th><th class="num">Total</th></tr></thead>
          <tbody>${data.byType.map((g) => `<tr><td>${esc(g.type)}</td>
            <td class="num">${g.count}</td><td class="num">${money(g.total)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><th>Total</th><th class="num">${data.voucherCount}</th>
            <th class="num">${money(data.byType.reduce((sum, g) => sum + g.total, 0))}</th></tr></tfoot>
        </table></div></div>`
      : '<p class="empty">Nothing was entered on this date.</p>';

    $('dayendCash').innerHTML = `<div class="card"><h3 style="margin-top:0">Cash and bank, as they stand now</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Account</th><th>Group</th><th class="num">Balance</th></tr></thead>
        <tbody>${data.cashBank.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.group)}</td>
          <td class="num">${money(Math.abs(l.balance))} ${l.balance >= 0 ? 'Dr' : 'Cr'}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="2">Total in hand</th>
          <th class="num">${money(Math.abs(data.cashBankTotal))} ${data.cashBankTotal >= 0 ? 'Dr' : 'Cr'}</th></tr></tfoot>
      </table></div></div>`;

    $('dayendEntries').innerHTML = data.entries.length
      ? `<div class="card"><h3 style="margin-top:0">Every entry on this day</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>No.</th><th>Party</th><th>Reference</th>
            <th class="num">Amount</th><th></th></tr></thead>
          <tbody>${data.entries.map((e) => `<tr><td>${esc(e.type)}</td><td>${esc(e.voucherNo)}</td>
            <td>${esc(e.party || '—')}</td><td>${esc(e.reference || '—')}</td>
            <td class="num">${money(e.total)}</td>
            <td>${e.reference ? `<button class="btn small" data-print-bill="${esc(e.reference)}"
                  data-bill-party="${esc(e.party || '')}" data-bill-date="${esc(data.date)}"
                  title="Print this bill for the customer">Print</button>` : ''}</td></tr>`).join('')}</tbody>
        </table></div></div>`
      : '';
  } catch (err) {
    showError('dayendMessages', err);
    clearNode('dayendByType');
  }
}

$('btnLoadDayEnd').onclick = () => loadDayEnd();
$('deDate').addEventListener('change', () => loadDayEnd());

$('btnPrintDayEnd').onclick = () => {
  const data = state.dayEnd;
  if (!data) return toast('Show the summary first.', true);

  const body = `
    <div class="doc-head">
      <div class="doc-company">${esc(data.company || state.company || 'Company')}</div>
      <div class="doc-title">Day End Summary</div>
    </div>

    <div class="doc-meta">
      <div><span class="cap">Date</span><strong>${showDate(data.date)}</strong></div>
      <div><span class="cap">Vouchers</span>${data.voucherCount}</div>
      <div><span class="cap">Printed</span>${showDate(todayIso())}</div>
    </div>

    <table>
      <thead><tr><th>Voucher type</th><th class="num">Count</th><th class="num">Total</th></tr></thead>
      <tbody>${data.byType.map((g) => `<tr><td>${esc(g.type)}</td>
        <td class="num">${g.count}</td><td class="num">${money(g.total)}</td></tr>`).join('')
        || '<tr><td colspan="3">Nothing was entered on this date.</td></tr>'}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${data.voucherCount}</td>
        <td class="num">${money(data.byType.reduce((sum, g) => sum + g.total, 0))}</td></tr></tfoot>
    </table>

    <table>
      <thead><tr><th>Cash / bank account</th><th class="num">Balance</th></tr></thead>
      <tbody>${data.cashBank.map((l) => `<tr><td>${esc(l.name)}</td>
        <td class="num">${money(Math.abs(l.balance))} ${l.balance >= 0 ? 'Dr' : 'Cr'}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total in hand</td>
        <td class="num">${money(Math.abs(data.cashBankTotal))} ${data.cashBankTotal >= 0 ? 'Dr' : 'Cr'}</td></tr></tfoot>
    </table>

    ${data.openDayBills.length ? `
      <p class="note"><strong>Not yet saved to Tally:</strong>
      ${data.openDayBills.length} day bill(s) worth ${money(data.openDayBillsTotal)} —
      ${data.openDayBills.map((b) => esc(b.party)).join(', ')}.</p>` : ''}

    <div class="sign"><div>Checked by</div><div>for ${esc(data.company || 'Company')}</div></div>
    <div class="foot">Printed ${showDate(todayIso())} from Tally Desk</div>`;

  openPrintWindow(`Day End ${data.date}`, body);
};

/* ------------------------------------------------------------- Settings */

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    $('setHost').value = settings.host;
    $('setPort').value = settings.port;

    const status = await api('/api/status');
    const names = status.companies.map((c) => c.name);
    $('setCompany').innerHTML = `<option value="">Whichever company is open</option>`
      + names.map((n) => `<option value="${esc(n)}"${n === settings.company ? ' selected' : ''}>${esc(n)}</option>`).join('');

    const { items } = await api('/api/posted');
    $('postedList').innerHTML = items.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Type</th><th>Party</th><th>Reference</th><th class="num">Amount</th></tr></thead>
          <tbody>${items.map((r) => `
            <tr>
              <td>${esc(new Date(r.postedAt).toLocaleString('en-IN'))}</td>
              <td>${esc(r.kind)}</td><td>${esc(r.party)}</td><td>${esc(r.reference || '—')}</td>
              <td class="num">${money(r.total)}</td>
            </tr>`).join('')}
          </tbody></table></div>`
      : '<p class="empty">Nothing has been saved from this program yet.</p>';
  } catch (err) {
    showError('postedList', err);
  }
}

$('btnSaveSettings').onclick = async () => {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        host: $('setHost').value,
        port: Number($('setPort').value),
        company: $('setCompany').value,
      }),
    });
    state.options = null;
    toast('Settings saved');
    await refreshStatus();
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
};

$('btnRunDiag').onclick = async () => {
  spinner('diagOutput');
  try {
    const result = await api('/api/diagnostics', {
      method: 'POST',
      body: JSON.stringify({ request: $('diagRequest').value }),
    });
    state.diagnostic = result;
    $('diagOutput').innerHTML = `
      <p class="hint">${result.bytes.toLocaleString('en-IN')} characters in ${result.tookMs} ms.</p>
      <h3>Sent</h3><pre class="raw">${esc(result.request)}</pre>
      <h3>Received</h3><pre class="raw">${esc(result.response.slice(0, 20000))}</pre>`;
  } catch (err) {
    showError('diagOutput', err);
  }
};

$('btnCopyDiag').onclick = async () => {
  if (!state.diagnostic) return toast('Run a diagnostic first.', true);
  const text = `--- SENT ---\n${state.diagnostic.request}\n\n--- RECEIVED ---\n${state.diagnostic.response}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy — select the text and copy it manually.', true);
  }
};

/* ----------------------------------------------------------------- start */

(async function start() {
  $('todayLabel').textContent = showDate(todayIso());
  await refreshStatus();
  showView(location.hash.slice(1) || 'outstanding');
  // A light re-check keeps the badge honest if Tally is closed while this is open.
  setInterval(refreshStatus, 60000);
})();
