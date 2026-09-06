/**
 * dr-id-collision.ts — PURE decision logic for DR-id uniqueness (#1226).
 *
 * ## The defect this exists to close
 *
 * `nextAdrNumber` (packages/minspec/src/lib/adr-manager.ts:103) hands out
 * `max(existing DR-NNN) + 1` computed against the LOCAL checkout. That is correct
 * in isolation and unique only if DR creation is serialised through `main` —
 * which concurrent worktree sessions (#168, the normal working mode here) break
 * by design. Two sessions branching from the same `main` both compute the same
 * number, each correctly, and neither can see the other.
 *
 * Nothing then rejected the duplicate. `validateDrSequence` reports a `duplicate`
 * kind, but (a) only as a WARN, and (b) only for two FILE NAMES sharing a number —
 * it never reads the frontmatter `id:`, so a `DR-079.md` declaring `id: DR-077`
 * was invisible to every gate in the repo. And a blocked PR's number DECAYS: while
 * #1209 waited on a quota-blocked review it was renumbered twice in one day, and
 * ended up colliding with an ACCEPTED, MERGED DR-077 — merging it unchanged would
 * have overwritten an accepted decision record.
 *
 * ## Two halves, one definition of "the id"
 *
 *   A. `checkDeclaredDrIds` — offline, Tier-0, runs in the validator. Two decision
 *      files declaring one `id:` is a defect; so is a file whose declared `id:`
 *      disagrees with its own filename.
 *
 *   B. `decideDrIdCollision` — decides whether the ids a PR ADDS are free, against
 *      the base branch and every other open PR, and names the next free id.
 *
 * Half B keys on FILENAMES, because a PR's frontmatter is not cheaply readable
 * across every open PR (one content fetch per file per PR), whereas the file list
 * is one call. Half A's `id-filename-mismatch` rule is what makes that sound: if a
 * file could declare an id its name does not carry, it would walk straight past
 * half B. The two rules are a pair — do not drop one without the other.
 *
 * ## Purity
 *
 * No `fs`, no network, no `vscode`. Every function here is total and deterministic:
 * same input, same output, same order. The IO lives in the callers —
 * `scripts/validate-frontmatter.ts` (reads the decisions dir) and
 * `scripts/check-dr-id-collision.ts` (shells out to `gh`) — so the decisions can be
 * tested by CALLING them rather than by grepping a workflow for its own text, which
 * passes while inert.
 *
 * Nothing here is imported by `packages/` — the extension stays offline and
 * Tier-0 (constitution invariant 1); the cross-PR awareness lives only in CI.
 */

/** Minimum zero-pad width for a canonical DR id. Mirrors adr-manager's ADR_MIN_PAD_WIDTH. */
export const DR_ID_PAD_WIDTH = 3;

/** A DR id as written in frontmatter or a filename: `DR-` + digits. */
const DR_ID_RE = /^DR-(\d+)$/;

/** A decision FILE: `DR-` + digits, optional descriptor, `.md`. Mirrors adr-manager's ADR_FILE_RE. */
const DR_FILE_RE = /^DR-(\d+).*\.md$/;

/** The leading YAML frontmatter block. Mirrors adr-manager's FRONTMATTER_RE. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** PR file statuses that INTRODUCE a path. `modified` does not: that file already exists on base. */
const CLAIMING_STATUSES = new Set(['added', 'renamed', 'copied']);

/** Canonical, zero-padded id for a DR number: `1` → `DR-001`, `1234` → `DR-1234`. */
export function formatDrId(num: number): string {
  return `DR-${String(num).padStart(DR_ID_PAD_WIDTH, '0')}`;
}

/**
 * The DR number an id string denotes, or `undefined` if it is not a DR id.
 * `DR-77` and `DR-077` both denote 77 — padding is spelling, not identity, so two
 * files spelling one number differently must still collide.
 */
