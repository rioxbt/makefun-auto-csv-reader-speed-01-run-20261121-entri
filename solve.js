// A faster drop-in for make.fun's csv-reader 1.0.0, the house baseline of csv-reader-speed-01-run-20261121.
//
// run(input) returns csv-reader 1.0.0's own answer for {text, header}: {columns, rows, errors}, the same JSON value on
// every input, string code unit for code unit. The reading policy is csv-reader's, unchanged: a U+FEFF at the very
// start is dropped; a record ends at LF or CRLF and a line left with no characters is no record; outside quotes a CR
// not followed by LF is dropped (stray_cr); a field that opens with a quote runs to the next quote that is not doubled
// ("" read as one quote, each CRLF or lone CR inside read as LF) and what follows its closing quote, up to the next
// comma or line break, is appended as it stands (quote_junk, when the field ends); a quote that never closes is a
// literal character and the text after it is read again as unquoted (unterminated_quote); a quote inside an unquoted
// field is a literal character; fields stay strings, never trimmed or converted; columns is the first record when
// header is true, else null; rows holds the records after it (every record when header is false), each padded with ""
// (short_row, fields: its count) or cut (long_row, extra: the cut fields) to the first record's width; each error is
// {code, line, row} in the order met, line the 1-based line its record starts on (every LF, CRLF and lone CR inside a
// quoted field counted) and row its record's index in rows (null for the header).
//
// An error object carries every key its kind may hold, the ones it does not hold left undefined: all four error sites
// then share one object shape, and JSON.stringify writes only the keys an error holds, so the answer is unchanged.
//
// Why it is faster than the house baseline, which reads one character at a time and builds every field a character at
// a time:
//
//   - a field's run of plain characters is found by one scan and taken as a single string slice (V8 keeps a long slice
//     as a view onto the text: no copy and no per-character concatenation);
//   - one record is read by one small function, readRecord, called once per record (~63k times on a set), rather than a
//     single huge loop per case. V8 then compiles that function once, by invocation count, instead of re-optimizing
//     (on-stack-replacing) one large loop on every case's call, which on Node 22 costs more CPU than the parse itself;
//   - the two rare paths, a stray CR and a quoted field, live in their own functions, so the function the hot path runs
//     in stays small and its cold branches cost little when they first run;
//   - the cursor, the line and the error list are plain locals in the function that uses them.
//
// Peak memory is not scored; nothing is kept from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

/**
 * Reads unquoted characters from st.pos up to the next comma or line break, appending them to `value` (the field's
 * characters so far: '' for a field that starts here, the quoted content when a closing quote was followed by junk, '"'
 * when a quote never closed). A CR not followed by LF is dropped and recorded as stray_cr. Sets st.pos, st.line,
 * st.ended and st.added (the characters kept) and returns the field's value.
 *
 * st: { text, n, pos, line, ended, added, errors, recordLine, recordRow }.
 */
function readUnquotedFrom(st, value, added) {
  const text = st.text;
  const n = st.n;
  let pos = st.pos;
  for (;;) {
    const segStart = pos;
    let ch = 0;
    while (pos < n) {
      ch = text.charCodeAt(pos);
      if (ch === 44 || ch === 10 || ch === 13) break;
      pos += 1;
    }
    if (pos > segStart) {
      const s = text.slice(segStart, pos);
      value = value.length === 0 ? s : value + s;
      added += pos - segStart;
    }
    if (pos >= n) {
      st.ended = END;
      break;
    }
    if (ch === 44) {
      pos += 1;
      st.ended = COMMA;
      break;
    }
    if (ch === 10) {
      pos += 1;
      st.line += 1;
      st.ended = LINE_BREAK;
      break;
    }
    if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      st.line += 1;
      st.ended = LINE_BREAK;
      break;
    }
    // A lone CR outside quotes: dropped, recorded, and the field goes on.
    st.errors.push({ code: 'stray_cr', line: st.recordLine, row: st.recordRow, fields: undefined, extra: undefined });
    pos += 1;
  }
  st.pos = pos;
  st.added = added;
  return value;
}

/**
 * Reads the quoted field whose opening quote is at st.pos: to the next quote that is not doubled, "" read as one quote
 * and each CRLF or lone CR inside read as LF. What follows the closing quote, up to the next comma or line break, is
 * appended to the field as it stands (quote_junk, when it added characters). A quote that never closes is a literal
 * character and the text after it is read again as unquoted (unterminated_quote). Sets st.pos, st.line and st.ended and
 * returns the field's value.
 */
