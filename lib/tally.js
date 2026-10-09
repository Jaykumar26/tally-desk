'use strict';

const http = require('node:http');
const { parse, findAll, textOf } = require('./xml');

/**
 * Talks to Tally's HTTP-XML gateway.
 *
 * TallyPrime listens on port 9000 once "TallyPrime acts as" is set to Server
 * or Both under F1 -> Settings -> Connectivity. Every exchange is a POST of an
 * <ENVELOPE> to "/" — there are no other endpoints and no authentication, which
 * is exactly why this app only ever binds to the local machine.
 */

class TallyError extends Error {
  constructor(message, code = 'TALLY_ERROR', detail = '') {
    super(message);
    this.name = 'TallyError';
    this.code = code;
    this.detail = detail;
  }
}

function friendlyNetworkMessage(code, cfg) {
  const where = `${cfg.host}:${cfg.port}`;
  switch (code) {
    case 'ECONNREFUSED':
      return `Tally is not answering on ${where}. Open TallyPrime, press F1 -> Settings -> Connectivity, and set "TallyPrime acts as" to Both (or Server).`;
    case 'ETIMEDOUT':
    case 'TIMEOUT':
      return `Tally did not reply within ${Math.round(cfg.timeoutMs / 1000)} seconds. It is usually showing a dialog box on screen that needs to be closed, or the report is very large.`;
    case 'ECONNRESET':
      return 'Tally closed the connection midway. This normally means it was busy or a company was being opened or closed.';
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
      return `Cannot reach the computer "${cfg.host}". Check the address in Settings.`;
    default:
      return `Could not talk to Tally at ${where} (${code || 'unknown error'}).`;
  }
}

/** POSTs an envelope and returns the decoded response body as text. */
function post(xml, cfg) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(xml, 'utf8');
    const req = http.request(
      {
        host: cfg.host,
        port: cfg.port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'text/xml;charset=utf-8',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(decodeBody(Buffer.concat(chunks))));
        res.on('error', (err) => reject(new TallyError(friendlyNetworkMessage(err.code, cfg), err.code)));
      },
    );

    req.setTimeout(cfg.timeoutMs, () => {
      req.destroy(new TallyError(friendlyNetworkMessage('TIMEOUT', cfg), 'TIMEOUT'));
    });
    req.on('error', (err) => {
      reject(err instanceof TallyError ? err : new TallyError(friendlyNetworkMessage(err.code, cfg), err.code));
    });
    req.end(payload);
  });
}

/**
 * Tally's default export encoding is ISO-8859-1, but it will emit UTF-8 or
 * UTF-16 depending on version and the company's language settings. Sniff the
 * declaration rather than assuming, or party names come back as mojibake.
 */
function decodeBody(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }

  const head = buffer.subarray(0, 200).toString('latin1');
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  const encoding = declared ? declared[1].toLowerCase() : '';
  if (encoding === 'utf-8' || encoding === 'utf8') return buffer.toString('utf8');
  if (encoding === 'utf-16' || encoding === 'utf-16le' || encoding === 'unicode') return buffer.toString('utf16le');
  return buffer.toString('latin1');
}

/**
 * POSTs an envelope, parses the reply, and turns Tally's own error reporting
 * into a thrown TallyError. Returns { doc, raw }.
 *
 * Tally signals trouble with <LINEERROR> — present but empty on success — and
 * occasionally with a bare <RESPONSE> containing a message and no data.
 */
async function request(xml, cfg) {
  const raw = await post(xml, cfg);

  if (!raw.trim().startsWith('<')) {
    throw new TallyError(
      'Tally replied with something that is not XML. The port may be in use by another program.',
      'BAD_RESPONSE',
      raw.slice(0, 400),
    );
  }

  const doc = parse(raw);
  const errors = findAll(doc, 'LINEERROR').map(textOf).filter(Boolean);
  if (errors.length) {
    throw new TallyError(explainTallyError(errors[0]), 'TALLY_REJECTED', errors.join(' | '));
  }

  return { doc, raw };
}

/** Rewrites the handful of Tally error strings a shop user will actually hit. */
function explainTallyError(message) {
  const text = String(message);
  if (/no company/i.test(text)) {
    return 'No company is open in Tally. Open the company first, then try again.';
  }
  if (/could not (find|set) ['"]?ledger/i.test(text)) {
    return `Tally could not find one of the ledgers used. ${text}`;
  }
  if (/unknown request|could not find report/i.test(text)) {
    return `Tally did not recognise this request — it may be a different Tally version. ${text}`;
  }
  return text;
}

module.exports = { request, post, decodeBody, TallyError };
