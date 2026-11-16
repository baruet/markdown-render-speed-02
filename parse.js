// parse.js — a fast, dependency-free Markdown renderer producing byte-identical
// HTML to marked 18.1.3 with default options (gfm true, breaks false).
// Written from scratch against the CommonMark 0.31.2 / GFM 0.29 specs and
// marked's observed output. No imports, no caching across parse() calls,
// no lookup keyed on input text or hash.

// ---------- character classification ----------
// ASCII fast paths; non-ASCII falls back to regex tests.
const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_SPACE = /\s/;
const RE_ALNUM = /[\p{L}\p{N}]/u;
const RE_NON_SPACE = /[^ ]/;

// Document-level inline lexer state, shared across every inline string in
// one parse() call (marked keeps inLink/inRawBlock on the Lexer instance,
// so an unclosed <a> — even a self-closing `<a />` — disables extended
// autolinks for the rest of the document, doc-06). Reset at the start of
// parse(); parse() is synchronous and never reentrant, so module-level
// state is safe here.
const inlineState = { inLink: false, inRawBlock: false };

// ---------- marked's emStrong/del masking (#n) ----------
// Marked computes its emphasis/del closer scan over a MASKED copy of the
// inline source: code spans, links and HTML are replaced by same-length
// `[aaa...]` placeholders, so emphasis delimiters inside those regions
// never form (they are invisible to the closer scan and to the
// last-possible-closer bound). The masking is two passes, both
// length-preserving, so positions in the masked source match the raw one:
//  1. anyPunctuationOutsideCode (Ot): a code span's INNER backticks are
//     replaced by '+' (the span itself is kept). This is what lets a
//     `` `` a ` b `` `` code span be masked at all — its inner single
//     backtick would otherwise defeat blockSkip's same-length closer rule.
//     Escaped punctuation is also replaced by '+' (same length).
//  2. blockSkip (ot): each link / code span / HTML tag match is replaced
//     by '[' + 'a'.repeat(len-2) + ']'. The link pattern's label uses the
//     STRICT same-length backtick rule `(?<a>`+)[^`]+\k<a>(?!`)`, and its
//     destination allows spaces and one level of balanced parens.
// A delimiter run whose start falls inside a masked interval is left as
// literal text (never added to `delims`). This is what suppresses the
// `_..._` inside failed `[...](...)` labels (doc-16/20/23) and the
// wide-context `_`/`__` swallowed by a giant masked code span
// (doc-09/28/35). Only the mask intervals are needed, not the masked
// string itself, so the two passes only record intervals.
const RE_MASK_OT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_MASK_BLOCKSKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

function computeMasked(src) {
  const masked = new Uint8Array(src.length);
  if (src.indexOf('*') === -1 && src.indexOf('_') === -1 && src.indexOf('~') === -1) return masked;
  // No blockSkip match is possible without a '[', a backtick, or a '<'.
  if (src.indexOf('[') === -1 && src.indexOf('`') === -1 && src.indexOf('<') === -1) return masked;
  // The Ot pass only changes blockSkip matching via backticks (inner
  // backticks of a code span become '+'); with no backtick it is a no-op.
  let ot = src;
  if (src.indexOf('`') !== -1) {
    RE_MASK_OT.lastIndex = 0;
    ot = src.replace(RE_MASK_OT, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  RE_MASK_BLOCKSKIP.lastIndex = 0;
  let m;
  while ((m = RE_MASK_BLOCKSKIP.exec(ot)) !== null) {
    const a = m.index, b = a + m[0].length;
    for (let k = a; k < b; k++) masked[k] = 1;
    if (m[0].length === 0) RE_MASK_BLOCKSKIP.lastIndex++;
  }
  return masked;
}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}
function isSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isSpaceCode(c);
  return RE_SPACE.test(ch);
}
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return RE_PUNCT.test(ch);
}
function isAlnum(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }
  return RE_ALNUM.test(ch);
}
function isWhitespaceLine(s, i, end) {
  for (; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------- HTML escaping ----------
// escapeHtml(s, encode): escape &, <, >, " and '.
// If encode is false, a bare & that starts a valid entity reference
// (&word; / &#digits; / &#xhex;) is left alone (marked's behavior for text
// and attributes). If encode is true (code content), & is always escaped,
// because entities are literal in code.
const ENT_DEC = /^#([0-9]{1,7});/;
const ENT_HEX = /^#[Xx]([A-Fa-f0-9]{1,6});/;
const ENT_WORD = /^\w+;/;

function escapeHtml(s, encode) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      if (!encode) {
        // A valid entity reference is left alone (text and attributes).
        const rest = s.slice(i + 1);
        if (ENT_DEC.test(rest) || ENT_HEX.test(rest) || ENT_WORD.test(rest)) continue;
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references (&#123; &#x1F;) in text. Named
// entities are passed through unchanged; bare & is left for the renderer
// to escape. A decoded code point of 0, >0x10FFFF, or a surrogate becomes
// U+FFFD; 38 (&) stays '&' (the renderer escapes it to &amp;).
function decodeNumericEntities(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) !== 38) { i++; continue; }
    const rest = s.slice(i + 1);
    let m = ENT_DEC.exec(rest);
    let code = -1;
    let adv = 0;
    if (m) {
      code = parseInt(m[1], 10);
      adv = 1 + m[0].length;
    } else {
      m = ENT_HEX.exec(rest);
      if (m) {
        code = parseInt(m[1], 16);
        adv = 1 + m[0].length;
      }
    }
    if (code >= 0) {
      let rep;
      if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) rep = '\uFFFD';
      else rep = String.fromCodePoint(code);
      out += s.slice(start, i) + rep;
      i += adv;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------- URL handling ----------
// encodeURI with %25 restored to %, matching marked. Returns null on failure.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (_) {
    return null;
  }
}

// ---------- backslash escapes ----------
// ASCII punctuation escapable by backslash (CommonMark).
function isEscapable(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// ---------- link reference label normalization ----------
// Trim, collapse internal whitespace runs to one space, case-fold.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Parse a link reference definition starting at the beginning of a line
// (after up to 3 spaces of indent). Returns {label, href, title, end} where
// end is the index just past the definition (including the trailing newline),
// or null. The definition may span up to 2 lines for the title.
// Used both for the pre-pass and by the block parser.
function parseLinkDef(src, start, end) {
  // start points at '[' (after indent already consumed by caller logic).
  let i = start;
  if (src.charCodeAt(i) !== 91) return null; // [
  i++;
  // label (marked's `le`): backslash-escapes, chars other than [ ] \ newline,
  // or a newline not followed by a blank line. No nested brackets.
  let label = '';
  let labelEnd = -1;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < end) { label += src[i] + src[i + 1]; i += 2; continue; }
      return null;
    }
    if (c === 93) { // ] closes the label
      labelEnd = i;
      break;
    }
    if (c === 91) return null; // [ is not allowed inside a label
    if (c === 10) {
      // newline allowed only if the next line is not blank
      let m = i + 1;
      while (m < end && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
      if (m >= end || src.charCodeAt(m) === 10) return null;
      label += src[i];
      i++;
      continue;
    }
    label += src[i];
    i++;
  }
  if (labelEnd === -1) return null;
  if (label.trim().length === 0) return null;
  i = labelEnd + 1;
  if (src.charCodeAt(i) !== 58) return null; // :
  i++;
  // optional spaces/tabs, at most one newline
  let nl = 0;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 10) { nl++; if (nl > 1) return null; i++; continue; }
    break;
  }
  // destination
  let href = '';
  if (src.charCodeAt(i) === 60) { // <...>
    i++;
    const ds = i;
    while (i < end) {
      const c = src.charCodeAt(i);
      if (c === 62) break; // >
      if (c === 10 || c === 60) return null;
      if (c === 92 && i + 1 < end) { i += 2; continue; }
      i++;
    }
    if (i >= end || src.charCodeAt(i) !== 62) return null;
    href = src.slice(ds, i);
    i++;
  } else {
    const ds = i;
    let parens = 0;
    while (i < end) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && i + 1 < end) { i += 2; continue; }
      if (c === 40) parens++;
      else if (c === 41) {
        if (parens === 0) break;
        parens--;
      }
      i++;
    }
    if (i === ds) return null; // empty destination
    href = src.slice(ds, i);
  }
  // unescape backslash punctuation in href
  href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  // optional title. Same-line: the remainder must be only whitespace, or
  // whitespace + a valid title + whitespace; anything else invalidates the
  // definition. Next-line: a valid title is used; an invalid one leaves the
  // def standing without it (the line becomes its own block).
  let title = null;
  let titleEnd = -1; // position just past a valid title
  // scan a title starting at `p` (a quote/paren char); returns {title, end}
  // where end is just past the closing quote, or null if invalid.
  const scanTitle = (p) => {
    const qc = src.charCodeAt(p);
    if (qc !== 34 && qc !== 39 && qc !== 40) return null;
    const close = qc === 40 ? 41 : qc;
    let k = p + 1;
    let t = '';
    while (k < end) {
      const c = src.charCodeAt(k);
      if (c === 92 && k + 1 < end) { t += src[k] + src[k + 1]; k += 2; continue; }
      if (c === close) {
        return { title: t.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1'), end: k + 1 };
      }
      if (c === 10) {
        let m = k + 1;
        while (m < end && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
        if (m >= end || src.charCodeAt(m) === 10) return null;
      }
      t += src[k];
      k++;
    }
    return null;
  };
  // remainder of the destination line must be only spaces/tabs, or a title
  let j = i;
  while (j < end && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  if (j >= end || src.charCodeAt(j) === 10) {
    // dest line is clean: try a title on the next line
    let nl = j < end ? j + 1 : end;
    let p = nl;
    while (p < end && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
    if (p < end && src.charCodeAt(p) !== 10) {
      const st = scanTitle(p);
      if (st) {
        let after = st.end;
        while (after < end && (src.charCodeAt(after) === 32 || src.charCodeAt(after) === 9)) after++;
        if (after >= end || src.charCodeAt(after) === 10) {
          title = st.title;
          titleEnd = st.end;
        }
      }
    }
  } else {
    // something follows the destination on this line: it must be a title
    // preceded by at least one space/tab
    if (j === i) return null;
    const st = scanTitle(j);
    if (!st) return null;
    let after = st.end;
    while (after < end && (src.charCodeAt(after) === 32 || src.charCodeAt(after) === 9)) after++;
    if (after < end && src.charCodeAt(after) !== 10) return null;
    title = st.title;
    titleEnd = st.end;
  }
  let endPos;
  if (titleEnd !== -1) {
    let k = titleEnd;
    while (k < end && src.charCodeAt(k) !== 10) k++;
    endPos = k < end ? k + 1 : k;
  } else {
    let k = i;
    while (k < end && src.charCodeAt(k) !== 10) k++;
    endPos = k < end ? k + 1 : k;
  }
  return { label: normalizeLabel(label), href, title, end: endPos };
}

// Collect link reference definitions from the whole document (forward
// references must resolve). Returns a Map label -> {href, title}.
// A definition is recognized at the start of a line (0-3 spaces indent)
// and only when it is a complete definition; the first definition for a
// label wins. Definitions inside fenced/indented code blocks are NOT
// collected (approximated by tracking fence state).
function collectLinkDefs(src) {
  const links = new Map();
  const n = src.length;
  let i = 0;
  let inFence = false;
  let fenceChar = 0;
  let fenceLen = 0;
  let inParagraph = false;
  // Content indent of the currently open top-level list item (-1 = none).
  // Used to detect when a fence inside a list item is abandoned: a line
  // with less indent than the item's content indent is outside the item,
  // so a fence living inside the item ends empty there (marked behavior;
  // a top-level fence keeps unindented content, a list-item fence does not).
  let listIndent = -1;
  // When inFence and the fence is inside a list item, the item's content
  // indent; a line with less indent abandons the fence. -1 = top-level fence.
  let fenceMinIndent = -1;
  // Whether a list-item fence has seen its first indented content line.
  // Only the FIRST content line can abandon the fence (doc-13); once a
  // line inside the item establishes it, later unindented lines are code.
  let fenceEstablished = false;
  // Does this line start a block that interrupts a paragraph?
  const interruptsPara = (lineStart, lineEnd, col, firstNonSpace) => {
    if (col > 3 || firstNonSpace >= lineEnd) return false;
    if (matchAtx(src, lineStart, lineEnd)) return true;
    if (matchHr(src, lineStart, lineEnd)) return true;
    if (matchHtmlBlock(src, lineStart, lineEnd, n, true) !== -1) return true;
    const fc = src.charCodeAt(firstNonSpace);
    if (fc === 62) return true; // >
    if (matchListItem(src, lineStart, lineEnd)) return true;
    // setext underline turns the paragraph into a heading
    const line = src.slice(lineStart, lineEnd);
    if (/^[ \t]*=+[ \t]*$/.test(line) || /^[ \t]*-+[ \t]*$/.test(line)) return true;
    return false;
  };
  while (i < n) {
    // find line start
    const lineStart = i;
    let j = i;
    while (j < n && src.charCodeAt(j) !== 10) j++;
    const lineEnd = j; // exclusive, before \n
    // indent (spaces/tabs expanded to col, tab = next multiple of 4)
    let col = 0;
    let k = lineStart;
    while (k < lineEnd) {
      const c = src.charCodeAt(k);
      if (c === 32) { col++; k++; }
      else if (c === 9) { col += 4 - (col % 4); k++; }
      else break;
    }
    const firstNonSpace = k;
    const blank = firstNonSpace >= lineEnd;
    if (blank) { inParagraph = false; i = lineEnd + 1; continue; }
    if (inFence) {
      // Is this line a closing-fence candidate for the current fence?
      let isClose = false;
      if (col <= 3 && firstNonSpace < lineEnd) {
        const fc = src.charCodeAt(firstNonSpace);
        if (fc === fenceChar) {
          let m = firstNonSpace;
          while (m < lineEnd && src.charCodeAt(m) === fc) m++;
          if (m - firstNonSpace >= fenceLen) {
            let ok = true;
            for (let p = m; p < lineEnd; p++) {
              if (src.charCodeAt(p) !== 32 && src.charCodeAt(p) !== 9) { ok = false; break; }
            }
            if (ok) isClose = true;
          }
        }
      }
      if (isClose) {
        // A closing fence must lie inside the list item (col >= its content
        // indent) to close a list-item fence. An unindented closing line
        // instead ends the item fence and opens a new top-level fence.
        if (fenceMinIndent < 0 || col >= fenceMinIndent) {
          inFence = false;
          fenceMinIndent = -1;
          fenceEstablished = false;
          i = lineEnd + 1;
          continue;
        }
        inFence = false;
        fenceMinIndent = -1;
        fenceEstablished = false;
        listIndent = -1;
        // fall through: the line opens a new top-level fence
      } else if (fenceMinIndent >= 0 && !fenceEstablished && col < fenceMinIndent) {
        // First content line of a list-item fence is outside the item: the
        // fence is abandoned (empty) and the line is a top-level block.
        inFence = false;
        fenceMinIndent = -1;
        fenceEstablished = false;
        listIndent = -1;
        // fall through to top-level processing of this line
      } else {
        // content line: the first indented content line establishes the fence
        if (fenceMinIndent >= 0 && !fenceEstablished) fenceEstablished = true;
        i = lineEnd + 1;
        continue;
      }
    }
    // list-item tracking (top-level lines only): a marker line starts an
    // item (record its content indent); a non-blank line with less indent
    // than the open item's content indent ends the item.
    if (col <= 3) {
      const c0 = src.charCodeAt(firstNonSpace);
      if (c0 === 42 || c0 === 43 || c0 === 45 || (c0 >= 48 && c0 <= 57)) {
        const item = matchListItem(src, lineStart, lineEnd);
        if (item) listIndent = listItemContentStart(src, lineStart, lineEnd, item).contentIndent;
        else if (listIndent >= 0 && col < listIndent) listIndent = -1;
      } else if (listIndent >= 0 && col < listIndent) {
        listIndent = -1;
      }
    }
    // check for opening fence
    if (col <= 3 && firstNonSpace < lineEnd) {
      const fc = src.charCodeAt(firstNonSpace);
      if (fc === 96 || fc === 126) {
        let m = firstNonSpace;
        while (m < lineEnd && src.charCodeAt(m) === fc) m++;
        if (m - firstNonSpace >= 3) {
          // backtick fence info must not contain a backtick
          let ok = true;
          if (fc === 96) {
            for (let p = m; p < lineEnd; p++) {
              if (src.charCodeAt(p) === 96) { ok = false; break; }
            }
          }
          if (ok) {
            inFence = true; fenceChar = fc; fenceLen = m - firstNonSpace;
            fenceMinIndent = (listIndent >= 0 && col >= listIndent) ? listIndent : -1;
            fenceEstablished = false;
            inParagraph = false;
          }
        }
      }
    }
    // A definition is only collected at a block start, never inside a
    // paragraph. A paragraph continuation line is skipped.
    if (inParagraph) {
      if (interruptsPara(lineStart, lineEnd, col, firstNonSpace)) {
        inParagraph = false;
      } else {
        i = lineEnd + 1;
        continue;
      }
    }
    // a definition inside a blockquote (> [foo]: /url) also applies globally
    if (!inFence && col <= 3 && firstNonSpace < lineEnd && src.charCodeAt(firstNonSpace) === 62) {
      let cs = firstNonSpace + 1;
      if (cs < lineEnd && (src.charCodeAt(cs) === 32 || src.charCodeAt(cs) === 9)) cs++;
      if (cs < lineEnd && src.charCodeAt(cs) === 91) {
        const def = parseLinkDef(src, cs, n);
        if (def && !links.has(def.label)) {
          links.set(def.label, { href: def.href, title: def.title });
        }
      }
    }
    // indented code blocks (4+ spaces) cannot contain link defs; skip if col>=4
    if (!inFence && col <= 3 && firstNonSpace < lineEnd && src.charCodeAt(firstNonSpace) === 91) {
      const def = parseLinkDef(src, firstNonSpace, n);
      if (def) {
        if (!links.has(def.label)) links.set(def.label, { href: def.href, title: def.title });
        // skip past the definition lines
        i = def.end;
        continue;
      }
    }
    // otherwise: does this line start a paragraph, or another block?
    if (!inFence && col <= 3) {
      if (!interruptsPara(lineStart, lineEnd, col, firstNonSpace)) {
        inParagraph = true;
      }
    }
    i = lineEnd + 1;
  }
  return links;
}
// ---------- inline parsing ----------
// Node types: text{code}, code, br, em, strong, del, link, image, html.
// Delimiter runs are text nodes registered in a delimiter list; emphasis is
// resolved after the scan of each inline level.

// Characters that can start an inline construct.
function isInlineSpecial(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 126 ||
    c === 91 || c === 93 || c === 60 || c === 33 || c === 10;
}

// Find the end of a code span: the next run of backticks of the same length.
// Returns the index just past the closing run, or -1.
function findCodeEnd(src, i, end, len) {
  // in a code span a backslash does NOT escape a backtick: the span ends at
  // the next run of exactly `len` backticks
  let j = i;
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 96) {
      let k = j;
      while (k < end && src.charCodeAt(k) === 96) k++;
      if (k - j === len) return k;
      j = k;
      continue;
    }
    j++;
  }
  return -1;
}

// Scan a reference label `[...]` for `[text][ref]`: marked's reflink uses
// `([^\]]*)`, so the label runs to the FIRST unescaped `]` (a `[` inside is
// allowed and stays part of the label). Returns {text, end} or null.
function scanRefLabel(src, i, end) {
  let j = i + 1;
  let text = '';
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < end) { text += src[j] + src[j + 1]; j += 2; continue; }
    if (c === 93) return { text, end: j + 1 };
    if (c === 10) {
      let m = j + 1;
      while (m < end && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
      if (m >= end || src.charCodeAt(m) === 10) return null;
    }
    text += src[j];
    j++;
  }
  return null;
}

