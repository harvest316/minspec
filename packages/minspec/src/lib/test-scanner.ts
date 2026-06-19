/**
 * Test-Source Scanner — SPEC-006 (stub-completeness gate), #130 hollow-test hole.
 *
 * Deterministic, Tier-0 (DR-004): pure string/lexical analysis, no TypeScript AST
 * dependency, no AI, no network, no `vscode`. Given the SOURCE of a test file it
 * reports each test that does not actually verify anything:
 *
 *   - kind: 'stub'   — the test has no real body to run: an empty/placeholder body,
 *                      a `throw new Error('not implemented')` / `notImplemented`, or
 *                      it is skipped (`it.skip` / `test.skip` / `xit` / `xtest`).
 *                      (This is SPEC-006's original stub behavior — DO NOT regress.)
 *   - kind: 'hollow' — the test runs but never makes a MEANINGFUL assertion (#130):
 *                      no `expect(...)` / `assert(...)` call at all; or only
 *                      tautological assertions that can never fail
 *                      (`expect(true).toBe(true)`, `expect(1).toBe(1)`,
 *                      `assert(true)`, comparing two trivially-equal literals,
 *                      asserting a literal-true is truthy, …).
 *
 * Both are reported through ONE finding type (`TestFinding`) discriminated by
 * `kind`, so a caller (SPEC-013 FR-9 L4's Test-cell green-ness predicate) can tell
 * a stub from a hollow test while sharing one engine — RD-3's "no parallel
 * scanning path" requirement.
 *
 * False-positive guard (mirrors SPEC-006 FR-6): comments and string-literal
 * contents are stripped (replaced by spaces, preserving line numbers) before any
 * assertion/marker matching, so an assertion mentioned inside a string or a
 * commented-out assertion is NOT counted as a real assertion.
 */

/** What made a test fail the gate. */
export type TestFindingKind = 'stub' | 'hollow';

/** A single test that the scanner rejects. One shape for both stub & hollow. */
export interface TestFinding {
  /** The scanned file's path (passed through verbatim). */
  readonly file: string;
  /** 1-based line of the test declaration (`it(`/`test(`). */
  readonly line: number;
  /** The test's title as written in the `it`/`test` call, when extractable. */
  readonly testName: string;
  /** 'stub' (no runnable body) vs 'hollow' (runs but asserts nothing real). */
  readonly kind: TestFindingKind;
  /** Human-readable reason; stable enough for callers to message on. */
  readonly reason: string;
}

// ── Comment / string blanking ────────────────────────────────────────────────
//
// Replace the CONTENTS of comments and string/template literals with spaces,
// keeping every newline so line numbers and brace nesting outside strings are
// preserved. This is the FR-6 false-positive guard: an `expect(...)` or a
// `not implemented` that lives inside a string or a comment is not code.

/**
 * Blank out comments and string/template-literal bodies, preserving newlines and
 * character positions (so an index into the result aligns with the original).
 *
 * @param keepStrings when true, only COMMENTS are blanked; string-literal bodies
 *   are kept verbatim. Used for stub-marker detection, where the canonical marker
 *   `throw new Error('not implemented')` carries its text inside a string — that
 *   string is genuine code intent, not the FR-6 "describing" false-positive case.
 *   When false (default) both comments AND strings are blanked, for assertion
 *   detection where an assertion *mentioned* in a string must not count.
 */
