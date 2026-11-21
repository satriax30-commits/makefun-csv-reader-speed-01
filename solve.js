// A fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same input:
// {columns, rows, errors}, with its exact broken-row policy:
//  - a U+FEFF at the very start is dropped;
//  - a record ends at LF or CRLF, and a line left with no characters is no record;
//  - outside quotes a CR not followed by LF is dropped (stray_cr);
//  - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//    it is one quote, and each CRLF or lone CR inside it is read as LF; what follows its
//    closing quote, up to the next comma or line break, is appended as it stands (quote_junk,
//    when the field ends); a quote that never closes is a literal character, and the text
//    after it is read again as unquoted (unterminated_quote);
//  - a quote inside an unquoted field is a literal character; fields stay strings, never
//    trimmed or converted;
//  - columns is the first record when header is true, else null; rows holds the records
//    after it, each padded with "" (short_row, with fields: its count) or cut (long_row,
//    with extra: the cut fields) to the first record's width;
//  - each error is {code, line, row}, in the order met, a field's quote_junk when the field
//    ends and a record's short_row or long_row when the record ends: line the 1-based line
//    its record starts on, row its record's index in rows, null for the header.
//
// How it is faster than the reference: the reference reads one character at a time and builds
// every field up a character at a time. This reads one field at a time instead: an unquoted
// field is found with indexOf(',') / indexOf('\n') and sliced out whole (a lone CR inside it
// is found on the slice and dropped with a stray_cr error, exactly as the reference drops it
// while reading the field), and a quoted field jumps from quote to quote with indexOf('"'),
// slicing the text between two quotes whole and only walking it when it holds a line break
// or a CR (for line counting and CR-to-LF conversion). No dependencies, no network, no
// clock, no randomness: deterministic, one left-to-right pass.

const COMMA = 0;
const LINE = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  while (pos < n) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;

    {
      let fEnded;

    do {
      quoted = text.charCodeAt(pos) === 34;
      let fVal = '';
      let fAdded = 0;
      // init: the value an unquoted scan starts from ('': a plain field; the quoted value:
      // what follows a closing quote; '"': a quote that never closed, read again as unquoted).
      // needUnquoted: run the unquoted scan below (a plain field, quote junk, or an
      // unterminated quote's re-read).
      let init = '';
      let needUnquoted = true;
      // junk: the field closed, and what follows the closing quote is being appended.
      let junk = false;

      if (quoted) {
        // A field that opens with a quote: run to the next quote that is not doubled.
        const open = pos;
        const openLine = line;
        pos += 1;
        let val = '';
        let parts = null; // segments, joined only when more than one
        let p = pos;
        let closed = false;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q === -1) {
            // The quote never closes: it is a literal character, and the text after it is
            // read again as unquoted. What the quoted scan gathered is discarded, and the
            // line count goes back to the line the quote opened on.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            init = '"';
            needUnquoted = true;
            break;
          }
          if (q > p) {
            // The text between two quotes, sliced whole. Only when it holds a line break
            // or a CR is it walked, for line counting and CR-to-LF conversion.
            const seg = text.slice(p, q);
            const nl = seg.indexOf('\n');
            const cr = seg.indexOf('\r');
            if (nl === -1 && cr === -1) {
              if (parts !== null) parts.push(seg);
              else if (val === '') val = seg;
              else { parts = [val, seg]; val = ''; }
            } else if (cr === -1) {
              let count = 0;
              let from = 0;
              let k;
              while ((k = seg.indexOf('\n', from)) !== -1) { count += 1; from = k + 1; }
              line += count;
              if (parts !== null) parts.push(seg);
              else if (val === '') val = seg;
              else { parts = [val, seg]; val = ''; }
            } else {
              // Each CRLF or lone CR inside quotes is one LF.
              const out = [];
              let s = 0;
              let count = 0;
              for (;;) {
                const r = seg.indexOf('\r', s);
                const l = seg.indexOf('\n', s);
                if (r === -1 && l === -1) { out.push(seg.slice(s)); break; }
                if (l !== -1 && (r === -1 || l < r)) {
                  out.push(seg.slice(s, l + 1));
                  count += 1;
                  s = l + 1;
                } else {
                  out.push(seg.slice(s, r));
                  out.push('\n');
                  count += 1;
                  s = r + 1;
                  if (seg.charCodeAt(s) === 10) s += 1;
                }
              }
              line += count;
              const conv = out.join('');
              if (parts !== null) parts.push(conv);
              else if (val === '') val = conv;
              else { parts = [val, conv]; val = ''; }
            }
          }
          if (text.charCodeAt(q + 1) === 34) {
            // "" inside quotes is one quote.
            if (parts !== null) parts.push('"');
            else if (val === '') val = '"';
            else { parts = [val, '"']; val = ''; }
            p = q + 2;
            continue;
          }
          // The closing quote.
          pos = q + 1;
          closed = true;
          break;
        }
        if (closed) {
          const done = parts !== null ? parts.join('') : val;
          if (pos >= n) {
            fVal = done;
            fEnded = END;
            needUnquoted = false;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fVal = done;
              fEnded = COMMA;
              needUnquoted = false;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fVal = done;
              fEnded = LINE;
              needUnquoted = false;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fVal = done;
              fEnded = LINE;
              needUnquoted = false;
            } else {
              // What follows the closing quote is appended as it stands, up to the next
              // comma or line break.
              init = done;
              fAdded = 0;
              junk = true;
              needUnquoted = true;
            }
          }
        }
      }

      if (needUnquoted) {
        // An unquoted field: the next comma or line break ends it, sliced out whole. A CR
        // not followed by LF is dropped (stray_cr); a CR at the very end of a field that
        // ends at a line break is the CRLF half, not an error.
        let val = init;
        let added = 0;
        const comma = text.indexOf(',', pos);
        const lf = text.indexOf('\n', pos);
        let end;
        let ended;
        if (comma === -1 && lf === -1) { end = n; ended = END; }
        else if (lf === -1 || (comma !== -1 && comma < lf)) { end = comma; ended = COMMA; }
        else { end = lf; ended = LINE; }
        if (end > pos) {
          const seg = text.slice(pos, end);
          const cr = seg.indexOf('\r');
          if (cr === -1) {
            val += seg;
            added += seg.length;
          } else {
            let s = seg;
            if (ended === LINE && seg.charCodeAt(seg.length - 1) === 13) s = seg.slice(0, -1);
            let cleaned = '';
            let from = 0;
            let k;
            let count = 0;
            while ((k = s.indexOf('\r', from)) !== -1) {
              cleaned += s.slice(from, k);
              count += 1;
              from = k + 1;
            }
            cleaned += s.slice(from);
            for (let t = 0; t < count; t++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            val += cleaned;
            added += cleaned.length;
          }
        }
        if (ended === COMMA) pos = end + 1;
        else if (ended === LINE) { pos = end + 1; line += 1; }
        else pos = n;
        fVal = val;
        fEnded = ended;
        fAdded = added;
      }

      fields.push(fVal);
      // A field that followed a closing quote and took on characters is quote_junk.
      if (junk && fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    } while (fEnded === COMMA);

      // A line that held only stray CRs is left with no characters: no record (its
      // stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
