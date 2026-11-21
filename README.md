# makefun-auto-csv-reader-speed-01-run-20261121-entri

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/rioxbt/makefun-auto-csv-reader-speed-01-run-20261121-entri/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/rioxbt/makefun-auto-csv-reader-speed-01-run-20261121-entri/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0 (the house baseline of the “Read broken CSV files faster, 21 November 2026” bounty): the same answers, code unit for code unit, at about a third of the CPU time. Entries rank on CPU time alone, least first, and a reward needs beating csv-reader at 95% confidence.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node --version   # 22.18 or later
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each one with `run`
from `solve.js`, and writes `/output/answers.json`. `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input`
and `/output` outside a container. It sets V8's incremental marking off before importing `solve.js`, as the house
baseline does, and may tune V8's flags the same way.

## What it does

`solve.js` exports `run(input)`; for a case's `{text, header}` it returns csv-reader 1.0.0's own reading of it,
`{columns, rows, errors}`, exactly: a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a line left
with no characters is no record; outside quotes a CR not followed by LF is dropped (`stray_cr`); a field that opens with
a quote runs to the next quote that is not doubled (`""` one quote, each CRLF or lone CR inside read as LF) and what
follows its closing quote, up to the next comma or line break, is appended as it stands (`quote_junk`, when the field
ends); a quote that never closes is a literal character and the text after it is read again as unquoted
(`unterminated_quote`); a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or
converted; `columns` is the first record when `header` is true, else null; `rows` holds the records after it, each
padded with `""` (`short_row`, with `fields`) or cut (`long_row`, with `extra`) to the first record's width; each error
is `{code, line, row}` in the order met, `line` the 1-based line its record starts on and `row` its record's index in
`rows` (null for the header).

## Why it is faster than csv-reader 1.0.0

csv-reader 1.0.0 reads one character at a time and builds every field by appending one character at a time. This reader:

- finds each field's run of plain characters with one scan and takes it as a single **string slice** — V8 keeps a long
  slice as a view onto the text, so there is no copy and no per-character concatenation;
- reads **one record per call of a small function**, `readRecord` (about 63k calls on a 6-case set), instead of running
  one huge loop per case. V8 compiles that function once, by invocation count, instead of re-optimizing
  (on-stack-replacing) one large loop on every case's call — on Node 22 that re-compilation alone costs more CPU than
  the parse;
- keeps the two rare paths, a stray CR and a quoted field, in **their own functions**, so the function the hot path runs
  in stays small and its cold branches cost little the first time they run;
- holds the cursor, the line and the error list in **plain locals** in the function that uses them, and gives every
  error object one shape, so V8 does not deoptimize the reader when a rare error first appears.

Nothing is kept from one call to the next, and peak memory is not scored.

## Measured

On the practice set published in the kit (6 cases, 10,193,953 characters of CSV), a fresh single run of `node main.ts`,
CPU time (user + sys) taken as the least of 6 runs on the machine that built this entry:

| runtime (node) | csv-reader 1.0.0 | this entry | speedup |
| --- | --- | --- | --- |
| 22.23.4 (the grader's runtime) | 1.52 s | 0.52 s | 2.9x |
| 24.22.3 | 1.46 s | 0.52 s | 2.8x |

Run-to-run the entry stays at 0.50–0.53 s while the baseline moves between 1.46 s and 1.64 s on the same machine, so
the margin is between 2.8x and 3.2x.

Verified against the kit's own reference and scorer: `passed 1`, `cases_passed 6/6`, the two runtimes' answers
byte-identical, and a differential fuzz of 566,012 small and nasty inputs across two seeds (random CR/LF/CRLF/quote/
comma soups and random windows of the real cases) against `baselines/csv-reader/vendor/csv-reader/index.js` with no
divergence.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