// Scan a link label starting at src[i] === '['. Returns {text, end} where
// text is the raw label content (with escapes/code spans preserved) and end
// is the index just past the matching ']', or null if unbalanced.
// Brackets inside code spans and after backslashes are skipped.
function scanLabel(src, i, end) {
  let depth = 0;
  let j = i + 1;
  let text = '';
  let start = i + 1;
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      let k = j;
      while (k < end && src.charCodeAt(k) === 96) k++;
      // Marked's label pattern has a special case for a run of 2+
      // backticks immediately before ']': it is literal label content,
      // not a code-span opener (`` ``+(?=\]) ``). Without this, the
      // closing `` `` `` of `` `` a ` b `` `` would be treated as a new
      // opener and swallow the rest of the label looking for its closer.
      if (k - j >= 2 && k < end && src.charCodeAt(k) === 93) { j = k; continue; }
      // Marked's label pattern matches a code span leniently: the closer
      // is ANY run of backticks, not necessarily the same length as the
      // opener (`` `+(?!`)[^`]*?`+(?!`) ``). A strict same-length search
      // would miss the single-` closer in `` ``url` `` and swallow the
      // rest of the paragraph looking for a `` `` `` run, breaking the
      // link. So skip to the next backtick run of any length; if there
      // is none, the backticks are literal text.
      let m = k;
      let ce = -1;
      while (m < end) {
        if (src.charCodeAt(m) === 96) {
          let q = m;
          while (q < end && src.charCodeAt(q) === 96) q++;
          ce = q;
          break;
        }
        m++;
      }
      // no closing backtick run: marked's label pattern cannot match a
      // bare backtick run (it is not a code span without a closer, and
      // not the `` ``+(?=\]) `` literal case), so the whole label
      // fails and the link is left literal — e.g. `[at _node `` a ` b
      // ``_](...)` leaves the link unformed because the `` `` `` before
      // `_` has no closer. Return null instead of treating the
      // backticks as literal text.
      if (ce === -1) return null;
      j = ce;
      continue;
    }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) {
      if (depth === 0) {
        text = src.slice(start, j);
        return { text, end: j + 1 };
      }
      depth--;
      j++;
      continue;
    }
    if (c === 10) {
      // a blank line inside a label invalidates it
      let m = j + 1;
      while (m < end && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
      if (m >= end || src.charCodeAt(m) === 10) return null;
    }
    j++;
  }
  return null;
}

// Parse the destination + optional title after a link label.
// src[i] should be '('. Returns {href, title, end} or null.
// Handles <dest>, bare dest (balanced parens), and "title"/'title'/(title).
function parseLinkDestination(src, i, end) {
  if (src.charCodeAt(i) !== 40) return null; // (
  let j = i + 1;
  // skip spaces/tabs/newlines
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  let href = '';
  if (j < end && src.charCodeAt(j) === 60) { // <...>
    j++;
    const ds = j;
    while (j < end) {
      const c = src.charCodeAt(j);
      if (c === 62) break;
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < end) { j += 2; continue; }
      j++;
    }
    if (j >= end || src.charCodeAt(j) !== 62) return null;
    href = src.slice(ds, j);
    j++;
  } else {
    const ds = j;
    let parens = 0;
    while (j < end) {
      const c = src.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && j + 1 < end) { j += 2; continue; }
      if (c === 40) parens++;
      else if (c === 41) {
        if (parens === 0) break;
        parens--;
      }
      j++;
    }
    if (j === ds) {
      // empty destination is allowed only if next is ')' (after ws) — handled below
      href = '';
    } else {
      href = src.slice(ds, j);
    }
  }
  href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  // optional title (must be preceded by whitespace; a title may span lines
  // but not across a blank line, for all three quote styles)
  let title = null;
  let k = j;
  let sawNl = false;
  let sawWs = false;
  while (k < end) {
    const c = src.charCodeAt(k);
    if (c === 32 || c === 9) { sawWs = true; k++; continue; }
    if (c === 10) { if (sawNl) break; sawNl = true; sawWs = true; k++; continue; }
    break;
  }
  if (sawWs && k < end) {
    const qc = src.charCodeAt(k);
    if (qc === 34 || qc === 39 || qc === 40) {
      const close = qc === 40 ? 41 : qc;
      let m = k + 1;
      let t = '';
      let ok = false;
      while (m < end) {
        const c = src.charCodeAt(m);
        if (c === 92 && m + 1 < end) { t += src[m] + src[m + 1]; m += 2; continue; }
        if (c === close) { ok = true; break; }
        if (c === 10) {
          let p = m + 1;
          while (p < end && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
          if (p >= end || src.charCodeAt(p) === 10) { m = -1; break; }
        }
        t += src[m];
        m++;
      }
      if (m !== -1 && ok) {
        title = t.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        k = m + 1;
      }
    }
  }
  // skip trailing spaces/tabs/newlines, then expect ')'
  while (k < end) {
    const c = src.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10) k++;
    else break;
  }
  if (k >= end || src.charCodeAt(k) !== 41) return null;
  return { href, title, end: k + 1 };
}

// Marked's Be(): a link is rejected only when its text contains a `<` that
// starts an inline HTML tag or autolink whose match extends PAST the end of
// the link text (i.e. it would swallow the closing `](...)`). A tag or
// autolink fully inside the text is fine.
function linkTextHasTag(src, start, end) {
  // text = src[start..end)
  if (src.indexOf('<', start) === -1 || src.indexOf('<', start) >= end) return false;
  const textLen = end - start;
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c === 92) { i++; continue; } // backslash: skip next char
    if (c === 96) {
      // skip a code span inside the text
      let k = i;
      while (k < end && src.charCodeAt(k) === 96) k++;
      const ce = findCodeEnd(src, k, end, k - i);
      if (ce !== -1) { i = ce - 1; continue; }
      i = k - 1;
      continue;
    }
    if (c !== 60) continue; // <
    const rest = src.slice(i); // match against the full source (may run past end)
    const tm = RE_HTML_TAG.exec(rest);
    const am = tm ? null : RE_AUTOLINK.exec(rest);
    const o = tm || am;
    if (o) {
      if (o[0].length > textLen - (i - start)) return true;
      i += o[0].length - 1;
    }
  }
  return false;
}

// ---------- emphasis flanking ----------
function isLeftFlanking(src, i, end, runStart) {
  // char before runStart, char after run end (i)
  const prev = runStart > 0 ? src[runStart - 1] : '';
  const next = i < end ? src[i] : '';
  if (next === '' || isSpace(next)) return false;
  if (!isPunct(next)) return true;
  if (prev === '' || isSpace(prev)) return true;
  return isPunct(prev);
}
function isRightFlanking(src, i, end, runStart) {
  const prev = runStart > 0 ? src[runStart - 1] : '';
  const next = i < end ? src[i] : '';
  if (prev === '' || isSpace(prev)) return false;
  if (!isPunct(prev)) return true;
  if (next === '' || isSpace(next)) return true;
  return isPunct(next);
}

