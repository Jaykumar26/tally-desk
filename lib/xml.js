'use strict';

/*
 * Minimal XML support, tuned to what TallyPrime's HTTP gateway actually sends.
 *
 * Tally's XML is plain: no namespaces to resolve, tag names that contain dots
 * (ALLLEDGERENTRIES.LIST), and occasional control characters embedded in names
 * where two masters share a display name. A general parser would be a
 * dependency for very little, and this project stays dependency-free so it can
 * be copied onto a shop PC that has no internet.
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return match;
      // Tally distinguishes same-named masters with control chars (&#4;).
      // They are invisible inside Tally, so drop them rather than leak them.
      if (code < 32) return '';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Finds the '>' that closes a tag, ignoring any that sit inside attribute quotes.
function findTagEnd(xml, start) {
  let quote = null;
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(source) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(source)) !== null) {
    attrs[match[1].toUpperCase()] = decodeEntities(match[3] !== undefined ? match[3] : match[4] || '');
  }
  return attrs;
}

function makeNode(name, attrs) {
  return { name, attrs, children: [], text: '' };
}

/** Parses an XML document into a tree of { name, attrs, children, text }. */
function parse(xml) {
  const root = makeNode('#ROOT', {});
  const stack = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, end === -1 ? xml.length : end);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = findTagEnd(xml, lt);
      i = end === -1 ? xml.length : end + 1;
      continue;
    }

    const end = findTagEnd(xml, lt);
    if (end === -1) break;
    const raw = xml.slice(lt + 1, end).trim();
    i = end + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toUpperCase();
      // Tolerate a stray close tag rather than discard the rest of the reply.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/\s/);
    const name = (space === -1 ? body : body.slice(0, space)).toUpperCase();
    const node = makeNode(name, space === -1 ? {} : parseAttrs(body.slice(space)));
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** First direct child with the given tag name, or null. */
function child(node, name) {
  if (!node) return null;
  const wanted = name.toUpperCase();
  return node.children.find((c) => c.name === wanted) || null;
}

/** All direct children with the given tag name. */
function childrenNamed(node, name) {
  if (!node) return [];
  const wanted = name.toUpperCase();
  return node.children.filter((c) => c.name === wanted);
}

function textOf(node) {
  return node ? node.text.trim() : '';
}

/** Text of the first direct child with the given name. */
function value(node, name, fallback = '') {
  const found = child(node, name);
  if (!found) return fallback;
  const text = found.text.trim();
  return text === '' ? fallback : text;
}

/** Text of whichever of the given names exists first — Tally renames tags between versions. */
function valueAny(node, names, fallback = '') {
  for (const name of names) {
    const found = value(node, name, '');
    if (found !== '') return found;
  }
  return fallback;
}

/** Every descendant with the given tag name, in document order. */
function findAll(node, name, out = []) {
  if (!node) return out;
  const wanted = name.toUpperCase();
  for (const c of node.children) {
    if (c.name === wanted) out.push(c);
    findAll(c, wanted, out);
  }
  return out;
}

/** First descendant with the given tag name, depth-first. */
function findFirst(node, name) {
  if (!node) return null;
  const wanted = name.toUpperCase();
  for (const c of node.children) {
    if (c.name === wanted) return c;
    const deeper = findFirst(c, wanted);
    if (deeper) return deeper;
  }
  return null;
}

module.exports = {
  parse,
  escapeXml,
  decodeEntities,
  child,
  childrenNamed,
  textOf,
  value,
  valueAny,
  findAll,
  findFirst,
};
