'use strict';

/* Conversions between Tally's on-the-wire text and plain JS values. */

/**
 * Tally writes amounts as bare strings: "1180.00", "-1180.00", sometimes with
 * stray spaces. Negative means Debit in voucher entries and Credit in closing
 * balances — the caller decides what the sign means, this only reads it.
 */
function toNumber(text, fallback = 0) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : fallback;
  if (!text) return fallback;
  const cleaned = String(text).replace(/[,\s ]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Quantities arrive as "10 Nos", "-5.5 Kg", "2 Box of 12 Nos" or plain "10".
 * Returns { qty, unit } keeping only the primary unit.
 */
function toQuantity(text) {
  if (!text) return { qty: 0, unit: '' };
  const match = /^\s*(-?[\d,]*\.?\d+)\s*(.*)$/.exec(String(text));
  if (!match) return { qty: 0, unit: '' };
  const unit = match[2].split(/\s+of\s+/i)[0].trim();
  return { qty: toNumber(match[1]), unit };
}

/** Rates arrive as "100.00/Nos". Returns { rate, unit }. */
function toRate(text) {
  if (!text) return { rate: 0, unit: '' };
  const [amount, unit = ''] = String(text).split('/');
  return { rate: toNumber(amount), unit: unit.trim() };
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Accepts Tally's storage format (20260815) and the display format
 * (15-Aug-2026) that reports fall back to. Returns an ISO date string
 * (YYYY-MM-DD) or '' when unreadable.
 */
function toIsoDate(text) {
  if (!text) return '';
  const raw = String(text).trim();

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  const display = /^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})$/.exec(raw);
  if (display) {
    const month = MONTHS[display[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return '';
    let year = Number.parseInt(display[3], 10);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return `${year}-${String(month + 1).padStart(2, '0')}-${display[1].padStart(2, '0')}`;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
}

/** ISO date (or Date) -> Tally's YYYYMMDD storage format. */
function toTallyDate(input) {
  if (!input) return '';
  if (input instanceof Date) {
    return [
      input.getFullYear(),
      String(input.getMonth() + 1).padStart(2, '0'),
      String(input.getDate()).padStart(2, '0'),
    ].join('');
  }
  const iso = toIsoDate(input);
  return iso ? iso.replace(/-/g, '') : '';
}

/** Whole days between two ISO dates; negative when `to` precedes `from`. */
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

function addDays(iso, days) {
  if (!iso) return '';
  const base = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(base)) return '';
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Tally credit periods read as "30 Days", "1 Month", "45 Days" or ''.
 * Returns a day count, or null when there is no credit period set.
 */
function creditPeriodToDays(text) {
  if (!text) return null;
  const match = /(-?\d+)\s*(day|week|month|year)?/i.exec(String(text));
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  if (!Number.isFinite(count)) return null;
  const unit = (match[2] || 'day').toLowerCase();
  const multiplier = { day: 1, week: 7, month: 30, year: 365 }[unit] || 1;
  return count * multiplier;
}

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * The Indian financial year containing `iso` runs 1 April -> 31 March.
 * Used as the default reporting window when the company's own book dates
 * are unavailable.
 */
function financialYear(iso = todayIso()) {
  const [year, month] = iso.split('-').map(Number);
  const startYear = month >= 4 ? year : year - 1;
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/** Rounds to 2 decimals without float dust, for money that goes back to Tally. */
function money(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  toNumber,
  toQuantity,
  toRate,
  toIsoDate,
  toTallyDate,
  daysBetween,
  addDays,
  creditPeriodToDays,
  todayIso,
  financialYear,
  money,
};