// ---------- extended autolinks (GFM) ----------
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9-]/;
// Try to match an extended autolink at src[i]. `prevOk` is true when the
// preceding char allows an autolink (start, space, *, _, ~, (). Returns
// {href, text, end} or null. Handles www., http(s)://, ftp://, and emails.
// Match a bare email address at position i (marked's It regex):
// local@domain, domain has >= 1 dot and ends with an alnum, and the char
// after the match must not be a word char or '-' (the (?![\w-]) lookahead).
// Returns {end} or null.
function matchEmailAt(src, i, end, allowTrailingUnderscore) {
  if (i >= end || !EMAIL_LOCAL.test(src[i])) return null;
  let j = i;
  while (j < end && EMAIL_LOCAL.test(src[j])) j++;
  if (j >= end || src.charCodeAt(j) !== 64) return null; // @
  let k = j + 1;
  const domStart = k;
  while (k < end) {
    const d = src.charCodeAt(k);
    if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 45 || d === 95) { k++; continue; }
    if (d === 46) { k++; continue; }
    break;
  }
  // strip trailing -, ., _ (the domain must end with an alnum)
  let e = k;
  while (e > domStart && (src.charCodeAt(e - 1) === 45 || src.charCodeAt(e - 1) === 46 || src.charCodeAt(e - 1) === 95)) e--;
  if (e <= domStart) return null;
  // the domain must contain a dot with an alnum after it
  let lastDot = -1;
  for (let p = domStart; p < e; p++) if (src.charCodeAt(p) === 46) lastDot = p;
  if (lastDot <= domStart || e <= lastDot + 1) return null;
  // The char after the match must not be a word char or '-'. A trailing
  // '_' blocks the link UNLESS it is an emphasis closer: marked lexes the
  // email inside the emphasis content (where the '_' delimiter is already
  // consumed), so `an@b.com` inside `_..._` or `__...__` DOES link, while
  // a bare `a@b.com_` (no opener) does not. The caller passes
  // allowTrailingUnderscore when an unmatched '_' opener is in scope.
  if (e < end) {
    const n = src.charCodeAt(e);
    if ((n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || n === 45) return null;
    if (n === 95 && !allowTrailingUnderscore) return null;
  }
  return { end: e };
}

