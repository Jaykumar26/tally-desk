'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const api = require('./lib/api');
const vouchers = require('./lib/vouchers');
const daybills = require('./lib/daybills');
const requests = require('./lib/requests');
const tally = require('./lib/tally');
const fmt = require('./lib/format');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  // Where Tally is listening. Leave as localhost when this runs on the Tally PC.
  host: '127.0.0.1',
  port: 9000,
  // Blank means "whichever company is currently open in Tally".
  company: '',
  // Port this interface itself serves on.
  appPort: 4000,
  timeoutMs: 60000,
  cacheMs: 20000,
};

function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // First run, or the file was hand-edited into invalid JSON. Defaults apply.
  }
  // Environment overrides exist so the demo can point at the mock gateway
  // without rewriting the user's saved config.
  const fromEnv = {};
  if (process.env.TALLY_HOST) fromEnv.host = process.env.TALLY_HOST;
  if (process.env.TALLY_PORT) fromEnv.port = Number(process.env.TALLY_PORT);
  if (process.env.TALLY_DESK_PORT) fromEnv.appPort = Number(process.env.TALLY_DESK_PORT);

  return { ...DEFAULT_CONFIG, ...stored, ...fromEnv, dataDir: path.join(ROOT, 'data') };
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  delete next.dataDir;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  api.clearCache();
  return loadConfig();
}

let config = loadConfig();

/* ------------------------------------------------------------- http utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Expected JSON in the request body.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);

  // Refuse anything that escapes public/, however it was spelled.
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.readFile(target, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ----------------------------------------------------------------- routes */