export function drNumberFromId(id: string): number | undefined {
  const match = id.trim().match(DR_ID_RE);
  if (!match) return undefined;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * The DR number a file path denotes, or `undefined` for a non-decision file.
 * Only the basename is read, so the caller decides which directory is in scope.
 * `INDEX.md`, `README.md` and anything not matching `DR-NNN*.md` return undefined.
 */
export function drNumberFromPath(filePath: string): number | undefined {
  const base = filePath.split('/').pop() ?? '';
  const match = base.match(DR_FILE_RE);
  if (!match) return undefined;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * The verbatim `id:` value declared in a document's leading frontmatter block, or
 * `undefined` when there is no frontmatter or no `id:` in it. Deliberately reads
 * ONLY the leading block, so a body line that merely looks like `id: DR-077` is
 * never mistaken for a declaration.
 */
export function declaredIdFromContent(content: string): string | undefined {
  const fm = content.match(FRONTMATTER_RE);
  if (!fm) return undefined;
  for (const line of fm[1].split('\n')) {
    const match = line.match(/^id:\s*(.*)$/);
    if (match) {
      const value = match[1].trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

// ─── A. Local, offline duplicate-id check ────────────────────────────────────

/** One decision file's path and full text. */
export interface DrFile {
  /** Path as it should be reported — repo-relative for a legible CI/validator message. */
  file: string;
  content: string;
}

export type DrIdDefectKind = 'duplicate-id' | 'id-filename-mismatch';

export interface DrIdDefect {
  kind: DrIdDefectKind;
  /** Canonical id at issue, e.g. `DR-077`. */
  id: string;
  /** Files involved, sorted. */
  files: string[];
  message: string;
}

/**
 * Find decision files that collide on a DR id, or whose declared id disagrees with
 * their filename.
 *
 * A file's id is its frontmatter `id:` when present, else the id in its filename —
 * exactly how `listAdrs` (adr-manager.ts) resolves a decision's identity, so this
 * gate and the extension agree on what a DR is called. Pre-MinSpec DRs carry no
 * frontmatter and are NOT a defect on that account; they still hold their filename
 * id against a duplicate.
 *
 * Non-decision files (`INDEX.md`, `README.md`, notes) are ignored entirely.
 *
 * Determinism: defects are sorted by id, then kind (`duplicate-id` before
 * `id-filename-mismatch`), then by the first file path.
 */
export function checkDeclaredDrIds(files: DrFile[]): DrIdDefect[] {
  const defects: DrIdDefect[] = [];
  /** canonical id → files claiming it */
  const byId = new Map<string, string[]>();

  for (const { file, content } of files) {
    const fromPath = drNumberFromPath(file);
    if (fromPath === undefined) continue; // not a decision file

    const declared = declaredIdFromContent(content);
    const declaredNum = declared === undefined ? undefined : drNumberFromId(declared);

    // A declared id that is not a DR id at all (`id: SPEC-004`, `id: 77`) is as
    // wrong as one naming a different number, and is reported the same way — the
    // filename is the only representation half B can see, so they must agree.
    if (declared !== undefined && declaredNum !== fromPath) {
      defects.push({
        kind: 'id-filename-mismatch',
        id: formatDrId(fromPath),
        files: [file],
        message:
          `${file} declares \`id: ${declared}\` but its filename says ` +
          `${formatDrId(fromPath)}. The cross-PR uniqueness check reads FILENAMES ` +
          `(a PR's frontmatter is not readable across every open PR), so an id that ` +
          `disagrees with its own filename escapes it. Make the two match.`,
      });
    }

    const canonical = formatDrId(declaredNum ?? fromPath);
    byId.set(canonical, [...(byId.get(canonical) ?? []), file]);
  }

  for (const [id, claimants] of byId) {
    if (claimants.length < 2) continue;
    const sorted = [...claimants].sort();
    defects.push({
      kind: 'duplicate-id',
      id,
      files: sorted,
      message:
        `${id} is claimed by ${sorted.length} decision files (${sorted.join(', ')}). ` +
        `A DR id is the register's primary key — two records under one id means one ` +
        `of them cannot be cited, and an accepted decision can be overwritten. ` +
        `Renumber all but the earliest claim.`,
    });
  }

  const kindOrder: Record<DrIdDefectKind, number> = {
    'duplicate-id': 0,
    'id-filename-mismatch': 1,
  };
  return defects.sort(
    (a, b) =>
      a.id.localeCompare(b.id) ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      (a.files[0] ?? '').localeCompare(b.files[0] ?? ''),
  );
}

// ─── B. Cross-PR decision seam ───────────────────────────────────────────────

/** One entry from GitHub's `pulls/:n/files` payload (only the fields this gate reads). */
export interface PrFileEntry {
  filename: string;
  status: string;
  previous_filename?: string;
}

/**
 * The decision-dir paths a PR INTRODUCES, sorted.
 *
 * `added` / `renamed` / `copied` introduce a path; `modified` / `removed` /
 * `unchanged` do not — a modified DR already exists on the base branch, so editing
 * it is not a claim on its id. For a rename, `filename` is the NEW name, which is
 * exactly the claim being made.
 */
export function claimedPathsFromPrFiles(entries: PrFileEntry[], decisionsDir: string): string[] {
  const prefix = decisionsDir.replace(/\/+$/, '') + '/';
  return entries
    .filter((e) => CLAIMING_STATUSES.has(e.status))
    .map((e) => e.filename)
    .filter((f) => f.startsWith(prefix) && drNumberFromPath(f) !== undefined)
    .sort();
}

/** The decision-dir paths one pull request adds. */
export interface PrClaims {
  pr: number;
  paths: string[];
}

export interface DrIdCollisionInput {
  /** Repo-relative decisions dir, e.g. `docs/decisions`. */
  decisionsDir: string;
  /** Name of the base branch, used in the message (`main`). */
  baseRef: string;
  /** Every path in the decisions dir on the base branch's CURRENT tip (not the merge base). */
  basePaths: string[];
  /** The PR under test. */
  subject: PrClaims;
  /** Every OTHER open PR and the decision paths it adds. May include the subject; it is filtered. */
  otherPrs: PrClaims[];
}

export interface DrIdCollisionFinding {
  /** Canonical id, e.g. `DR-077`. */
  id: string;
  /** Who already holds it: the base ref name, `PR #NNNN`, or `this PR`. */
  heldBy: string;
  /** The holder's path (or the subject's own second path, for an intra-PR duplicate). */
  file: string;
}

export interface DrIdCollisionVerdict {
  ok: boolean;
  /** Canonical ids this PR adds, sorted. */
  claimed: string[];
  findings: DrIdCollisionFinding[];
  /** `max(base ∪ every open PR ∪ this PR) + 1`, canonical. */
  nextFreeId: string;
  /** Ready to print. Names the next free id whenever there is a collision. */
  message: string;
}

/**
 * Decide whether the DR ids a PR adds are free.
 *
 * Deliberately compares against the base branch's CURRENT TIP rather than the PR's
 * merge base: the failure being closed is precisely that a blocked PR's number
 * decays as other DRs land, and a merge-base comparison would call that "fine"
 * right up until the merge conflicts.
 *
 * `nextFreeId` is the max over EVERYTHING in flight plus one — base, every open PR,
 * and the subject itself — so the renumber it recommends does not land straight in
 * the next collision. It is computed unconditionally (also reported on a pass) so
 * the same number is available to a human reading a green run.
 *
 * Total and deterministic. A PR that adds no decision file passes: this check runs
 * on every PR so it stays satisfiable as a required check (a `paths:` filter would
 * make it unsatisfiable on every non-decision PR — the #560 silent-gate class,
 * DR-066).
 */
export function decideDrIdCollision(input: DrIdCollisionInput): DrIdCollisionVerdict {
  const { baseRef, basePaths, subject } = input;
  const otherPrs = input.otherPrs.filter((p) => p.pr !== subject.pr);

  /** canonical id → the first holder that is NOT the subject */
  const held = new Map<string, { heldBy: string; file: string }>();
  const allNumbers: number[] = [];

  const claim = (paths: string[], heldBy: string): void => {
    for (const file of [...paths].sort()) {
      const num = drNumberFromPath(file);
      if (num === undefined) continue;
      allNumbers.push(num);
      const id = formatDrId(num);
      if (!held.has(id)) held.set(id, { heldBy, file });
    }
  };

  // Base first, so `main` is named as the holder when both main and another PR
  // hold an id — the more actionable of the two (the accepted record is on main).
  claim(basePaths, baseRef);
  for (const pr of [...otherPrs].sort((a, b) => a.pr - b.pr)) {
    claim(pr.paths, `PR #${pr.pr}`);
  }

  const findings: DrIdCollisionFinding[] = [];
  const claimed: string[] = [];
  /** ids the subject has already claimed once, for intra-PR duplicate detection */
  const seenInSubject = new Map<string, string>();

  for (const file of [...subject.paths].sort()) {
    const num = drNumberFromPath(file);
    if (num === undefined) continue;
    allNumbers.push(num);
    const id = formatDrId(num);
    if (!claimed.includes(id)) claimed.push(id);

    const holder = held.get(id);
    if (holder) {
      findings.push({ id, heldBy: holder.heldBy, file: holder.file });
      continue;
    }
    const twin = seenInSubject.get(id);
    if (twin !== undefined) {
      findings.push({ id, heldBy: 'this PR', file });
    } else {
      seenInSubject.set(id, file);
    }
  }

  // Dedupe: a subject that claims one id under TWO filenames while the base also
  // holds it hits the `held` branch twice and would otherwise print the same holder
  // line twice. The collision is one fact, so report it once.
  const seenFinding = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.id}\x00${f.heldBy}\x00${f.file}`;
    if (seenFinding.has(key)) return false;
    seenFinding.add(key);
    return true;
  });
  unique.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
  findings.length = 0;
  findings.push(...unique);
  claimed.sort();

  const nextFreeId = formatDrId(allNumbers.length === 0 ? 1 : Math.max(...allNumbers) + 1);
  const ok = findings.length === 0;

  return { ok, claimed, findings, nextFreeId, message: renderMessage(input, { ok, claimed, findings, nextFreeId }) };
}

/**
 * Render the verdict. On a failure this MUST name the next free id — the whole
 * point of the gate is that the fix is one rename with no guesswork, and the
 * previous state of the world (a human eyeballing `max+1` in a stale checkout) is
 * exactly what produced two renumbers of #1209 in one day.
 */
function renderMessage(
  input: DrIdCollisionInput,
  v: Pick<DrIdCollisionVerdict, 'ok' | 'claimed' | 'findings' | 'nextFreeId'>,
): string {
  if (v.ok) {
    return v.claimed.length === 0
      ? `DR id check: this PR adds no decision record. Nothing to collide. (Next free id: ${v.nextFreeId}.)`
      : `DR id check: ${v.claimed.join(', ')} ${v.claimed.length === 1 ? 'is' : 'are'} free ` +
          `on ${input.baseRef} and across every open PR. (Next free id: ${v.nextFreeId}.)`;
  }

  const lines = v.findings.map(
    (f) => `  • ${f.id} is already claimed by ${f.heldBy} (${f.file})`,
  );
  const plural = v.findings.length === 1 ? 'id is' : 'ids are';

  return [
    `DR id collision — ${v.findings.length} ${plural} already taken:`,
    ...lines,
    '',
    `Next free id: ${v.nextFreeId} — the max across ${input.baseRef} AND every open PR, plus one.`,
    `Renumber this PR's decision to ${v.nextFreeId}:`,
    `  1. git mv ${input.decisionsDir}/<file> ${input.decisionsDir}/${v.nextFreeId}.md`,
    `  2. update \`id:\` in its frontmatter to ${v.nextFreeId}`,
    '  3. regenerate the register index (MinSpec: Regenerate DR INDEX)',
    '  4. update the PR title and any prose references',
    '',
    'Why this is fatal rather than a warning: a DR id is the register\'s primary key.',
    'Two records under one id means one of them cannot be cited, and merging over an',
    'already-accepted decision overwrites it silently (#1226).',
  ].join('\n');
}