function matchExtendedAutolink(src, i, end, prev, allowTrailingUnderscore) {
  const c = src.charCodeAt(i);
  // mailto: / xmpp: + email (marked's At regex)
  if (c === 109 || c === 120) { // m or x
    if (prev !== '' && ((prev >= '0' && prev <= '9') || (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z'))) return null;
    let scheme = null;
    if (src.startsWith('mailto:', i)) scheme = 'mailto:';
    else if (src.startsWith('xmpp:', i)) scheme = 'xmpp:';
    if (scheme) {
      const em = matchEmailAt(src, i + scheme.length, end, allowTrailingUnderscore);
      if (em) {
        let e = em.end;
        let text = src.slice(i, e);
        if (scheme === 'xmpp:' && e < end && src.charCodeAt(e) === 47) {
          // optional /[A-Za-z0-9@.]+ (one segment only)
          let p = e + 1;
          while (p < end) {
            const d = src.charCodeAt(p);
            if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 64 || d === 46) p++;
            else break;
          }
          if (p > e + 1) { e = p; text = src.slice(i, e); }
        }
        return { href: text, text, end: e };
      }
      return null;
    }
  }
  // www. (preceded by start, space, *, _, ~ or ()
  if (c === 119 && src.startsWith('www.', i)) {
    if (prev !== '' && !isSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') return null;
    let j = i + 4;
    let domStart = j;
    while (j < end) {
      const d = src.charCodeAt(j);
      if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 45 || d === 46) j++;
      else break;
    }
    if (j === domStart) return null;
    const domEnd = j;
    // continue with the path: any non-space, non-< chars (marked's [^\s<]*)
    while (j < end) {
      const d = src.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 60) break;
      j++;
    }
    let url = backpedalUrl(src.slice(i, j));
    // the domain part (before any path) must contain a dot
    const dom = url.slice(0, Math.min(domEnd - i, url.length));
    if (dom.indexOf('.') === -1) return null;
    return { href: 'http://' + url, text: url, end: i + url.length };
  }
  // scheme:// (preceded by start or a non-alphanumeric); case-insensitive
  if (c === 104 || c === 102 || c === 72 || c === 70) {
    if (prev !== '' && ((prev >= '0' && prev <= '9') || (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z'))) return null;
    let scheme = null;
    const low8 = src.slice(i, i + 8).toLowerCase();
    if (low8.startsWith('http://')) scheme = 'http://';
    else if (low8.startsWith('https://')) scheme = 'https://';
    else if (low8.startsWith('ftp://')) scheme = 'ftp://';
    if (scheme) {
      let j = i + scheme.length;
      while (j < end) {
        const d = src.charCodeAt(j);
        if (d === 32 || d === 9 || d === 10 || d === 60) break;
        j++;
      }
      if (j === i + scheme.length) return null;
      let url = backpedalUrl(src.slice(i, j));
      if (url.length <= scheme.length) return null;
      return { href: url, text: url, end: i + url.length };
    }
  }
  // bare email (mailto:/xmpp: handled above); not preceded by an alnum
  if (prev !== '' && ((prev >= '0' && prev <= '9') || (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z'))) return null;
  const em = matchEmailAt(src, i, end, allowTrailingUnderscore);
  if (em) {
    const email = src.slice(i, em.end);
    return { href: 'mailto:' + email, text: email, end: em.end };
  }
  return null;
}

// Remove trailing punctuation from a URL per GFM backpedal rules:
// strip trailing ? ! . , : ; * _ ' " ~ ) and balanced ) handling.
function backpedalUrl(url) {
  let u = url;
  // Marked's _backpedal regex only consumes a '(' as part of a balanced
  // group `\([^)]*\)`: an '(' with no ')' anywhere after it is not part
  // of the URL at all, so truncate before the first such '('
  // (e.g. `https://x.io)](https://y.io` backpedals to `https://x.io)]`,
  // and the `(https://y.io` becomes a separate autolink).
  let p = u.indexOf('(');
  while (p !== -1) {
    if (u.indexOf(')', p + 1) === -1) { u = u.slice(0, p); break; }
    p = u.indexOf('(', p + 1);
  }
  while (u.length > 0) {
    // a trailing &xxx; (entity-like) is never part of the URL
    if (u.endsWith(';')) {
      let amp = u.length - 2;
      while (amp >= 0 && /[a-zA-Z0-9]/.test(u[amp])) amp--;
      if (amp >= 0 && u[amp] === '&') { u = u.slice(0, amp); continue; }
    }
    const last = u[u.length - 1];
    if (last === ')' ) {
      // Keep a trailing ')' only if it closes an unmatched '(' — i.e.
      // the last '(' in the URL has no ')' between it and the end
      // (marked's _backpedal consumes `(...)` as a balanced group, so a
      // ')' that closes the last '(' is kept even when an earlier stray
      // ')' makes the totals unbalanced, as in
      // `https://example.com/server)](https://img.../page=6)`).
      const lastOpen = u.lastIndexOf('(', u.length - 2);
      const hasCloseBetween = lastOpen !== -1 && u.indexOf(')', lastOpen + 1) < u.length - 1;
      if (lastOpen === -1 || hasCloseBetween) { u = u.slice(0, -1); continue; }
      break;
    }
    if (last === '?' || last === '!' || last === '.' || last === ',' ||
        last === ':' || last === ';' || last === '*' || last === '_' ||
        last === "'" || last === '"' || last === '~') {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return u;
}

// ---------- inline HTML tag / autolink ----------
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
const RE_HTML_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/;

// ---------- inline scanner ----------
// Parses src[0..end) into nodes. `links` is the link-reference map.
// Returns {nodes, delims} — delims are resolved by the caller via
// processEmphasis (which needs the node list).
function parseInlineNodes(src, links, inLabel) {
  const end = src.length;
  const nodes = [];
  const delims = [];
  // Marked's emStrong/del masking: delimiter runs inside a masked
  // (code span / link / HTML) interval never form emphasis.
  const masked = computeMasked(src);
  let i = 0;
  let textStart = 0;
  // inside a link's label text, extended autolinks (bare URLs, www.,
  // emails) are plain text — only <...> autolinks still link. Nested
  // bracket links ARE still formed here (they block the outer link via
  // containsLink), so this is a separate flag from inLink.
  // inLink/inRawBlock live in the module-level inlineState (shared across
  // the whole document, like marked's Lexer state); they are NOT reset here.

  function flushText(to) {
    if (to > textStart) {
      nodes.push({ t: 'text', s: decodeNumericEntities(src.slice(textStart, to)) });
    }
  }

  while (i < end) {
    const c = src.charCodeAt(i);
    // --- backslash escape / hard break ---
    if (c === 92) {
      const n = i + 1 < end ? src.charCodeAt(i + 1) : 0;
      if (n === 10) {
        flushText(i);
        nodes.push({ t: 'br' });
        i += 2;
        // leading spaces/tabs on the next line are stripped after a break
        while (i < end && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      if (n && n < 128 && isEscapable(n)) {
        flushText(i);
        nodes.push({ t: 'text', s: escapeHtml(String.fromCharCode(n), false) });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- code span ---
    if (c === 96) {
      let j = i;
      while (j < end && src.charCodeAt(j) === 96) j++;
      const len = j - i;
      const ce = findCodeEnd(src, j, end, len);
      if (ce !== -1) {
        let content = src.slice(j, ce - len);
        content = content.replace(/\n/g, ' ');
        if (content.length > 0 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText(i);
        nodes.push({ t: 'code', s: content });
        i = ce;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // --- emphasis / strikethrough delimiters ---
    if (c === 42 || c === 95 || c === 126) {
      const ch = String.fromCharCode(c);
      let j = i;
      while (j < end && src.charCodeAt(j) === c) j++;
      const len = j - i;
      // a ~ run of 3+ cannot form strikethrough (del needs 1 or 2)
      if (ch === '~' && len > 2) { i = j; continue; }
      const lf = isLeftFlanking(src, j, end, i);
      const rf = isRightFlanking(src, j, end, i);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = lf && (!rf || (i > 0 && isPunct(src[i - 1])));
        canClose = rf && (!lf || (j < end && isPunct(src[j])));
      } else {
        canOpen = lf;
        canClose = rf;
      }
      if (canOpen || canClose) {
        flushText(i);
        const node = { t: 'text', s: ch.repeat(len) };
        nodes.push(node);
        // Masked by marked's emStrong/del masking (code span / link /
        // HTML interval): the run stays literal text and never pairs.
        if (!masked[i]) {
        // afterAlnum: the run is immediately followed by an alphanumeric
        // character. beforePunctSpace: the run is at the start or is
        // immediately preceded by a space or punctuation character.
        // Both are needed to replicate marked's emStrong scan quirk
        // (a closer-like run followed by an alphanumeric is skipped by
        // the rule of 3 and consumes the scan balance).
        delims.push({ ch, len, node, open: canOpen, close: canClose, used: 0, afterAlnum: j < end && isAlnum(src[j]), beforePunctSpace: i === 0 || isSpace(src[i - 1]) || isPunct(src[i - 1]) });
        }
        i = j;
        textStart = i;
        continue;
      }
      // not a delimiter: leave the run in the plain-text buffer
      i = j;
      continue;
    }
    // --- image / link ---
    if (c === 33 || c === 91) {
      const isImage = c === 33;
      let ls = i;
      if (isImage) {
        if (i + 1 >= end || src.charCodeAt(i + 1) !== 91) { i++; continue; }
        ls = i + 1;
      }
      const lab = scanLabel(src, ls, end);
      if (!lab) { i++; continue; }
      const after = lab.end;
      let href = null, title = null;
      let consumed = -1;
      let refLabel = null;
      if (after < end && src.charCodeAt(after) === 40) {
        const dest = parseLinkDestination(src, after, end);
        if (dest) { href = dest.href; title = dest.title; consumed = dest.end; }
        else {
          // the (...) is not a valid inline link: fall back to the
          // shortcut reference link [text] (the (...) stays literal text)
          refLabel = lab.text;
          consumed = after;
        }
      } else if (after < end && src.charCodeAt(after) === 91) {
        // [text][ref]
        const ref = scanRefLabel(src, after, end);
        if (ref) {
          refLabel = ref.text === '' ? lab.text : ref.text;
          consumed = ref.end;
        }
      } else {
        // shortcut [text]
        refLabel = lab.text;
        consumed = after;
      }
      if (consumed === -1 && href === null) { i++; continue; }
      if (href === null) {
        const ref = links.get(normalizeLabel(refLabel));
        if (!ref) {
          // not a link: for [text] with no ref, render the '[' literally
          // (but for [text][ref] with missing ref, the whole thing is literal)
          i++;
          continue;
        }
        href = ref.href; title = ref.title;
      }
      // marked rejects a link whose text contains a raw HTML tag/autolink
      if (linkTextHasTag(src, ls + 1, lab.end - 1)) { i++; continue; }
      // a link cannot contain another link — handled after parsing the
      // label (containsLink on the inner nodes), NOT by the inLink HTML
      // state: marked only uses inLink to gate the `url` (extended
      // autolink) tokenizer, and still forms bracket links inside an
      // unclosed <a> (doc-06).
      const inner = parseInlineNodes(lab.text, links, !isImage);
      processEmphasis(inner.nodes, inner.delims);
      // A link whose text already contains a link is not formed (the outer
      // brackets stay literal). Images are exempt: their alt is plain text.
      if (!isImage && containsLink(inner.nodes)) { i++; continue; }
      flushText(i);
      if (isImage) {
        // alt text: plain text rendering of the inner nodes
        const alt = renderPlainText(inner.nodes);
        nodes.push({ t: 'image', href, title, alt });
      } else {
        nodes.push({ t: 'link', href, title, c: inner.nodes });
      }
      i = consumed;
      textStart = i;
      continue;
    }
    // --- autolink / inline HTML ---
    if (c === 60) {
      const rest = src.slice(i, end);
      const am = RE_AUTOLINK.exec(rest);
      if (am) {
        flushText(i);
        const full = am[1];
        const isEmail = full.indexOf('@') !== -1 && full.indexOf(':') === -1;
        const href = isEmail ? 'mailto:' + full : full;
        nodes.push({ t: 'link', href, title: null, c: [{ t: 'text', s: full }], auto: true });
        i += am[0].length;
        textStart = i;
        continue;
      }
      const hm = RE_HTML_TAG.exec(rest);
      if (hm) {
        flushText(i);
        const tag = hm[0];
        nodes.push({ t: 'html', s: tag });
        // track <a> and <pre>/<code>/<script> state like marked
        const low = tag.toLowerCase();
        if (/^<a[\s>]/.test(low)) inlineState.inLink = true;
        else if (/^<\/a[\s>]/.test(low)) inlineState.inLink = false;
        else if (/^<(pre|code|kbd|script)[\s>]/.test(low)) inlineState.inRawBlock = true;
        else if (/^<\/(pre|code|kbd|script)[\s>]/.test(low)) inlineState.inRawBlock = false;
        i += tag.length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- hard break: two spaces + newline ---
    if (c === 10) {
      // check for two trailing spaces before the newline
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && src.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2) {
        flushText(i - spaces);
        nodes.push({ t: 'br' });
        i++;
        // leading spaces/tabs on the next line are stripped after a break
        while (i < end && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // --- extended autolinks (GFM): www., scheme://, email ---
    // not inside a link, and not inside a link's label text
    if (!inlineState.inLink && !inLabel) {
      // www. needs start/space/*/_/~/( before it; scheme:// and email just
      // need the previous char to not be alphanumeric
      const prev = i === 0 ? '' : src[i - 1];
      if (c === 119 || c === 104 || c === 102 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        // A trailing '_' after a bare email only blocks the link when it
        // is not an emphasis closer; allow it when an unmatched '_' opener
        // is in scope (the email sits inside _..._ / __...__).
        let allowUnd = false;
        for (let di = 0; di < delims.length; di++) {
          if (delims[di].ch === '_' && delims[di].open) { allowUnd = true; break; }
        }
        const al = matchExtendedAutolink(src, i, end, prev, allowUnd);
        if (al) {
          flushText(i);
          nodes.push({ t: 'link', href: al.href, title: null, c: [{ t: 'text', s: al.text }], auto: true });
          i = al.end;
          textStart = i;
          continue;
        }
      }
    }
    i++;
  }
  flushText(end);
  return { nodes, delims };
}

// Render nodes to plain text (for image alt attributes).
// Does a node list (recursively) contain a link node? Autolinks do NOT
// count: marked allows an autolink inside a link's text (only a bracket
// link inside another link is forbidden).
function containsLink(nodes) {
  for (const n of nodes) {
    if (n.t === 'link' && !n.auto) return true;
    if (n.c && containsLink(n.c)) return true;
  }
  return false;
}

function renderPlainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.s;
    else if (n.t === 'br') out += '';
    else if (n.t === 'image') out += n.alt;
    else if (n.c) out += renderPlainText(n.c);
  }
  return out;
}

// Resolve emphasis/delimiter pairs in-place on a node list + delimiter list.
// Follows the CommonMark emphasis algorithm: closers are processed in
// document order; each looks back for its nearest matching opener.
// Replicate marked's emStrong scan quirk: when marked scans for a closer
// for an opener, a delimiter run that can both open and close and is
// immediately followed by an alphanumeric is skipped by the rule of 3 when
// (opener.len + run.len) % 3 === 0, and it also consumes the scan balance,
// so the first closer after it cannot match the opener. This fires when the
// delimiter run immediately before `closer` in the source is a formed
// closer with those properties (e.g. `*a **b**c*`: the `**` after `b` is
// such a run, so the final `*` cannot match the opening `*`). The run's
// pair opener must itself be opener-like in the scan (preceded by a space
// or punctuation, so it added to the balance); when it is preceded by an
// alphanumeric (`*a**b**c*`) it is skipped instead and does not block.
function blockedByMarkedScan(opener, closer, delims, formedPairs) {
  const idx = delims.indexOf(closer);
  if (idx <= 0) return false;
  const d = delims[idx - 1];
  if (d.ch !== closer.ch) return false;
  const pairOpener = formedPairs.get(d);
  if (!pairOpener) return false;
  if (!d.open || !d.close) return false;
  if (!d.afterAlnum) return false;
  if (!pairOpener.beforePunctSpace) return false;
  if ((opener.len + d.len) % 3 !== 0) return false;
  // The block only bites when the closer has at most 2 chars left: a
  // longer closer run (*** or more) overcomes the consumed balance and
  // still matches the opener (e.g. `**a *b*c***` forms <strong>, while
  // `**a *b*c**` leaves the outer ** literal).
  if (closer.len - closer.used > 2) return false;
  return true;
}

// When a closer run has leftover chars after forming emphasis, marked
// places the leftover INSIDE the emphasis element only when the inner
// content holds an emphasis node glued to the closer by non-space text
// (e.g. `**a *b*c***` -> <strong>a <em>b</em>c*</strong>); otherwise the
// leftover goes outside (`**a b***` -> <strong>a b</strong>*). A space
// right after the inner emphasis or right before the closer breaks the
// glue (`**a *b* c***`, `**a *b*c ***` both leave it outside).
function closerLeftoverInside(inner, closerRemaining) {
  // A leftover only lands inside when the closer run is long enough
  // (>= 3 chars: `**a *b*c***` puts it inside, `*a *b*c**` leaves it
  // outside) and the inner content holds a SEPARATE emphasis node
  // (not a sole wrapper built by this same opener/closer pair, as in
  // cm-417 `foo******bar*********baz` where the *** stays outside).
  if (closerRemaining < 3) return false;
  if (inner.length < 2) return false;
  let lastEmIdx = -1;
  for (let i = inner.length - 1; i >= 0; i--) {
    const t = inner[i].t;
    if (t === 'em' || t === 'strong' || t === 'del') { lastEmIdx = i; break; }
  }
  if (lastEmIdx === -1) return false;
  const after = inner[lastEmIdx + 1];
  if (after && after.t === 'text' && /^\s/.test(after.s)) return false;
  const last = inner[inner.length - 1];
  if (last && last.t === 'text' && /\s$/.test(last.s)) return false;
  return true;
}


// Forward-balance match point (marked's emStrong scan, simplified):
// starting from opener O, walk the delimiter runs after O in the text.
// An open-only run adds its length to the balance; a run that can close
// subtracts its length — except an open+close run skipped by the rule
// of 3 (when (y + run.len) % 3 === 0 with y = O.len), which instead adds
// to f and does not subtract. The first run where the balance reaches
// <= 0 is O's match point. If O's match-point pairing would consume ALL
// of O's remaining length, O is reserved for that closer and must not
// pair with any other closer (e.g. doc-11: the `**` opener's scan claims
// the final `**`, so the lone `*` after "parse" stays literal). If the
// match-point pairing leaves O with length (partial use, e.g. cm-408)
// or there is no match point (e.g. cm-442), O stays available.
function openerReservedFor(opener, closer, delims) {
  const oRem = opener.len - opener.used;
  if (oRem <= 0) return null;
  const oi = delims.indexOf(opener);
  if (oi < 0) return null;
  const y = opener.len;
  let m = oRem;
  let f = 0;
  for (let j = oi + 1; j < delims.length; j++) {
    const D = delims[j];
    if (D.ch !== opener.ch) continue;
    if (D.open && !D.close) { m += D.len; continue; }
    if (!D.close) continue;
    // open+close run: rule of 3 may skip it (it adds to f, not m)
    if (D.open && D.close && y % 3 !== 0 && (y + D.len) % 3 === 0) { f += D.len; continue; }
    m -= D.len;
    if (m <= 0) {
      // D is the match point. The closer contributes min(len, len+m+f)
      // chars (the balance going negative caps it, as in marked).
      const capped = Math.min(D.len - D.used, D.len + m + f);
      const usePrime = Math.min(oRem, capped);
      if (usePrime >= oRem && D !== closer) return D;
      return null;
    }
  }
  return null;
}

// Forward-balance match point of an opener (marked's emStrong scan):
// returns {matchPoint, use} where matchPoint is the delimiter run the
// opener's scan claims and use is the chars of the opener that pairing
// would consume, or null if the scan finds no closer.
function matchPointOf(opener, delims) {
  const oRem = opener.len - opener.used;
  if (oRem <= 0) return null;
  const oi = delims.indexOf(opener);
  if (oi < 0) return null;
  const y = opener.len;
  let m = oRem;
  let f = 0;
  for (let j = oi + 1; j < delims.length; j++) {
    const D = delims[j];
    if (D.ch !== opener.ch) continue;
    if (D.open && !D.close) { m += D.len; continue; }
    if (!D.close) continue;
    if (D.open && D.close && y % 3 !== 0 && (y + D.len) % 3 === 0) { f += D.len; continue; }
    m -= D.len;
    if (m <= 0) {
      const capped = Math.min(D.len - D.used, D.len + m + f);
      const use = Math.min(oRem, capped);
      return { matchPoint: D, use };
    }
  }
  return null;
}

// Find the nearest available opener for `closer` scanning backwards
// from stack index `ci` (exclusive). Returns the opener delimiter or null.
function findOpener(closer, ci, stack, nodes, delims, formedPairs) {
  let oi = ci - 1;
  while (oi >= 0) {
    const cand = stack[oi];
    // a delimiter whose node was absorbed into an already-formed
    // emphasis element is no longer available as an opener
    if (cand.ch === closer.ch && cand.open && cand.len - cand.used > 0 && nodes.indexOf(cand.node) !== -1) {
      const ol = cand.len - cand.used;
      const cl = closer.len - closer.used;
      // rule of 3: applies when EITHER delimiter can both open and close
      if ((cand.open && cand.close) || (closer.open && closer.close)) {
        if ((ol + cl) % 3 === 0 && ol % 3 !== 0 && cl % 3 !== 0) { oi--; continue; }
      }
      // marked's emStrong scan quirk (doc-07, doc-01): when scanning
      // for a closer for an opener, a delimiter run that can both open
      // and close and is followed by an alphanumeric is skipped by the
      // rule of 3 when (opener.len + run.len) % 3 === 0, and it also
      // consumes the scan balance, so the first closer after it cannot
      // match the opener (e.g. `*a **b**c*` leaves the outer `*`
      // literal while `**b**` still forms strong).
      if (blockedByMarkedScan(cand, closer, delims, formedPairs)) { oi--; continue; }
      // doc-11: if this opener's forward-balance scan claims a later
      // closer that consumes all of it, it is reserved for that closer.
      if (openerReservedFor(cand, closer, delims)) { oi--; continue; }
      // doc-11 (priority): a len-1 opener must not steal a len-2 closer
      // that an earlier len-2+ opener claims as a full-consumption
      // strong (the final `**` belongs to the opening `**`, not to the
      // `*` before "input") — but only when the closer is too short to
      // serve both (e.g. `**export *tokens large***` has a len-3 closer
      // that fits the em (1) AND the strong (2), so the `*` keeps it).
      if (cand.len - cand.used === 1 && closer.len - closer.used >= 2) {
        const ci2 = delims.indexOf(cand);
        let steal = false;
        for (let k = 0; k < ci2; k++) {
          const O = delims[k];
          if (O.ch !== closer.ch || !O.open || O.len - O.used < 2) continue;
          if (stack.indexOf(O) === -1 || nodes.indexOf(O.node) === -1) continue;
          if (closer.len - closer.used >= 1 + (O.len - O.used)) continue;
          const mp = matchPointOf(O, delims);
          if (mp && mp.matchPoint === closer && mp.use >= O.len - O.used) { steal = true; break; }
        }
        if (steal) { oi--; continue; }
      }
      return cand;
    }
    oi--;
  }
  return null;
}

function processEmphasis(nodes, delims) {
  if (delims.length === 0) return;
  const stack = delims.slice();
  // Delimiter runs that have formed a pair as a closer, mapped to the
  // opener they paired with. Used to replicate marked's emStrong scan
  // quirk (see blockedByMarkedScan).
  const formedPairs = new Map();
  let ci = 0;
  while (ci < stack.length) {
    const closer = stack[ci];
    if (!closer.close || closer.len - closer.used <= 0) { ci++; continue; }
    const opener = findOpener(closer, ci, stack, nodes, delims, formedPairs);
    if (!opener) { ci++; continue; }
    const ol = opener.len - opener.used;
    const cl = closer.len - closer.used;
    const use = (ol >= 2 && cl >= 2) ? 2 : 1;
    const type = opener.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const oiNode = nodes.indexOf(opener.node);
    const ciNode = nodes.indexOf(closer.node);
    if (oiNode === -1 || ciNode === -1 || ciNode <= oiNode) { ci++; continue; }
    const inner = nodes.slice(oiNode + 1, ciNode);
    const wrapper = { t: type, c: inner };
    opener.node.s = opener.node.s.slice(0, opener.node.s.length - use);
    // The closer consumes its LAST `use` chars; the leftover (first
    // chars of the run) is text adjacent to the content.
    closer.node.s = closer.node.s.slice(0, closer.node.s.length - use);
    opener.used += use;
    closer.used += use;
    formedPairs.set(closer, opener);
    const replacement = [];
    if (opener.node.s.length > 0) replacement.push(opener.node);
    replacement.push(wrapper);
    if (closer.node.s.length > 0) {
      // The leftover goes inside only when the closer cannot match
      // another opener afterwards (otherwise it must stay findable in
      // the top-level node list for the retry) and the glue conditions
      // hold; otherwise it stays outside the wrapper.
      const nextOpener = findOpener(closer, ci, stack, nodes, delims, formedPairs);
      if (nextOpener === null && closerLeftoverInside(inner, cl)) wrapper.c.push(closer.node);
      else replacement.push(closer.node);
    }
    nodes.splice(oiNode, ciNode - oiNode + 1, ...replacement);
    if (opener.used >= opener.len) {
      const idx = stack.indexOf(opener);
      if (idx !== -1) { stack.splice(idx, 1); if (idx < ci) ci--; }
    }
    if (closer.used >= closer.len) {
      const idx = stack.indexOf(closer);
      if (idx !== -1) stack.splice(idx, 1);
      // move to the next closer (ci now points at the following delimiter)
    } else {
      // closer still has length: retry it against another opener
      ci = stack.indexOf(closer);
      if (ci === -1) ci = 0;
    }
  }
}

// Render inline nodes to HTML.
function renderInline(nodes, out) {
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out.push(escapeHtml(n.s, false)); break;
      case 'code': out.push('<code>' + escapeHtml(n.s, true) + '</code>'); break;
      case 'br': out.push('<br>'); break;
      case 'html': out.push(n.s); break;
      case 'em': out.push('<em>'); renderInline(n.c, out); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderInline(n.c, out); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderInline(n.c, out); out.push('</del>'); break;
      case 'link': {
        const href = cleanUrl(n.href);
        if (href === null) {
          renderInline(n.c, out);
          break;
        }
        let s = '<a href="' + escapeHtml(href, false) + '"';
        if (n.title != null) s += ' title="' + escapeHtml(n.title, false) + '"';
        s += '>';
        out.push(s);
        renderInline(n.c, out);
        out.push('</a>');
        break;
      }
      case 'image': {
        const href = cleanUrl(n.href);
        if (href === null) { out.push(escapeHtml(n.alt, false)); break; }
        let s = '<img src="' + escapeHtml(href, false) + '" alt="' + escapeHtml(n.alt, false) + '"';
        if (n.title != null) s += ' title="' + escapeHtml(n.title, false) + '"';
        out.push(s + '>');
        break;
      }
    }
  }
}

// Parse inline content and render to HTML (single entry point).
function inlineToHtml(src, links) {
  const { nodes, delims } = parseInlineNodes(src, links);
  processEmphasis(nodes, delims);
  const out = [];
  renderInline(nodes, out);
  return out.join('');
}
// ---------- block parsing ----------
// A block parser over a string chunk. Containers (blockquote, list) recurse
// on their inner content. Renders directly to the output array.

// Compute the indentation (in columns, tab = next multiple of 4) of the
// line starting at `i`, and the index of the first non-space/tab char.
// Returns [col, firstNonSpace].
function lineIndent(src, i, end) {
  let col = 0;
  let k = i;
  while (k < end) {
    const c = src.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  return [col, k];
}

// Advance `i` past `n` columns of indentation (spaces/tabs).
// Strip up to n columns of indent from the line [i..end) and return the
// remaining text. A tab that straddles the n-column boundary contributes
// only its part beyond the boundary as spaces; a tab that starts at or
// beyond the boundary is kept as a literal tab (marked preserves it in
// code content: `    \tX` stripped by 4 gives `\tX`, not `    X`).
// When expandTabs is set, all leading tabs are expanded to spaces using
// absolute columns first (the old behaviour) — needed for intermediate
// strips (list-item / blockquote content gathering) where the result is
// parsed again and column positions must survive a later strip
// (cm-005: `\t\tbar` inside a list item must become `  bar`, which
// requires the first strip to expand the tabs to spaces).
// startCol is the absolute column of src[i] (0 for a line start; the
// content column for text after a list marker or blockquote marker).
function stripIndentStr(src, i, end, n, startCol, expandTabs) {
  if (expandTabs) {
    let col = startCol || 0;
    let out = '';
    let p = i;
    while (p < end) {
      const c = src.charCodeAt(p);
      if (c === 32) { col++; out += ' '; p++; }
      else if (c === 9) { const nc = col + 4 - (col % 4); out += ' '.repeat(nc - col); col = nc; p++; }
      else break;
    }
    const total = col - (startCol || 0);
    if (total <= n) return src.slice(p, end);
    const keep = total - n;
    return out.slice(out.length - keep) + src.slice(p, end);
  }
  let col = startCol || 0;
  const target = col + n;
  let p = i;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === 32) {
      if (col >= target) break;
      col++; p++;
    } else if (c === 9) {
      const nc = col + 4 - (col % 4);
      if (col >= target) break; // tab entirely beyond the boundary: keep it raw
      if (nc > target) {
        // tab straddles the boundary: the part beyond becomes spaces
        return ' '.repeat(nc - target) + src.slice(p + 1, end);
      }
      col = nc; p++;
    } else break;
  }
  return src.slice(p, end);
}

function skipIndent(src, i, end, n) {
  let col = 0;
  while (i < end && col < n) {
    const c = src.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { const nc = col + 4 - (col % 4); if (nc > n) break; col = nc; i++; }
    else break;
  }
  return i;
}

// Is the line [i..end) blank (only spaces/tabs)?
function isBlankLine(src, i, end) {
  for (let k = i; k < end; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Count the run of char `ch` starting at i (within [i,end)).
function runLen(src, i, end, ch) {
  let j = i;
  while (j < end && src.charCodeAt(j) === ch) j++;
  return j - i;
}

// --- HTML block ---
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Strip trailing blank lines from an HTML block's text, following marked:
// split by \n, drop trailing blank lines, but keep a lone trailing \n.
function geText(text) {
  const parts = text.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
  if (parts.length - t <= 2) return text;
  return parts.slice(0, t + 1).join('\n');
}

// Extend `pos` past any immediately following blank lines (each is a line
// of only spaces/tabs, or just the newline).
function pastBlankLines(src, pos, end) {
  let i = pos;
  while (i < end) {
    let j = i;
    while (j < end && src.charCodeAt(j) !== 10) j++;
    if (!isBlankLine(src, i, j)) break;
    i = j + 1;
  }
  return i;
}

// Try to match an HTML block starting at line [ls..le). Returns the end
// index (just past the block, including any trailing blank lines) or -1.
// `inParagraph` is true when checking whether a line interrupts a paragraph:
// only types 1-6 may interrupt; type 7 may not.
function matchHtmlBlock(src, ls, le, end, inParagraph) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3 || first >= le) return -1;
  if (src.charCodeAt(first) !== 60) return -1; // <
  const rest = src.slice(first, le);
  const low = rest.toLowerCase();
  let type = 0;
  let endRe = null;
  // type 1: OPENING <script|pre|style|textarea only (closing tags are not
  // HTML block starts and do not interrupt a paragraph). The char after the
  // tag name may be whitespace (including a newline: the tag may span
  // lines), '>', or the end of the line (next char is '\n' = whitespace).
  if (/^<(script|pre|style|textarea)(\s|>|$)/.test(low)) {
    type = 1;
    const tag = low.match(/^<(script|pre|style|textarea)/)[1];
    endRe = new RegExp('</' + tag + '>', 'i');
  } else if (low.startsWith('<!--')) {
    type = 2; endRe = /-->/;
  } else if (low.startsWith('<?')) {
    type = 3; endRe = /\?>/;
  } else if (/^<![a-z]/i.test(rest)) {
    type = 4; endRe = />/;
  } else if (low.startsWith('<![cdata[')) {
    type = 5; endRe = /\]\]>/;
  } else {
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s|\/?>)/.exec(rest);
    if (m) {
      const tag = m[1].toLowerCase();
      if (BLOCK_TAGS.has(tag)) {
        type = 6;
      } else if (!inParagraph) {
        // type 7: a complete open or close tag ALONE on its line.
        const tagRe = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>[ \t]*$/;
        const closeRe = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>[ \t]*$/;
        if (tagRe.test(rest) || closeRe.test(rest)) type = 7;
        else return -1;
      } else return -1;
    } else return -1;
  }
  if (type === 0) return -1;
  // Find the end.
  if (type === 6 || type === 7) {
    // ends at the first blank line or end of input; the match consumes the
    // blank line(s) (geText strips them from the output).
    let i = le + 1;
    while (i < end) {
      let j = i;
      while (j < end && src.charCodeAt(j) !== 10) j++;
      if (isBlankLine(src, i, j)) {
        return pastBlankLines(src, i, end);
      }
      i = j + 1;
    }
    return end;
  }
  // types 1-5: scan for the end marker, then consume the rest of that line
  // and any following EMPTY lines. Only literal newlines are consumed
  // (marked's (\n+|$) / \n* after the end marker); a whitespace-only line
  // (spaces/tabs) is NOT part of the block — it becomes a separate space
  // token. Consuming it here makes geText strip the block's trailing
  // newline, which marked keeps (e.g. a tab-only line after -->).
  const m = endRe.exec(src.slice(first, end));
  if (!m) return end;
  const absEnd = first + m.index + m[0].length;
  let j = absEnd;
  while (j < end && src.charCodeAt(j) !== 10) j++;
  const lineEnd = j + 1 <= end ? j + 1 : end;
  let k = lineEnd;
  while (k < end && src.charCodeAt(k) === 10) k++;
  return k;
}

// --- fenced code ---
// Returns {end, lang, text} or null. ls/le is the opening fence line.
function matchFence(src, ls, le, end) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3 || first >= le) return null;
  const fc = src.charCodeAt(first);
  if (fc !== 96 && fc !== 126) return null;
  const flen = runLen(src, first, le, fc);
  if (flen < 3) return null;
  // info string
  let info = src.slice(first + flen, le).trim();
  if (fc === 96 && info.indexOf('`') !== -1) return null;
  // lang = first word of info, backslash-punctuation unescaped
  let lang = '';
  if (info.length > 0) {
    const sp = info.search(/[ \t]/);
    lang = (sp === -1 ? info : info.slice(0, sp)).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  }
  // find closing fence
  let i = le + 1;
  const contentStart = i;
  let contentEnd = -1;
  while (i < end) {
    let j = i;
    while (j < end && src.charCodeAt(j) !== 10) j++;
    const [ccol, cfirst] = lineIndent(src, i, j);
    if (ccol <= 3 && cfirst < j && src.charCodeAt(cfirst) === fc) {
      const clen = runLen(src, cfirst, j, fc);
      if (clen >= flen) {
        // rest of line must be spaces only
        let ok = true;
        for (let p = cfirst + clen; p < j; p++) {
          if (src.charCodeAt(p) !== 32 && src.charCodeAt(p) !== 9) { ok = false; break; }
        }
        if (ok) { contentEnd = i; break; }
      }
    }
    i = j + 1;
  }
  if (contentEnd === -1) {
    // unterminated: content runs to end; a fenced code block's text always
    // ends with a newline (marked appends one when the source lacks it)
    contentEnd = end;
    i = end;
  } else {
    // i points at the closing fence line start; end = after that line
    let j = i;
    while (j < end && src.charCodeAt(j) !== 10) j++;
    i = j + 1;
  }
  let text = src.slice(contentStart, contentEnd);
  if (contentEnd !== end) {
    // terminated fence: the raw slice holds one newline per content line
    // (including the last); marked's text is the lines joined by '\n',
    // so drop one trailing newline before the append-if-missing step.
    if (text.length > 0 && text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) text += '\n';
  // Strip the fence's indent from each content line, matching marked's
  // Dt(): remove min(len(line leading whitespace), len(fence leading
  // whitespace)) CHARACTERS — a leading tab counts as one character, so
  // it is removed whole when the fence is indented 1-3 (not replaced by
  // spaces for the part beyond the indent, as CommonMark would do).
  // Marked only strips for BACKTICK fences: tilde fences keep their
  // content indentation verbatim (e.g. `   ~~~ts` + `   code` keeps all
  // 3 spaces, while `   ```ts` + `   code` strips to `code`).
  if (fc === 96 && col > 0 && text.length > 0) {
    const stripN = first - ls; // fence leading-whitespace char count
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let w = 0;
      while (w < line.length) {
        const c = line.charCodeAt(w);
        if (c === 32 || c === 9 || c === 11 || c === 12 || c === 13) w++;
        else break;
      }
      if (w > 0) {
        const strip = w < stripN ? w : stripN;
        if (strip > 0) lines[li] = line.slice(strip);
      }
    }
    text = lines.join('\n');
  }
  return { end: i, lang, text };
}

// --- ATX heading ---
function matchAtx(src, ls, le) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3 || first >= le) return null;
  if (src.charCodeAt(first) !== 35) return null; // #
  const hlen = runLen(src, first, le, 35);
  if (hlen > 6) return null;
  // must be followed by space/tab or end of line
  if (first + hlen < le) {
    const c = src.charCodeAt(first + hlen);
    if (c !== 32 && c !== 9) return null;
  }
  let content = src.slice(first + hlen, le);
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // closing sequence of #s
  if (content.length > 0 && content.charCodeAt(content.length - 1) === 35) {
    const m = /#+$/.exec(content);
    if (m) {
      const before = content.slice(0, content.length - m[0].length);
      if (before.length === 0 || before.charCodeAt(before.length - 1) === 32 || before.charCodeAt(before.length - 1) === 9) {
        content = before.replace(/[ \t]+$/, '');
      }
    }
  }
  return { level: hlen, content };
}

// --- thematic break ---
function matchHr(src, ls, le) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3 || first >= le) return false;
  const c = src.charCodeAt(first);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  for (let i = first; i < le; i++) {
    const d = src.charCodeAt(i);
    if (d === c) count++;
    else if (d !== 32 && d !== 9) return false;
  }
  return count >= 3;
}

// --- setext underline ---
function matchSetext(src, ls, le) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3 || first >= le) return 0;
  const c = src.charCodeAt(first);
  if (c !== 61 && c !== 45) return 0; // = or -
  // a contiguous run of the char, then only trailing spaces/tabs (no
  // internal spaces: "= =" and "--- -" are not setext underlines)
  let i = first;
  while (i < le && src.charCodeAt(i) === c) i++;
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  if (i !== le) return 0;
  return c === 61 ? 1 : 2;
}

// --- table ---
// Check if line [ls..le) is a table delimiter row; returns alignments
// array (null|'left'|'center'|'right') or null.
function matchTableDelim(src, ls, le) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3) return null;
  let line = src.slice(first, le);
  // must contain at least one |
  if (line.indexOf('|') === -1) return null;
  // split into cells
  const cells = splitTableRow(line);
  if (cells === null) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (/^:-+:$/ .test(t)) aligns.push('center');
    else if (/^-+:$/.test(t)) aligns.push('right');
    else if (/^:-+$/.test(t)) aligns.push('left');
    else if (/^-+$/.test(t)) aligns.push(null);
    else return null;
  }
  return aligns;
}