const routes = {
  /** Is Tally reachable, and which company are we reading? */
  'GET /api/status': async () => {
    try {
      const companies = await api.getCompanies(config);
      const active = config.company || (companies[0] && companies[0].name) || '';
      const licence = await api.getLicense(config);
      return {
        connected: true,
        companies,
        company: active,
        licence,
        companyPinned: Boolean(config.company),
        gateway: `${config.host}:${config.port}`,
        today: fmt.todayIso(),
      };
    } catch (err) {
      return {
        connected: false,
        error: err.message,
        code: err.code || 'UNKNOWN',
        companies: [],
        company: config.company,
        gateway: `${config.host}:${config.port}`,
        today: fmt.todayIso(),
      };
    }
  },

  'GET /api/outstanding': async ({ query }) => {
    const kind = query.get('kind') === 'payable' ? 'payable' : 'receivable';
    if (query.get('refresh') === '1') api.clearCache();
    return api.getOutstanding(config, kind);
  },

  'GET /api/parties': async ({ query }) => {
    const all = query.get('all') === '1';
    const items = await api.findParties(config, query.get('q') || '', {
      partiesOnly: !all,
      limit: Number(query.get('limit')) || 50,
    });
    return { items };
  },

  'GET /api/party': async ({ query }) => {
    const name = query.get('name') || '';
    const party = await api.getParty(config, name);
    if (!party) {
      const err = new Error(`No ledger named "${name}" was found in Tally.`);
      err.status = 404;
      throw err;
    }
    return party;
  },

  'GET /api/statement': async ({ query }) => {
    const year = fmt.financialYear();
    return api.getStatement(
      config,
      query.get('name') || '',
      query.get('from') || year.from,
      query.get('to') || fmt.todayIso(),
    );
  },

  'GET /api/stock': async ({ query }) => {
    if (query.get('refresh') === '1') api.clearCache();
    const items = await api.getStock(config);
    const q = query.get('q') || '';
    const matched = api.search(items, q, (i) => `${i.name} ${i.partNo}`, Number(query.get('limit')) || 100);
    return {
      items: matched,
      totalItems: items.length,
      totalValue: items.reduce((sum, i) => sum + i.value, 0),
    };
  },

  'GET /api/voucher-options': async () => api.getVoucherOptions(config),

  /** One saved voucher, fetched so an existing bill can be reprinted. */
  'GET /api/voucher': async ({ query }) => {
    const reference = query.get('ref') || '';
    const found = await api.findVoucher(config, {
      reference,
      party: query.get('party') || '',
      date: query.get('date') || '',
    });
    if (!found) {
      const err = new Error(`No voucher for "${reference}" was found in Tally. It may have been entered without that reference.`);
      err.status = 404;
      throw err;
    }
    return found;
  },

  'GET /api/posted': async () => ({ items: vouchers.recentlyPosted(config) }),

  /*
   * Running bills for the day. These live in a local file, NOT in Tally, until
   * the save route posts them — every response says so through `inTally:false`
   * so the screen can never imply otherwise.
   */
  'GET /api/daybills': async ({ query }) => ({
    inTally: false,
    date: query.get('date') || fmt.todayIso(),
    items: daybills.list(config, { date: query.get('date') || fmt.todayIso() }),
  }),

  'POST /api/daybills/create': async ({ body }) => daybills.create(config, body),
  'POST /api/daybills/add-lines': async ({ body }) => daybills.addLines(config, body.id, body.lines),
  'POST /api/daybills/remove-line': async ({ body }) => daybills.removeLine(config, body.id, Number(body.index)),
  'POST /api/daybills/update': async ({ body }) => daybills.update(config, body.id, body),
  'POST /api/daybills/discard': async ({ body }) => daybills.discard(config, body.id),

  /** Dry run: what this day bill would post, validated against Tally's masters. */
  'POST /api/daybills/preview': async ({ body }) => {
    const bill = requireDayBill(body.id);
    const options = await api.getVoucherOptions(config);
    return vouchers.buildSalesPreview(config, daybills.toSalesInput(bill, options.taxLedgers));
  },

  'POST /api/daybills/save': async ({ body }) => {
    requireConfirmation(body);
    const bill = requireDayBill(body.id);
    const options = await api.getVoucherOptions(config);
    const posted = await vouchers.postSales(config, {
      ...daybills.toSalesInput(bill, options.taxLedgers),
      confirmed: true,
    });
    // Only clear the local copy once Tally has actually accepted it.
    daybills.markSaved(config, bill.id);
    return posted;
  },

  /**
   * End of day: post every open bill. Each is independent, so one failure
   * cannot roll back or block the rest — the caller is told exactly which
   * succeeded and which did not.
   */
  'POST /api/daybills/save-all': async ({ body }) => {
    requireConfirmation(body);
    const options = await api.getVoucherOptions(config);
    const wanted = Array.isArray(body.ids) && body.ids.length
      ? body.ids
      : daybills.list(config, { date: fmt.todayIso() }).map((b) => b.id);

    const saved = [];
    const failed = [];
    for (const id of wanted) {
      const bill = daybills.get(config, id);
      if (!bill) {
        failed.push({ id, party: '(gone)', error: 'The bill was no longer there.' });
        continue;
      }
      try {
        const posted = await vouchers.postSales(config, {
          ...daybills.toSalesInput(bill, options.taxLedgers),
          confirmed: true,
        });
        daybills.markSaved(config, id);
        saved.push(posted.record);
      } catch (err) {
        failed.push({
          id,
          party: bill.party,
          error: err.message,
          problems: err.problems || [],
        });
      }
    }
    return { saved, failed };
  },

  /**
   * The closing report: what was entered today, where the cash stands, and
   * anything still sitting in Day Bills that has not reached Tally.
   */
  'GET /api/dayend': async ({ query }) => {
    const date = query.get('date') || fmt.todayIso();
    const [summary, company] = await Promise.all([
      api.getDaySummary(config, date),
      api.activeCompany(config),
    ]);
    const open = daybills.list(config, { date });
    return {
      ...summary,
      company,
      openDayBills: open,
      openDayBillsTotal: open.reduce((sum, b) => sum + b.total, 0),
    };
  },

  'GET /api/settings': async () => {
    const { dataDir, ...visible } = config;
    return visible;
  },

  'POST /api/settings': async ({ body }) => {
    const patch = {};
    if (typeof body.host === 'string') patch.host = body.host.trim() || '127.0.0.1';
    if (body.port !== undefined) patch.port = Number(body.port) || 9000;
    if (typeof body.company === 'string') patch.company = body.company.trim();
    if (body.timeoutMs !== undefined) patch.timeoutMs = Math.max(5000, Number(body.timeoutMs) || 60000);
    config = saveConfig(patch);
    const { dataDir, ...visible } = config;
    return visible;
  },

  'POST /api/refresh': async () => {
    api.clearCache();
    return { ok: true };
  },

  /**
   * Raw XML in and out for a named request. This exists so that when something
   * looks wrong on the real company, the exact reply can be copied out and
   * examined without guessing at what Tally sent.
   */
  'POST /api/diagnostics': async ({ body }) => {
    const year = fmt.financialYear();
    const builders = {
      companies: () => requests.companies(),
      ledgers: () => requests.ledgers(config.company),
      bills: () => requests.bills(config.company),
      stock: () => requests.stockItems(config.company),
      voucherTypes: () => requests.voucherTypes(config.company),
      vouchers: () => requests.partyVouchers(config.company, body.from || year.from, body.to || fmt.todayIso()),
    };
    const build = builders[body.request];
    if (!build) {
      const err = new Error(`Unknown diagnostic request. Choose one of: ${Object.keys(builders).join(', ')}.`);
      err.status = 400;
      throw err;
    }
    const sent = build();
    const started = Date.now();
    const { raw } = await tally.request(sent, config);
    return { request: sent, response: raw, tookMs: Date.now() - started, bytes: raw.length };
  },
};