function blankCommentsAndStrings(src: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';

  const keepNewlines = (s: string): string => s.replace(/[^\n]/g, ' ');

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        mode = 'line';
        out += '  ';
        i += 2;
      } else if (c === '/' && c2 === '*') {
        mode = 'block';
        out += '  ';
        i += 2;
      } else if (c === "'") {
        mode = 'sq';
        out += "'";
        i += 1;
      } else if (c === '"') {
        mode = 'dq';
        out += '"';
        i += 1;
      } else if (c === '`') {
        mode = 'tpl';
        out += '`';
        i += 1;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
        i += 1;
      } else {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (mode === 'block') {
      if (c === '*' && c2 === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    // String / template literal bodies.
    const quote = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
    if (c === '\\') {
      // Escaped char — keep verbatim when keepStrings, else blank both chars.
      out += keepStrings ? src.slice(i, i + 2) : keepNewlines(src.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (c === quote) {
      mode = 'code';
      out += quote;
      i += 1;
      continue;
    }
    // Note: template `${...}` interpolation is treated as string content here.
    // Assertions inside an interpolation are vanishingly rare in test bodies and
    // blanking them keeps the lexer simple; the cost is at most a false 'hollow'
    // on such an exotic construction, never a false 'pass'.
    if (keepStrings) {
      out += c;
    } else {
      out += c === '\n' ? '\n' : ' ';
    }
    i += 1;
  }

  return out;
}

// ── Test-block discovery ─────────────────────────────────────────────────────

/**
 * Matches the start of a test declaration on the BLANKED source:
 *   it( / test( / it.skip( / test.only( / it.each(...) ( / xit( / fit( …
 * Group 1 = base fn (it|test|xit|xtest|fit|ftest), group 2 = optional modifier
 * chain (e.g. `.skip`, `.only`, `.each([...])`). We then read the title from the
 * first string argument that follows.
 */
const TEST_DECL_RE =
  /\b(it|test|xit|xtest|fit|ftest)((?:\.\w+(?:\([^)]*\))?)*)\s*\(/g;

interface RawTestBlock {
  /** 1-based line of the declaration. */
  line: number;
  /** Title string (raw, from the original source). */
  name: string;
  /** Index in blanked source where the declaration's `(` opens. */
  declParenIdx: number;
  /** The base function name (it/test/xit/...). */
  base: string;
  /** The modifier chain (`.skip`, `.only`, …), lowercased, no args. */
  modifiers: string[];
  /** The callback body `{...}` contents (fully blanked), or null if none found. */
  body: string | null;
  /** The same body span sliced from the ORIGINAL source (real text), or null. */
  originalBody: string | null;
  /** The same body span with comments blanked but STRINGS KEPT (stub markers). */
  markerBody: string | null;
  /** Whether the callback exists but is an empty `{}` body. */
  emptyBody: boolean;
}

/** Count newlines in `s[0..idx)` to derive a 1-based line number. */
function lineAt(s: string, idx: number): number {
  let line = 1;
  for (let k = 0; k < idx && k < s.length; k++) {
    if (s[k] === '\n') line++;
  }
  return line;
}

/**
 * From the blanked source starting just after a declaration's opening `(`, find
 * the first string-argument's span in the ORIGINAL source so we can read the
 * (un-blanked) title. We scan the original for the first quote at or after start.
 */
function readTitle(original: string, fromIdx: number): string {
  // Skip whitespace.
  let i = fromIdx;
  while (i < original.length && /\s/.test(original[i])) i++;
  const q = original[i];
  if (q !== "'" && q !== '"' && q !== '`') return '';
  let out = '';
  i++;
  while (i < original.length) {
    const c = original[i];
    if (c === '\\') {
      out += original[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === q) break;
    out += c;
    i++;
  }
  return out;
}

/**
 * Find the callback body `{...}` for a test whose declaration `(` sits at
 * `declParenIdx`, bounded by `endIdx` (the next test declaration, so a later
 * test's braces can't be mistaken for this one's). Brace-matching runs on the
 * fully-blanked source. Returns the ABSOLUTE [open+1, close) span of the body in
 * the source, or null when no balanced `{...}` callback is found.
 */
function findBodySpan(
  blanked: string,
  declParenIdx: number,
  endIdx: number,
): { start: number; end: number } | null {
  const limit = endIdx === -1 ? blanked.length : endIdx;
  let open = -1;
  for (let i = declParenIdx + 1; i < limit; i++) {
    if (blanked[i] === '{') {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  return null; // unbalanced
}

function findTestBlocks(
  original: string,
  blanked: string,
  markerSrc: string,
): RawTestBlock[] {
  const decls: { idx: number; base: string; modChain: string }[] = [];
  TEST_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEST_DECL_RE.exec(blanked)) !== null) {
    // index of the opening `(` = end of the whole match minus 1.
    const parenIdx = m.index + m[0].length - 1;
    decls.push({ idx: parenIdx, base: m[1], modChain: m[2] ?? '' });
  }

  const blocks: RawTestBlock[] = [];
  for (let d = 0; d < decls.length; d++) {
    const { idx, base, modChain } = decls[d];
    const nextIdx = d + 1 < decls.length ? decls[d + 1].idx : -1;
    const span = findBodySpan(blanked, idx, nextIdx);
    const body = span ? blanked.slice(span.start, span.end) : null;
    const originalBody = span ? original.slice(span.start, span.end) : null;
    const markerBody = span ? markerSrc.slice(span.start, span.end) : null;
    const emptyBody = body !== null && body.trim() === '';
    const modifiers = (modChain.match(/\.\w+/g) ?? []).map((s) => s.slice(1).toLowerCase());
    blocks.push({
      line: lineAt(blanked, idx),
      name: readTitle(original, idx + 1),
      declParenIdx: idx,
      base,
      modifiers,
      body,
      originalBody,
      markerBody,
      emptyBody,
    });
  }
  return blocks;
}

// ── Classification ───────────────────────────────────────────────────────────

const SKIP_MODIFIERS = new Set(['skip', 'todo', 'skipif', 'failing']);
const SKIP_BASES = new Set(['xit', 'xtest']);

/** A `throw new Error('not implemented')` / `notImplemented` / TODO-marker stub body. */
const NOT_IMPLEMENTED_RE =
  /\bthrow\b[\s\S]*?\bnot\s+implemented\b|\bnotImplemented\b|\bnot\s+yet\s+implemented\b/i;

/** Any `expect(` or `assert`-family call (real OR tautological — we classify next). */
const ANY_ASSERTION_RE = /\bexpect\s*\(|\bassert\b/;

/**
 * A meaningful assertion is one of:
 *   - an `expect(...)` whose argument is NOT a bare literal, OR is a literal but
 *     whose matcher compares to a DIFFERENT literal (we conservatively treat any
 *     `expect(<non-literal>)` as meaningful, and any `expect(<literal>).<m>(...)`
 *     as a candidate tautology to inspect).
 *   - an `assert(<expr>)` where `<expr>` is not a bare boolean/number literal.
 *   - any `assert.<method>(...)` (deepEqual/equal/ok/throws/…), which always
 *     references runtime values.
 *
 * We implement this as: there EXISTS at least one assertion occurrence that is
 * NOT tautological. So the predicate below detects tautological occurrences and
 * the scanner flags 'hollow' only when EVERY assertion present is tautological
 * (or there are none).
 */

/**
 * A JS literal token used as an argument: a keyword literal, a number, or a
 * QUOTED STRING. In the fully-blanked body a string's interior is spaces, so a
 * string literal looks like `'   '` / `"…"` / `` `…` `` (quotes wrapping only
 * spaces) — matched by the quote-and-spaces alternative.
 */
const LITERAL_ARG_RE =
  /^\s*(?:true|false|null|undefined|NaN|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`)\s*$/;

/** True when the (blanked) arg token is a blanked STRING literal (`'  '`, `"…"`). */
const BLANKED_STRING_RE = /^\s*(['"`])\s*\1\s*$/;

/** Tautology matchers that are trivially true when applied to a literal-true / matching literal. */
const ALWAYS_TRUE_MATCHERS = new Set([
  'tobe', 'toequal', 'tostrictequal', 'tobetruthy', 'tobedefined',
]);

/**
 * Scan a (blanked) test body and return true if it contains at least ONE
 * meaningful (non-tautological) assertion. Comments/strings are already blanked,
 * so a string literal that *mentions* expect won't match (its `(` content is
 * spaces, and the surrounding quotes break the `expect(` token only if adjacent —
 * but `'expect(true)...'` blanks to `'                 '`, so no `expect(` token
 * survives inside the string).
 */
function hasMeaningfulAssertion(body: string, original: string): boolean {
  // 1) assert.<method>(...) is always meaningful (operates on runtime values).
  if (/\bassert\s*\.\s*\w+\s*\(/.test(body)) return true;

  // 2) Inspect each `expect(<arg>)` occurrence.
  const expectRe = /\bexpect\s*\(/g;
  let em: RegExpExecArray | null;
  while ((em = expectRe.exec(body)) !== null) {
    const argStart = em.index + em[0].length;
    const arg = readBalancedParenArg(body, argStart);
    if (arg === null) continue;
    const argTrim = arg.trim();
    const argIsLiteral = LITERAL_ARG_RE.test(argTrim);
    if (!argIsLiteral) {
      // expect(<expression>) — meaningful regardless of the matcher.
      return true;
    }
    // expect(<literal>).matcher(<...>) — tautology only if matcher trivially
    // holds for that literal. Read the matcher + its argument.
    const afterArgIdx = argStart + arg.length + 1; // past the closing `)`
    const tail = body.slice(afterArgIdx);
    const matcherMatch = tail.match(/^\s*\.\s*(\w+)\s*\(([^)]*)\)/);
    if (!matcherMatch) {
      // `expect(literal)` with no chained matcher does nothing — treat as not
      // meaningful (it asserts nothing). Continue to other assertions.
      continue;
    }
    const matcher = matcherMatch[1].toLowerCase();
    const matcherArgRaw = matcherMatch[2];
    const matcherArgTrim = matcherArgRaw.trim();
    // The matcher argument's absolute index in `body` (to recover its real text):
    // it begins right after the matcher's opening `(` within the matched substring.
    const matcherArgAbsStart = afterArgIdx + matcherMatch[0].lastIndexOf('(') + 1;

    if (matcher.startsWith('not')) {
      // `.not.<m>` inverts; comparing a literal to itself negated would FAIL, so a
      // `.not` chain on literals is not a no-op tautology — treat as meaningful.
      return true;
    }
    if (matcher === 'tobe' || matcher === 'toequal' || matcher === 'tostrictequal') {
      // tautology iff the two literals are textually identical. For string literals
      // the blanked form loses the contents, so compare REAL text from `original`.
      const lhs = realLiteralText(original, argStart, arg, argTrim);
      const rhs = realLiteralText(original, matcherArgAbsStart, matcherArgRaw, matcherArgTrim);
      if (lhs === rhs) {
        continue; // tautological — not meaningful (e.g. expect('a').toBe('a'))
      }
      return true; // expect(1).toBe(2)-style: a genuine (if trivial) comparison
    }
    if (matcher === 'tobetruthy' || matcher === 'tobedefined') {
      // expect(true).toBeTruthy() / expect(1).toBeDefined() — trivially holds for a
      // truthy literal (non-empty string, non-zero number, literal true).
      if (isTruthyLiteral(original, argStart, arg, argTrim)) continue;
      return true;
    }
    if (matcher === 'tobefalsy') {
      if (argTrim === 'false' || argTrim === 'null' || argTrim === 'undefined' || argTrim === 'NaN') {
        continue;
      }
      return true;
    }
    if (ALWAYS_TRUE_MATCHERS.has(matcher)) {
      // Recognized always-true matcher on a literal but not matched above — be
      // conservative and treat as meaningful to avoid false positives.
      return true;
    }
    // Unknown matcher on a literal (e.g. toContain, toBeGreaterThan): the matcher
    // argument carries the real comparison — treat as meaningful.
    return true;
  }

  // 3) assert(<expr>) — meaningful unless <expr> is a bare literal.
  const assertRe = /\bassert\s*\(/g;
  let am: RegExpExecArray | null;
  while ((am = assertRe.exec(body)) !== null) {
    // Skip `assert.method(` — handled in (1); the `(` right after `assert` is the
    // bare-call form. assert.foo( won't match this regex (a `.` sits between).
    const argStart = am.index + am[0].length;
    const arg = readBalancedParenArg(body, argStart);
    if (arg === null) continue;
    if (!LITERAL_ARG_RE.test(arg.trim())) return true; // assert(<expression>)
    // assert(true) / assert(1) — tautological, not meaningful.
  }

  return false;
}

/**
 * Recover a literal argument's REAL text. For a blanked string literal (its body
 * was spaced-out), read the original source at the same index span (blanking
 * preserves positions). Otherwise the blanked token IS the literal (numbers/
 * keywords are never blanked). `argInBody` is the (possibly blanked) arg text and
 * `argAbsStart` its absolute index in the body slice (which aligns with `original`).
 */
function realLiteralText(
  original: string,
  argAbsStart: number,
  argInBody: string,
  argTrim: string,
): string {
  if (BLANKED_STRING_RE.test(argTrim)) {
    const real = original.slice(argAbsStart, argAbsStart + argInBody.length);
    return real.trim();
  }
  return argTrim;
}

/** True when a literal arg is truthy (literal true, non-zero number, non-empty string). */
function isTruthyLiteral(
  original: string,
  argAbsStart: number,
  argInBody: string,
  argTrim: string,
): boolean {
  if (argTrim === 'true') return true;
  if (/^-?\d+(?:\.\d+)?$/.test(argTrim)) return Number(argTrim) !== 0;
  if (BLANKED_STRING_RE.test(argTrim)) {
    const real = realLiteralText(original, argAbsStart, argInBody, argTrim);
    // Non-empty string literal (more than just the two quotes) is truthy.
    return real.length > 2;
  }
  return false;
}

/**
 * Read a single balanced `(...)`-argument starting at `start` (the index just
 * AFTER the opening `(`). Returns the inner text (without the outer parens), or
 * null if unbalanced. Handles nested parens; strings are already blanked.
 */
function readBalancedParenArg(s: string, start: number): string | null {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return s.slice(start, i);
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan one test file's SOURCE and return findings for every stub or hollow test.
 *
 * Deterministic + Tier-0: pure function of (path, source); identical input always
 * yields identical output; no IO. `path` is echoed verbatim onto each finding so
 * callers needn't re-thread it.
 */
export function scanTestSource(path: string, source: string): TestFinding[] {
  // Fully blanked (comments AND strings) — for assertion / token detection where an
  // assertion *mentioned* in a string must not count (FR-6 false-positive guard).
  const blanked = blankCommentsAndStrings(source);
  // Comments blanked, STRINGS KEPT — for stub-marker detection, since the canonical
  // `throw new Error('not implemented')` marker lives inside a string.
  const markerSrc = blankCommentsAndStrings(source, true);
  const blocks = findTestBlocks(source, blanked, markerSrc);
  const findings: TestFinding[] = [];

  for (const b of blocks) {
    // 1) Skipped tests are stubs (they never run their assertions).
    const skipped =
      SKIP_BASES.has(b.base) || b.modifiers.some((mod) => SKIP_MODIFIERS.has(mod));
    if (skipped) {
      findings.push({
        file: path,
        line: b.line,
        testName: b.name,
        kind: 'stub',
        reason: 'Test is skipped — it never runs and verifies nothing.',
      });
      continue;
    }

    // 2) No usable callback body at all (e.g. `it.todo('x')`) → stub.
    if (b.body === null) {
      findings.push({
        file: path,
        line: b.line,
        testName: b.name,
        kind: 'stub',
        reason: 'Test has no body — nothing runs.',
      });
      continue;
    }

    // 3) Empty/placeholder body → stub.
    if (b.emptyBody) {
      findings.push({
        file: path,
        line: b.line,
        testName: b.name,
        kind: 'stub',
        reason: 'Test body is empty — a placeholder that verifies nothing.',
      });
      continue;
    }

    // 4) Explicit not-implemented marker → stub. Checked against markerBody
    //    (comments blanked, strings kept) because the canonical marker
    //    `throw new Error('not implemented')` carries its text inside a string.
    if (b.markerBody !== null && NOT_IMPLEMENTED_RE.test(b.markerBody)) {
      findings.push({
        file: path,
        line: b.line,
        testName: b.name,
        kind: 'stub',
        reason: "Test body is a 'not implemented' placeholder.",
      });
      continue;
    }

    // 5) Hollow: runs, but no MEANINGFUL assertion (#130). Either no
    //    expect/assert at all, or only tautological / always-true assertions.
    if (!hasMeaningfulAssertion(b.body, b.originalBody ?? b.body)) {
      const hasAnyAssertion = ANY_ASSERTION_RE.test(b.body);
      findings.push({
        file: path,
        line: b.line,
        testName: b.name,
        kind: 'hollow',
        reason: hasAnyAssertion
          ? 'Test has only tautological/always-true assertions (e.g. expect(true).toBe(true)) — it can never fail.'
          : 'Test makes no assertion (no expect/assert) — it is assertion-free and verifies nothing.',
      });
      continue;
    }
  }

  return findings;
}