// Split a table row line into cells (handling escaped pipes and leading/
// trailing pipes). Returns null if the line has no cells.
function splitTableRow(line) {
  // Replace escaped pipes with a placeholder, split on |, restore.
  const parts = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < line.length && line.charCodeAt(i + 1) === 124) {
      cur += '|';
      i++;
      continue;
    }
    if (c === 124) { parts.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  parts.push(cur);
  // drop leading empty cell (if line started with |) and trailing empty
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  // A line of only pipes/whitespace is an empty row (all cells empty),
  // not the end of the table (marked: '|' and ' | ' are empty rows).
  return parts;
}

// --- list ---
// Match a list item start at line [ls..le). Returns {bullet, ordered, start,
// markerLen, contentStart, indent} or null.
// bullet: '*', '+', '-' ; ordered: digits + '.' or ')'.
function matchListItem(src, ls, le) {
  const [col, first] = lineIndent(src, ls, le);
  if (col > 3 || first >= le) return null;
  const c = src.charCodeAt(first);
  if (c === 42 || c === 43 || c === 45) { // * + -
    // must be followed by space/tab or end
    if (first + 1 < le) {
      const n = src.charCodeAt(first + 1);
      if (n !== 32 && n !== 9) return null;
    }
    // a line of only '-' could be HR/setext, but as a list item it's fine
    // (the caller decides precedence; HR is checked before list at block level)
    return { bullet: String.fromCharCode(c), ordered: false, start: null, markerLen: 1, contentCol: col + 1, first };
  }
  if (c >= 48 && c <= 57) {
    let j = first;
    while (j < le && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
    if (j - first > 9) return null;
    if (j >= le) return null;
    const d = src.charCodeAt(j);
    if (d !== 46 && d !== 41) return null; // . or )
    if (j + 1 < le) {
      const n = src.charCodeAt(j + 1);
      if (n !== 32 && n !== 9) return null;
    }
    return { bullet: null, ordered: true, start: parseInt(src.slice(first, j), 10), delim: String.fromCharCode(d), markerLen: j - first + 1, contentCol: col + (j - first + 1), first };
  }
  return null;
}

// Compute the content indent of a list item: after the marker, skip spaces.
// If the marker is followed by 1-4 spaces (or a tab), content starts after
// them; if 5+ spaces, content starts after 1 space. If the marker is at
// end of line, content starts on the next line (indented by marker width + 1,
// or the item is empty).
function listItemContentStart(src, ls, le, item) {
  const first = item.first;
  let i = first + item.markerLen;
  let spaces = 0;
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) {
    if (src.charCodeAt(i) === 32) spaces++;
    else spaces += 4 - ((item.contentCol + spaces) % 4);
    i++;
    if (spaces >= 5) break;
  }
  if (i >= le) {
    // empty item: content is on following lines, indent = marker width + 1
    return { contentIndent: item.contentCol + 1, empty: true, nextLine: true };
  }
  if (spaces >= 5) {
    // only one space is consumed
    return { contentIndent: item.contentCol + 1, empty: false, nextLine: false };
  }
  return { contentIndent: item.contentCol + spaces, empty: false, nextLine: false };
}