/*
 * The write paths: one preview and one post route per voucher type, generated
 * from a single list so a type cannot be added to the engine and forgotten
 * here. Every post requires confirmed:true, so a stray or repeated request
 * cannot record a voucher on its own.
 */
const VOUCHER_KINDS = {
  sales: vouchers.buildSalesPreview,
  purchase: vouchers.buildPurchasePreview,
  creditnote: vouchers.buildCreditNotePreview,
  debitnote: vouchers.buildDebitNotePreview,
  receipt: vouchers.buildReceiptPreview,
  payment: vouchers.buildPaymentPreview,
  contra: vouchers.buildContraPreview,
  journal: vouchers.buildJournalPreview,
};

for (const [kind, buildPreview] of Object.entries(VOUCHER_KINDS)) {
  if (!buildPreview) throw new Error(`No preview builder registered for "${kind}".`);
  routes[`POST /api/preview/${kind}`] = async ({ body }) => buildPreview(config, body);
  routes[`POST /api/post/${kind}`] = async ({ body }) => {
    requireConfirmation(body);
    return vouchers.postVoucher(config, body, kind);
  };
}

function requireDayBill(id) {
  const bill = daybills.get(config, id);
  if (!bill) {
    const err = new Error('That day bill no longer exists. It may already have been saved to Tally.');
    err.status = 404;
    throw err;
  }
  if (!bill.lines.length) {
    const err = new Error('This bill has no items on it yet.');
    err.status = 400;
    throw err;
  }
  return bill;
}

function requireConfirmation(body) {
  if (body.confirmed !== true) {
    const err = new Error('This voucher was not confirmed, so nothing was sent to Tally.');
    err.status = 400;
    throw err;
  }
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];

  if (!handler) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint.' });
    return serveStatic(req, res, url.pathname);
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const payload = await handler({ query: url.searchParams, body, req });
    sendJson(res, 200, payload);
  } catch (err) {
    if (err instanceof vouchers.ValidationError) {
      return sendJson(res, 400, { error: 'Please fix these first:', problems: err.problems });
    }
    const status = err.status || (err.name === 'TallyError' ? 502 : 500);
    if (!err.status && err.name !== 'TallyError') console.error('[tally-desk]', err);
    sendJson(res, status, {
      error: err.message || 'Something went wrong.',
      code: err.code || 'ERROR',
      detail: err.detail || '',
    });
  }
});

// Bound to the loopback address on purpose: Tally's gateway has no
// authentication, and neither does this. Nothing outside this PC can reach it.
server.listen(config.appPort, '127.0.0.1', () => {
  console.log('');
  console.log('  Tally Desk is running.');
  console.log(`  Open this in the browser:  http://localhost:${config.appPort}`);
  console.log(`  Reading Tally at:          ${config.host}:${config.port}`);
  console.log('');
  console.log('  Keep this window open. Close it to stop.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.appPort} is already in use — Tally Desk may already be running.`);
    console.error('  Close the other window, or change "appPort" in config.json.\n');
    process.exit(1);
  }
  throw err;
});