function readQuoted(st) {
  const text = st.text;
  const n = st.n;
  const open = st.pos;
  const openLine = st.line;
  let pos = open + 1;
  let segStart = pos;
  let line = openLine;
  let acc = '';
  let closed = false;
  while (pos < n) {
    const ch = text.charCodeAt(pos);
    if (ch === 34) {
      if (pos > segStart) {
        const s = text.slice(segStart, pos);
        acc = acc.length === 0 ? s : acc + s;
      }
      if (pos + 1 < n && text.charCodeAt(pos + 1) === 34) {
        // A doubled quote inside the field is one quote.
        acc += '"';
        pos += 2;
        segStart = pos;
        continue;
      }
      pos += 1;
      closed = true;
      break;
    }
    if (ch === 13 || ch === 10) {
      // CRLF and a lone CR inside quotes are each one LF, and each one counts a line.
      if (pos > segStart) {
        const s = text.slice(segStart, pos);
        acc = acc.length === 0 ? s : acc + s;
      }
      acc += '\n';
      line += 1;
      pos += ch === 13 ? (pos + 1 < n && text.charCodeAt(pos + 1) === 10 ? 2 : 1) : 1;
      segStart = pos;
      continue;
    }
    pos += 1;
  }
  st.line = line;
  st.pos = pos;
  if (!closed) {
    // The quote never closes: it is a literal character and the text after it is read again as unquoted.
    st.pos = open + 1;
    st.line = openLine;
    st.errors.push({ code: 'unterminated_quote', line: st.recordLine, row: st.recordRow, fields: undefined, extra: undefined });
    return readUnquotedFrom(st, '"', 0);
  }
  if (pos >= n) {
    st.ended = END;
    return acc;
  }
  const nx = text.charCodeAt(pos);
  if (nx === 44) {
    st.pos = pos + 1;
    st.ended = COMMA;
    return acc;
  }
  if (nx === 10) {
    st.pos = pos + 1;
    st.line = line + 1;
    st.ended = LINE_BREAK;
    return acc;
  }
  if (nx === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
    st.pos = pos + 2;
    st.line = line + 1;
    st.ended = LINE_BREAK;
    return acc;
  }
  // What follows the closing quote is appended as it stands, up to the next comma or line break.
  const value = readUnquotedFrom(st, acc, 0);
  if (st.added > 0) st.errors.push({ code: 'quote_junk', line: st.recordLine, row: st.recordRow, fields: undefined, extra: undefined });
  return value;
}

/**
 * Reads the one record at st.pos (which the caller leaves at a character that is not a line break) and records it: its
 * fields, the width of the first record, the header when it is the first record and header is true, the row itself,
 * padded or cut, and the errors the record met. Sets st.pos and st.line past the record.
 */
function readRecord(st) {
  const text = st.text;
  const n = st.n;
  const fields = [];
  let pos = st.pos;
  let line = st.line;
  st.recordLine = line;
  st.recordRow = st.header && st.columns === null ? null : st.rows.length;
  const firstQuoted = text.charCodeAt(pos) === 34;
  let ended = 0;
  for (;;) {
    let value;
    if (text.charCodeAt(pos) === 34) {
      st.pos = pos;
      st.line = line;
      value = readQuoted(st);
      pos = st.pos;
      line = st.line;
      ended = st.ended;
    } else {
      // A field that does not open with a quote: one scan for the run up to the next comma or line break.
      let q = pos;
      let ch = 0;
      while (q < n) {
        ch = text.charCodeAt(q);
        if (ch === 44 || ch === 10 || ch === 13) break;
        q += 1;
      }
      if (ch !== 13) {
        value = q > pos ? text.slice(pos, q) : '';
        if (q >= n) {
          pos = n;
          ended = END;
        } else if (ch === 44) {
          pos = q + 1;
          ended = COMMA;
        } else {
          pos = q + 1;
          line += 1;
          ended = LINE_BREAK;
        }
      } else if (q + 1 < n && text.charCodeAt(q + 1) === 10) {
        value = q > pos ? text.slice(pos, q) : '';
        pos = q + 2;
        line += 1;
        ended = LINE_BREAK;
      } else {
        // A lone CR ends neither the field nor the record: readUnquotedFrom drops it and reads on.
        value = q > pos ? text.slice(pos, q) : '';
        st.pos = q;
        st.line = line;
        value = readUnquotedFrom(st, value, q - pos);
        pos = st.pos;
        line = st.line;
        ended = st.ended;
      }
    }
    fields.push(value);
    if (ended !== COMMA) break;
  }
  st.pos = pos;
  st.line = line;

  // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
  if (fields.length === 1 && fields[0] === '' && !firstQuoted) return;

  let width = st.width;
  if (width < 0) {
    width = fields.length;
    st.width = width;
  }
  if (st.header && st.columns === null) {
    st.columns = fields;
    return;
  }
  if (fields.length < width) {
    st.errors.push({ code: 'short_row', line: st.recordLine, row: st.recordRow, fields: fields.length, extra: undefined });
    while (fields.length < width) fields.push('');
  } else if (fields.length > width) {
    st.errors.push({ code: 'long_row', line: st.recordLine, row: st.recordRow, fields: undefined, extra: fields.splice(width) });
  }
  st.rows.push(fields);
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const st = {
    text,
    n,
    pos: 0,
    line: 1,
    ended: 0,
    added: 0,
    errors: [],
    rows: [],
    header,
    width: -1,
    columns: null,
    recordLine: 1,
    recordRow: null,
  };
  // A U+FEFF at the very start of the text is dropped.
  if (n !== 0 && text.charCodeAt(0) === 0xfeff) st.pos = 1;

  while (st.pos < n) {
    // A line left with no characters is no record: skip its line breaks, counting them.
    let pos = st.pos;
    let line = st.line;
    let c = text.charCodeAt(pos);
    while (c === 10 || (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10)) {
      pos += c === 10 ? 1 : 2;
      line += 1;
      if (pos >= n) break;
      c = text.charCodeAt(pos);
    }
    st.pos = pos;
    st.line = line;
    if (pos >= n) break;
    readRecord(st);
  }

  return { columns: header ? (st.columns === null ? [] : st.columns) : null, rows: st.rows, errors: st.errors };
}