// Is a line a valid lazy continuation inside a blockquote? It must not
// start a block that can never be lazy text: ATX heading, fence, thematic
// break, HTML block, or blockquote. List items, indented code and setext
// underlines ARE lazy text (they become paragraph content).
function isLazyLine(line) {
  const n = line.length;
  let i = 0;
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= n) return false; // blank
  if (matchAtx(line, 0, n)) return false;
  if (matchHr(line, 0, n)) return false;
  if (matchHtmlBlock(line, 0, n, n, true) !== -1) return false;
  const fc = line.charCodeAt(i);
  if (fc === 62) return false;
  if (fc === 96 || fc === 126) {
    let m = i;
    while (m < n && line.charCodeAt(m) === fc) m++;
    if (m - i >= 3) {
      // a backtick fence's info string must not contain a backtick;
      // ```inner backticks``` is paragraph text (a code span), not a
      // fence, so a lazy line may still continue the paragraph
      if (fc === 126) return false;
      let hasBt = false;
      for (let p = m; p < n; p++) if (line.charCodeAt(p) === 96) { hasBt = true; break; }
      if (!hasBt) return false;
    }
  }
  // a list-item line starts a new list, it is never a lazy continuation
  if (matchListItem(line, 0, n)) return false;
  return true;
}

// Is a single content line (no trailing \n) paragraph text? Used to decide
// whether a blockquote's inner paragraph is open (a lazy line may continue
// it) — an indented-code, heading, fence, hr, html, list or quote line is not.
function contentIsParaLine(line) {
  const n = line.length;
  let i = 0;
  let col = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (col >= 4) return false;
  if (i >= n) return false; // blank
  if (matchAtx(line, 0, n)) return false;
  if (matchHr(line, 0, n)) return false;
  if (matchHtmlBlock(line, 0, n, n, true) !== -1) return false;
  const fc = line.charCodeAt(i);
  if (fc === 62) {
    // nested blockquote: a lazy line may continue its innermost paragraph
    let cs = i + 1;
    if (cs < n && (line.charCodeAt(cs) === 32 || line.charCodeAt(cs) === 9)) cs++;
    if (cs >= n) return false; // blank quote line: paragraph closed
    return contentIsParaLine(line.slice(cs));
  }
  if (fc === 96 || fc === 126) {
    let m = i;
    while (m < n && line.charCodeAt(m) === fc) m++;
    if (m - i >= 3) {
      // a backtick fence's info string must not contain a backtick;
      // ```inner backticks``` is paragraph text (a code span), not a
      // fence, so the paragraph stays open for a lazy line
      if (fc === 126) return false;
      let hasBt = false;
      for (let p = m; p < n; p++) if (line.charCodeAt(p) === 96) { hasBt = true; break; }
      if (!hasBt) return false;
    }
  }
  const li = matchListItem(line, 0, n);
  if (li) {
    // a list item: a lazy line may continue a paragraph inside the item
    // (e.g. "> 1. > Blockquote" — the lazy line continues the nested quote)
    const ci = listItemContentStart(line, 0, n, li);
    if (ci.empty) return false;
    // content starts after the marker + the spaces up to contentIndent
    let cs = li.first + li.markerLen;
    let ccol = li.contentCol;
    while (cs < n && ccol < ci.contentIndent) {
      const ch = line.charCodeAt(cs);
      if (ch === 32) { ccol++; cs++; }
      else if (ch === 9) { const nc = ccol + 4 - (ccol % 4); if (nc > ci.contentIndent) break; ccol = nc; cs++; }
      else break;
    }
    return contentIsParaLine(line.slice(cs));
  }
  return true;
}

// Neutralize a lazy line's content so the inner parse cannot mistake it for
// a block start: backslash-escape a leading list marker or setext run.
function neutralizeLazy(content) {
  // a setext run gets 4 spaces prepended (marked's blockquoteSetextReplace:
  // '\n    $1'), making it paragraph text instead of an underline
  if (/^[=]+[ \t]*$/.test(content) || /^[-]+[ \t]*$/.test(content)) {
    return '    ' + content;
  }
  // ordered list marker: escape the '.' or ')'
  const om = /^(\d{1,9})([.)])([ \t]|$)/.exec(content);
  if (om) return content.slice(0, om[1].length) + '\\' + content.slice(om[1].length);
  // unordered list marker
  if (/^([*+-])([ \t]|$)/.test(content)) {
    return '\\' + content;
  }
  return content;
}

// Main block parser. Parses src (a chunk) and appends HTML to out.
function parseBlocks(src, links, out, tight, inList) {
  // tight: when true (a tight list item's content), top-level paragraphs
  // render without <p>...</p> tags (and without the trailing newline)
  // inList: when true, this content is inside a list item. An ordered
  // list may then interrupt a paragraph regardless of its start number
  // (marked does so; at the top level or in a bare blockquote only a
  // list starting with 1 may interrupt).
  const end = src.length;
  let i = 0;
  let inParagraph = false;
  // We process block by block. For paragraphs we gather lines first.
  while (i < end) {
    // line boundaries
    let le = i;
    while (le < end && src.charCodeAt(le) !== 10) le++;
    const lineEnd = le; // exclusive
    const nextLine = le < end ? le + 1 : end;
    if (isBlankLine(src, i, lineEnd)) { i = nextLine; continue; }

    const [col, first] = lineIndent(src, i, lineEnd);

    // --- link reference definition (consumed, no output) ---
    if (col <= 3 && first < lineEnd && src.charCodeAt(first) === 91) {
      const def = parseLinkDef(src, first, end);
      if (def) { i = def.end; continue; }
    }

    // --- indented code (only when not interrupting a paragraph; here we're
    // at a block boundary, so it's fine) ---
    if (col >= 4) {
      // gather indented code lines (and blank lines between them)
      let codeLines = [];
      let j = i;
      let lastContent = i;
      while (j < end) {
        let je = j;
        while (je < end && src.charCodeAt(je) !== 10) je++;
        const jne = je < end ? je + 1 : end;
        if (isBlankLine(src, j, je)) {
          // look ahead: is the next non-blank line indented code?
          let k = jne;
          let found = false;
          while (k < end) {
            let ke = k;
            while (ke < end && src.charCodeAt(ke) !== 10) ke++;
            const kne = ke < end ? ke + 1 : end;
            if (isBlankLine(src, k, ke)) { k = kne; continue; }
            const [cc] = lineIndent(src, k, ke);
            if (cc >= 4) found = true;
            break;
          }
          if (!found) break;
          // a blank line inside indented code keeps its spaces beyond the
          // 4-column code indent (e.g. 6 spaces -> 2 spaces)
          codeLines.push(stripIndentStr(src, j, je, 4));
          j = jne;
          continue;
        }
        const [cc] = lineIndent(src, j, je);
        if (cc < 4) break;
        codeLines.push(stripIndentStr(src, j, je, 4));
        lastContent = jne;
        j = jne;
      }
      // strip trailing blank lines
      while (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') codeLines.pop();
      out.push('<pre><code>' + escapeHtml(codeLines.join('\n') + (codeLines.length ? '\n' : ''), true) + '</code></pre>\n');
      i = lastContent;
      continue;
    }

    // --- fenced code ---
    if (col <= 3) {
      const fence = matchFence(src, i, lineEnd, end);
      if (fence) {
        const langAttr = fence.lang ? ' class="language-' + escapeHtml(fence.lang, false) + '"' : '';
        out.push('<pre><code' + langAttr + '>' + escapeHtml(fence.text, true) + '</code></pre>\n');
        i = fence.end;
        continue;
      }
    }

    // --- ATX heading ---
    if (col <= 3) {
      const atx = matchAtx(src, i, lineEnd);
      if (atx) {
        out.push('<h' + atx.level + '>' + inlineToHtml(atx.content, links) + '</h' + atx.level + '>\n');
        i = nextLine;
        continue;
      }
    }

    // --- thematic break ---
    if (col <= 3 && matchHr(src, i, lineEnd)) {
      out.push('<hr>\n');
      i = nextLine;
      continue;
    }

    // --- blockquote ---
    if (col <= 3 && first < lineEnd && src.charCodeAt(first) === 62) {
      // gather blockquote lines. A truly blank line ends the quote. A line
      // without `>` is a lazy continuation only while a paragraph is open
      // inside the quote and only if it is plain paragraph text (it must
      // not start a block that would interrupt a paragraph). Lazy lines
      // indented 4+ spaces lose 4 columns of indent.
      let inner = '';
      let j = i;
      let lastContent = i;
      let inFence = false;
      let fenceChar = 0;
      let fenceLen = 0;
      let paraOpen = false; // is a paragraph open inside the quote?
      while (j < end) {
        let je = j;
        while (je < end && src.charCodeAt(je) !== 10) je++;
        const jne = je < end ? je + 1 : end;
        if (isBlankLine(src, j, je)) {
          // a truly blank line ends the blockquote
          break;
        }
        const [qc, qf] = lineIndent(src, j, je);
        if (qc <= 3 && qf < je && src.charCodeAt(qf) === 62) {
          // strip '>' and one following space/tab; tabs expand on absolute
          // columns (marked expands tabs before stripping the marker), so
          // a tab straddling the space contributes its remainder as spaces
          const content = stripIndentStr(src, qf + 1, je, 1, qc + 1, true);
          inner += content + '\n';
          lastContent = jne;
          // track fenced code state inside the quote (on the stripped content)
          const cn = content.length;
          let cc = 0;
          while (cc < cn && (content.charCodeAt(cc) === 32 || content.charCodeAt(cc) === 9)) cc++;
          if (!inFence) {
            if (cc < cn && (content.charCodeAt(cc) === 96 || content.charCodeAt(cc) === 126)) {
              const fc2 = content.charCodeAt(cc);
              let m = cc;
              while (m < cn && content.charCodeAt(m) === fc2) m++;
              if (m - cc >= 3) {
                // backtick fence info must not contain a backtick
                let ok = true;
                if (fc2 === 96) {
                  for (let p = m; p < cn; p++) {
                    if (content.charCodeAt(p) === 96) { ok = false; break; }
                  }
                }
                if (ok) { inFence = true; fenceChar = fc2; fenceLen = m - cc; }
              }
            }
          } else {
            // check for a closing fence on this line
            if (cc < cn && content.charCodeAt(cc) === fenceChar) {
              let m = cc;
              while (m < cn && content.charCodeAt(m) === fenceChar) m++;
              if (m - cc >= fenceLen) {
                let ok = true;
                for (let p = m; p < cn; p++) {
                  if (content.charCodeAt(p) !== 32 && content.charCodeAt(p) !== 9) { ok = false; break; }
                }
                if (ok) inFence = false;
              }
            }
          }
          paraOpen = !inFence && contentIsParaLine(content);
          j = jne;
          continue;
        }
        // a line without `>`: lazy continuation, only while a paragraph is
        // open and not inside a fenced code block
        if (inFence || !paraOpen) break;
        if (!isLazyLine(src.slice(j, je))) break;
        // strip 4 columns of indent from a lazy line indented 4+
        let ls = j;
        let indent = 0;
        while (ls < je && indent < 4) {
          const c = src.charCodeAt(ls);
          if (c === 32) { indent++; ls++; }
          else if (c === 9) { indent += 4 - (indent % 4); ls++; }
          else break;
        }
        const lazyText = indent >= 4 ? src.slice(ls, je) : src.slice(j, je);
        inner += neutralizeLazy(lazyText) + '\n';
        lastContent = jne;
        paraOpen = true;
        j = jne;
      }
      out.push('<blockquote>\n');
      // strip trailing newlines from the inner content (marked's L)
      let innerTrimmed = inner;
      while (innerTrimmed.length > 0 && innerTrimmed.charCodeAt(innerTrimmed.length - 1) === 10) {
        innerTrimmed = innerTrimmed.slice(0, -1);
      }
      parseBlocks(innerTrimmed, links, out, undefined, inList);
      out.push('</blockquote>\n');
      i = lastContent;
      continue;
    }

    // --- list ---
    if (col <= 3) {
      const item = matchListItem(src, i, lineEnd);
      if (item) {
        const listHtml = parseList(src, i, end, links, item);
        out.push(listHtml.html);
        i = listHtml.end;
        continue;
      }
    }

    // --- HTML block ---
    if (col <= 3 && first < lineEnd && src.charCodeAt(first) === 60) {
      const hb = matchHtmlBlock(src, i, lineEnd, end, false);
      if (hb !== -1) {
        out.push(geText(src.slice(i, hb)));
        i = hb;
        continue;
      }
    }

    // --- paragraph / setext / table ---
    // Gather paragraph lines until a blank line or an interrupting block.
    {
      let paraLines = [];
      let j = i;
      let paraEnd = i;
      let setextLevel = 0;
      let tableAlign = null;
      let headerLine = null;
      while (j < end) {
        let je = j;
        while (je < end && src.charCodeAt(je) !== 10) je++;
        const jne = je < end ? je + 1 : end;
        // a whitespace-only line is a paragraph continuation only when it
        // is the final line (no trailing newline); otherwise it ends the
        // paragraph (marked's paragraph regex requires \n to call it blank)
        if (isBlankLine(src, j, je) && je < end) break;
        const [pc, pf] = lineIndent(src, j, je);
        // check for setext underline (only if we have paragraph lines)
        if (paraLines.length > 0 && pc <= 3) {
          const st = matchSetext(src, j, je);
          if (st) {
            setextLevel = st;
            paraEnd = jne;
            j = jne;
            break;
          }
        }
        // check for table delimiter (only after the first line, and only
        // if the first line is a single line so far)
        if (paraLines.length === 1 && pc <= 3) {
          const aligns = matchTableDelim(src, j, je);
          if (aligns) {
            // the delimiter must have the same number of cells as the header
            const hc = splitTableRow(paraLines[0]);
            if (hc && aligns.length === hc.length) {
              tableAlign = aligns;
              headerLine = paraLines[0];
              paraEnd = jne;
              j = jne;
              break;
            }
          }
        }
        // interrupting blocks (only after the first line, or at the start
        // the caller already handled them; but a paragraph's later lines can
        // be interrupted by ATX/fence/blockquote/hr/html/list)
        if (paraLines.length > 0 && pc <= 3) {
          if (matchAtx(src, j, je) || matchFence(src, j, je, end) || matchHr(src, j, je)) break;
          if (pf < je && src.charCodeAt(pf) === 62) break; // blockquote
          if (pf < je && src.charCodeAt(pf) === 60 && matchHtmlBlock(src, j, je, end, true) !== -1) break;
          const li = matchListItem(src, j, je);
          if (li) {
            // a list interrupts a paragraph only if the item is non-empty
            // and (bullet, or ordered starting with 1, or any ordered list
            // when the paragraph is inside a list item)
            const ci = listItemContentStart(src, j, je, li);
            if (!ci.empty && (!li.ordered || li.start === 1 || inList)) break;
          }
          // link ref definitions also end a paragraph's line run? No —
          // a def line inside a paragraph is just text. But a def at the
          // start of a line after paragraph lines: CommonMark says a link
          // reference definition can interrupt a paragraph? No, it cannot
          // interrupt a paragraph (it's parsed as part of it). Actually in
          // marked, a def line DOES get consumed during paragraph lexing
          // only at the start. We'll treat def lines as paragraph text.
        }
        paraLines.push(src.slice(j, je));
        paraEnd = jne;
        j = jne;
      }
      if (setextLevel) {
        const text = paraLines.join('\n').trim();
        out.push('<h' + setextLevel + '>' + inlineToHtml(text, links) + '</h' + setextLevel + '>\n');
        i = paraEnd;
        continue;
      }
      if (tableAlign) {
        // header row
        const headerCells = splitTableRow(headerLine);
        const aligns = tableAlign;
        // collect body rows
        const rows = [];
        let k = paraEnd;
        while (k < end) {
          let je = k;
          while (je < end && src.charCodeAt(je) !== 10) je++;
          const kne = je < end ? je + 1 : end;
          // A table body row ends only on a line that is empty or
          // spaces-only; a line containing a tab is an empty row, not a
          // blank line (marked: a '\t' line is a row of empty cells).
          let tblBlank = true;
          for (let q = k; q < je; q++) {
            if (src.charCodeAt(q) !== 32) { tblBlank = false; break; }
          }
          if (tblBlank) break;
          // whitespace-only line containing a tab: an empty row (it is
          // not indented code — it has no content — so skip the rc > 3
          // check below, which would end the table on the tab's width)
          if (isBlankLine(src, k, je)) {
            rows.push([]);
            k = kne;
            continue;
          }
          const [rc, rf] = lineIndent(src, k, je);
          if (rc > 3) break;
          // a body row must not start a blockquote
          if (src.charCodeAt(rf) === 62) break;
          // a body row must not start an ATX heading, a fence, a thematic
          // break, or a list item (marked's table body regex stops the
          // body on lines starting hr/heading/blockquote/code/fences/list/
          // html, like a paragraph interrupt; doc-07: `* Lexer ...` ends
          // the table and starts a list)
          if (matchAtx(src, k, je) || matchFence(src, k, je, end) || matchHr(src, k, je)) break;
          const tli = matchListItem(src, k, je);
          if (tli) {
            const tci = listItemContentStart(src, k, je, tli);
            if (!tci.empty && (!tli.ordered || tli.start === 1 || inList)) break;
          }
          // a body row must not start an HTML block (types 1-6 interrupt
          // a table, as they interrupt a paragraph); <details>/<summary>/
          // <div> end the table, inline HTML inside a cell does not.
          // (matchHtmlBlock returns a position, or -1; with inParagraph
          // it only matches the interrupting types 1-6, not type 7)
          if (matchHtmlBlock(src, k, je, je, true) !== -1) break;
          const cells = splitTableRow(src.slice(rf, je));
          if (cells === null) break;
          rows.push(cells);
          k = kne;
        }
        out.push('<table>\n<thead>\n<tr>\n');
        for (let ci = 0; ci < headerCells.length; ci++) {
          const a = aligns[ci];
          const attr = a ? ' align="' + a + '"' : '';
          out.push('<th' + attr + '>' + inlineToHtml(headerCells[ci].trim(), links) + '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (rows.length > 0) {
          out.push('<tbody>');
          for (const row of rows) {
            out.push('<tr>\n');
            for (let ci = 0; ci < headerCells.length; ci++) {
              const a = aligns[ci];
              const attr = a ? ' align="' + a + '"' : '';
              const cell = ci < row.length ? row[ci].trim() : '';
              out.push('<td' + attr + '>' + inlineToHtml(cell, links) + '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        i = k;
        continue;
      }
      if (paraLines.length > 0) {
        const text = paraLines.join('\n');
        if (tight) out.push(inlineToHtml(text, links));
        else out.push('<p>' + inlineToHtml(text, links) + '</p>\n');
        i = paraEnd;
        continue;
      }
      // no paragraph lines (shouldn't happen); advance one line
      i = nextLine;
    }
  }
}

// Parse a list starting at src[i]. Returns {html, end}.
function parseList(src, start, end, links, firstItem) {
  const out = [];
  const ordered = firstItem.ordered;
  const delim = firstItem.delim || null;
  const bullet = firstItem.bullet || null;
  // collect items: each item is {content (string), blankBefore, ...}
  const items = [];
  let i = start;
  let listEnd = start;
  let prevBlank = false;
  let loose = false;
  while (i < end) {
    let le = i;
    while (le < end && src.charCodeAt(le) !== 10) le++;
    const nextLine = le < end ? le + 1 : end;
    if (isBlankLine(src, i, le)) {
      // blank line: peek at the next non-blank line; if it's a list item of
      // the same list, the blank separates items (loose)
      let k = nextLine;
      let found = false;
      let blankCount = 0;
      while (k < end) {
        let ke = k;
        while (ke < end && src.charCodeAt(ke) !== 10) ke++;
        const kne = ke < end ? ke + 1 : end;
        if (isBlankLine(src, k, ke)) { blankCount++; k = kne; continue; }
        const it = matchListItem(src, k, ke);
        if (it && it.ordered === ordered && (ordered ? it.delim === delim : it.bullet === bullet)) {
          found = true;
          if (blankCount >= 0) { /* blank separates */ }
        }
        break;
      }
      if (found) {
        prevBlank = true;
        loose = true;
        i = nextLine;
        continue;
      }
      break;
    }
    // a line that is a thematic break ends the list (it is an hr, not an
    // item, even though it also matches a list marker: "* * *")
    if (matchHr(src, i, le)) break;
    const item = matchListItem(src, i, le);
    if (!item || item.ordered !== ordered || (ordered ? item.delim !== delim : item.bullet !== bullet)) break;
    // gather this item's content lines
    const ci = listItemContentStart(src, i, le, item);
    const contentIndent = ci.contentIndent;
    let content = '';
    let j = i;
    let itemEnd = nextLine;
    let itemBlank = prevBlank;
    prevBlank = false;
    // first line content (after the marker + spaces up to contentIndent);
    // tabs expand on absolute columns, so a tab straddling the indent
    // contributes its remainder as spaces
    if (!ci.empty) {
      content += stripIndentStr(src, item.first + item.markerLen, le, contentIndent - item.contentCol, item.contentCol, true) + '\n';
    }
    j = nextLine;
    // indent (relative to contentIndent) of the last content line added;
    // 0 means a top-level block of this item. A blank line only makes the
    // list loose when it separates two top-level blocks.
    let lastContentIndent = ci.empty ? -1 : 0;
    // marker key ('b-'/'b+'/'b*' or 'o.'/'o)') of the most recent list
    // item at relative indent 0, or null. A same-marker item after a
    // blank continues that list (it is not a new top-level block), so it
    // does not make the list loose (doc-15: blank between two items of
    // a nested '-' list inside an outer '*' item).
    let lastTopListMarker = null;
    // relative indent (to this item's contentIndent) of the content of
    // the most recent list item at relative indent 0, or -1. A list item
    // after a blank whose relative indent equals this is nested inside
    // that item, not a new top-level block (doc-02: a '1.' list inside
    // a '-' item, at the '-' item's content indent).
    let lastTopListContentIndent = -1;
    // track whether the item's content ends with an open paragraph (a lazy
    // line may continue it)
    let paraOpen = false;
    // track a fenced code block inside the item: blank lines inside a fence
    // are fence content, not separators between top-level blocks
    let fenceChar = 0;
    let fenceLen = 0;
    const fenceOpen = (s) => {
      if (s.length < 3) return null;
      const c = s.charCodeAt(0);
      if (c !== 96 && c !== 126) return null;
      let n = 0;
      while (n < s.length && s.charCodeAt(n) === c) n++;
      if (n < 3) return null;
      if (c === 96 && s.indexOf('`', n) !== -1) return null;
      return { c, n };
    };
    const fenceClose = (s) => {
      if (fenceChar === 0 || s.length === 0) return false;
      if (s.charCodeAt(0) !== fenceChar) return false;
      let n = 0;
      while (n < s.length && s.charCodeAt(n) === fenceChar) n++;
      if (n < fenceLen) return false;
      for (let p = n; p < s.length; p++) {
        if (s.charCodeAt(p) !== 32 && s.charCodeAt(p) !== 9) return false;
      }
      return true;
    };
    if (!ci.empty) {
      // first-line content (already added above); compute its stripped form
      const firstStripped = stripIndentStr(src, item.first + item.markerLen, le, contentIndent - item.contentCol, item.contentCol, true);
      paraOpen = contentIsParaLine(firstStripped);
      const fo = fenceOpen(firstStripped);
      if (fo) { fenceChar = fo.c; fenceLen = fo.n; }
    }
    // continuation lines
    while (j < end) {
      let je = j;
      while (je < end && src.charCodeAt(je) !== 10) je++;
      const jne = je < end ? je + 1 : end;
      if (isBlankLine(src, j, je)) {
        // an empty item followed by a blank line is empty: no content after
        if (ci.empty && content === '') break;
        // blank line: check if the following non-blank line is indented
        // enough to belong to this item, or is a new item of this list
        let k = jne;
        let belongs = false;
        let nextIndent = -1;
        let blankLines = 0;
        while (k < end) {
          let ke = k;
          while (ke < end && src.charCodeAt(ke) !== 10) ke++;
          const kne = ke < end ? ke + 1 : end;
          if (isBlankLine(src, k, ke)) { blankLines++; k = kne; continue; }
          const [kc, kf] = lineIndent(src, k, ke);
          if (kc >= contentIndent) { belongs = true; nextIndent = kc; }
          else {
            const nit = matchListItem(src, k, ke);
            if (nit && nit.ordered === ordered && (ordered ? nit.delim === delim : nit.bullet === bullet)) belongs = false;
            else belongs = false;
          }
          break;
        }
        if (belongs) {
          content += '\n';
          // A line exactly at the content indent (relative 0) is top-level
          // regardless of how indented the previous line was: the previous
          // block may itself be a nested list (a top-level block whose
          // lines are indented), and the blank line still separates it
          // from the following top-level block (doc-24: a ``` fence at
          // the content indent after a nested 4) item). But a line
          // indented 4+ past the content indent may be a nested item's
          // content, not an indented-code block (cm-307: `bim` at relative
          // 4 is inside the innermost - baz item), so the >= 4 test and
          // the relative 1-3 block-start test still need the previous
          // line to have been top-level.
          let nextTop = false;
          if (nextIndent - contentIndent === 0) {
            // A list item at the content indent that continues the most
            // recent top-level list (same marker) is not a new top-level
            // block (doc-15); a different marker starts a new list.
            let ke = k;
            while (ke < end && src.charCodeAt(ke) !== 10) ke++;
            const cs = skipIndent(src, k, ke, contentIndent);
            const nit = matchListItem(src, cs, ke);
            let continues = false;
            if (nit && lastTopListMarker !== null) {
              const key = nit.ordered ? 'o' + nit.delim : 'b' + nit.bullet;
              if (key === lastTopListMarker) continues = true;
            }
            if (!continues) nextTop = true;
          }
          else if (lastContentIndent === 0) {
            if (nextIndent - contentIndent >= 4) {
              // A line inside the most recent top-level list item's content
              // (at or past that item's content indent) belongs to that
              // nested item, not to a new top-level block (doc-30: a fence
              // at relative 9 inside the ordered item at relative 0 whose
              // content indent is 8; the blank separates blocks within
              // that ordered item, not top-level blocks of this item).
              if (lastTopListContentIndent >= 0 && nextIndent - contentIndent >= lastTopListContentIndent) {
                // inside the nested item: not a new top-level block
              } else {
              // A list-item line at relative 4+ is a nested list item
              // (a sublist of the most recent top-level item), not an
              // indented code block (doc-05: `1.` at relative 4 inside
              // innermost item 4; the blank separates blocks within that
              // item, not top-level blocks of this item). NB: matchListItem
              // only accepts <= 3 leading spaces, so check the marker
              // manually at the line's first non-space character.
              let ke = k;
              while (ke < end && src.charCodeAt(ke) !== 10) ke++;
              let p = k;
              while (p < ke && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
              let isListItem = false;
              if (p < ke) {
                const c = src.charCodeAt(p);
                if (c === 42 || c === 43 || c === 45) {
                  isListItem = p + 1 >= ke || src.charCodeAt(p + 1) === 32 || src.charCodeAt(p + 1) === 9;
                } else if (c >= 48 && c <= 57) {
                  let j = p;
                  while (j < ke && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
                  if (j - p <= 9 && j < ke && (src.charCodeAt(j) === 46 || src.charCodeAt(j) === 41)) {
                    isListItem = j + 1 >= ke || src.charCodeAt(j + 1) === 32 || src.charCodeAt(j + 1) === 9;
                  }
                }
              }
              if (!isListItem) nextTop = true;
              }
            }
            else {
              // find the following non-blank line and test for a block start
              let k2 = jne;
              while (k2 < end) {
                let ke2 = k2;
                while (ke2 < end && src.charCodeAt(ke2) !== 10) ke2++;
                if (isBlankLine(src, k2, ke2)) { k2 = ke2 < end ? ke2 + 1 : end; continue; }
                const [kc2, kf2] = lineIndent(src, k2, ke2);
                const cs2 = skipIndent(src, k2, ke2, contentIndent);
                // A list item whose relative indent equals the content
                // indent of the most recent top-level list item is nested
                // inside that item, not a new top-level block (doc-02).
                const li2 = matchListItem(src, cs2, ke2);
                let listIsTop = false;
                if (li2) {
                  const r2 = kc2 - contentIndent;
                  if (r2 !== lastTopListContentIndent) listIsTop = true;
                }
                // NB: matchHtmlBlock returns -1 on no match, and -1 is
                // truthy, so compare explicitly.
                if (listIsTop || matchAtx(src, cs2, ke2) || matchHr(src, cs2, ke2) || matchHtmlBlock(src, cs2, ke2, end, false) !== -1 || src.charCodeAt(cs2) === 62) nextTop = true;
                break;
              }
            }
          }
          if (nextTop && !fenceChar) itemBlank = true;
          paraOpen = false;
          j = jne;
          continue;
        }
        // blank line ends the item (but a following item of the same list
        // will be picked up by the outer loop)
        break;
      }
      const [cc, cf] = lineIndent(src, j, je);
      if (cc >= contentIndent) {
        const stripped = stripIndentStr(src, j, je, contentIndent, 0, true);
        content += stripped + '\n';
        itemEnd = jne;
        lastContentIndent = cc - contentIndent;
        paraOpen = contentIsParaLine(stripped);
        // track a top-level (relative indent 0) list item's marker, so a
        // same-marker item after a blank is recognised as a continuation
        if (cc - contentIndent === 0) {
          const cs0 = skipIndent(src, j, je, contentIndent);
          const li0 = matchListItem(src, cs0, je);
          if (li0) {
            lastTopListMarker = li0.ordered ? 'o' + li0.delim : 'b' + li0.bullet;
            const ci0 = listItemContentStart(src, cs0, je, li0);
            // ci0.contentIndent is relative to cs0, which sits exactly at
            // contentIndent, so it is already the relative content indent
            lastTopListContentIndent = ci0.contentIndent;
          } else {
            lastTopListMarker = null;
            lastTopListContentIndent = -1;
          }
        }
        if (fenceChar) {
          if (fenceClose(stripped)) { fenceChar = 0; fenceLen = 0; }
        } else {
          const fo = fenceOpen(stripped);
          if (fo) { fenceChar = fo.c; fenceLen = fo.n; }
        }
        j = jne;
        continue;
      }
      // a line with less indent: a lazy continuation of an open paragraph.
      // A list-item line is never lazy here (it starts a new item or list).
      // A lazy line is NOT part of the item's indented content, so the
      // item's content indent must not be stripped from it (doc-06: a
      // lazy ` ![commit]...` line keeps its one leading space, which
      // marked preserves as `\n <img` in the paragraph). Only strip 4
      // columns when the line is indented 4+, so it is not re-parsed as
      // an indented code block (mirrors the blockquote lazy path).
      if (paraOpen && !matchListItem(src, j, je) && isLazyLine(src.slice(j, je))) {
        const [lc] = lineIndent(src, j, je);
        const lazyContent = lc >= 4 ? stripIndentStr(src, j, je, 4, 0, true) : src.slice(j, je);
        content += neutralizeLazy(lazyContent) + '\n';
        itemEnd = jne;
        j = jne;
        continue;
      }
      // a line with less indent: could be a new item of this list (handled
      // by outer loop) or the end of the list
      break;
    }
    // remove trailing blank lines from content; the item text has no
    // trailing newline (marked strips it), so an HTML block at the end
    // does not gain one
    content = content.replace(/\n+$/, '');
    items.push({ content, blankBefore: itemBlank });
    listEnd = itemEnd;
    i = j;
    // if the next line is a list item of this list, continue; the outer
    // while loop handles blank lines and items
    if (prevBlank) loose = true;
  }
  // determine loose: if any item is separated by a blank line, or any item
  // contains two top-level blocks separated by a blank line (itemBlank is
  // set during gathering only for top-level blanks, so nested blanks do
  // not make the outer list loose)
  if (!loose) {
    for (const it of items) {
      if (it.blankBefore) { loose = true; break; }
    }
  }
  // marked trimEnd()s the LAST item's raw and text: trailing whitespace
  // (spaces/tabs) at the end of the last item is stripped, while earlier
  // items keep theirs.
  if (items.length > 0) {
    items[items.length - 1].content = items[items.length - 1].content.replace(/[ \t\r\n]+$/, '');
  }
  // render
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && firstItem.start !== 1 ? ' start="' + firstItem.start + '"' : '';
  out.push('<' + tag + startAttr + '>\n');
  for (const it of items) {
    // task list checkbox
    let content = it.content;
    let checkbox = '';
    const tm = /^ *\[[ xX]\]([ \t]+|$)/.exec(content);
    // task marker must be at the start of the item content
    const taskRe = /^\[([ xX])\][ \t]+/;
    const taskM = taskRe.exec(content);
    if (taskM) {
      const checked = taskM[1] === 'x' || taskM[1] === 'X';
      checkbox = checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      content = content.slice(taskM[0].length);
    }
    // render the item content as blocks; in a tight list, top-level
    // paragraphs lose their <p> tags (parseBlocks handles it via tight)
    const inner = [];
    parseBlocks(content, links, inner, !loose, true);
    let innerHtml = inner.join('');
    // in a loose list the checkbox goes INSIDE the leading <p>; in a tight
    // list it goes directly after <li>
    if (checkbox && loose && innerHtml.startsWith('<p>')) {
      innerHtml = '<p>' + checkbox + innerHtml.slice(3);
    } else {
      innerHtml = checkbox + innerHtml;
    }
    out.push('<li>' + innerHtml + '</li>\n');
  }
  out.push('</' + tag + '>\n');
  return { html: out.join(''), end: listEnd };
}

// ---------- entry point ----------
export function parse(markdown) {
  let src = markdown.replace(/\r\n?/g, '\n');
  // reset the document-level inline lexer state (see inlineState)
  inlineState.inLink = false;
  inlineState.inRawBlock = false;
  const links = collectLinkDefs(src);
  const out = [];
  parseBlocks(src, links, out);
  return out.join('');
}
