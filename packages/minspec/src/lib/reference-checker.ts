/**
 * reference-checker.ts — deterministic dangling-reference checker (Slice-1, #161).
 *
 * The corpus accumulates references that silently rot: a `DR-355` that never
 * existed, a `SPEC-014` `approve.ts:70-100` line citation that drifted, a
 * `../research/…` path that should have been `../../docs/research/…`. None of it
 * is caught by frontmatter validation. This module is the deterministic gate the
 * cross-check report flagged as highest-ROI: it scans a markdown artifact for
 * references — `SPEC-NNN`, `DR-NNN`, `EPIC-NNN`, and `path#Lnn` / `path:nn`
 * file:line citations — and reports any that do not resolve to a real artifact or
 * file.
 *
 * STANDALONE by design: it does NOT import or modify spec-validator.ts (a parallel
 * build owns that file). Tier-0 — pure functions over text + an injected registry;
 * no `vscode`, no network, no filesystem reads of its own (the caller supplies a
 * `fileExists` probe so the checker stays unit-testable and platform-agnostic).
 *
 * Slice-1 deliberately checks *existence* only: a `path#Lnn` citation passes when
 * the file exists; verifying the line still contains the cited symbol is the
 * Slice-2 follow-up (#147). Cross-repo refs are exempted via an explicit
 * `@namespace` convention (e.g. `SPEC-100@scroogellm`) so legitimately-external
 * citations never trip the gate.
 */

/** Kind of reference found in an artifact. */
export type ReferenceKind = 'spec' | 'decision' | 'epic' | 'file';

/** A single reference extracted from artifact text. */
export interface Reference {
  kind: ReferenceKind;
  /** Canonical id for artifact refs (`SPEC-001`, `DR-001`, `EPIC-001`). */
  id?: string;
  /** Repo-relative path for `file` refs. */
  path?: string;
  /** Cited line / line-range token for `file` refs (e.g. `42`, `70-100`). */
  line?: string;
  /**
   * True when the ref carries an explicit external `@namespace` suffix
   * (`SPEC-100@scroogellm`). External refs are exempt from resolution — they
   * live in another repo's register.
   */
  external?: boolean;
}

/** Registry of artifacts/files a reference may resolve against. */
export interface ReferenceRegistry {
  /** Existing spec ids (`SPEC-001`, …). */
  specs: Set<string>;
  /** Existing decision ids (`DR-001`, …). */
  decisions: Set<string>;
  /** Existing epic ids (`EPIC-001`, …). */
  epics: Set<string>;
  /** Probe: does this repo-relative path exist? */
  fileExists: (relPath: string) => boolean;
}

/** A reference that failed to resolve. */
export interface ReferenceViolation {
  ref: Reference;
  message: string;
}

// SPEC-NNN / DR-NNN / EPIC-NNN, optionally suffixed with @namespace for an
// external (cross-repo) ref. Captured groups: 1=kind word, 2=number, 3=namespace.
const ARTIFACT_RE = /\b(SPEC|DR|EPIC)-(\d{1,})(?:@([A-Za-z][\w-]*))?\b/g;

// file:line citations. Two shapes:
//   path#Lnn[-nn]   — markdown anchor style (src/foo.ts#L42, src/foo.ts#L70-L100)
//   path:nn[-nn]    — colon style (scripts/bar.ts:70-100)
// A path is a slash-containing, extension-bearing token so bare words and the
// artifact ids above are never mistaken for file paths. Restrict the path charset
// to typical source-path characters.
const FILE_HASH_RE =
  /\b([\w./-]+\/[\w.-]+\.[A-Za-z][\w]*)#L(\d+(?:-L?\d+)?)/g;
const FILE_COLON_RE =
  /\b([\w./-]+\/[\w.-]+\.[A-Za-z][\w]*):(\d+(?:-\d+)?)\b/g;

const KIND_BY_WORD: Record<string, ReferenceKind> = {
  SPEC: 'spec',
  DR: 'decision',
  EPIC: 'epic',
};

/** Normalize a captured number to its canonical zero-padded id. */
function canonicalId(word: string, num: string): string {
  // Existing corpus ids are 3-digit-padded (SPEC-001, DR-040). Pad numbers
  // shorter than 3 digits; leave longer ones (SPEC-100, DR-1000) untouched.
  const padded = num.length < 3 ? num.padStart(3, '0') : num;
  return `${word}-${padded}`;
}

/**
 * Extract every reference from artifact text.
 *
 * Skips the artifact's OWN defining frontmatter `id:` line — that is a definition,
 * not a citation, so a spec is never treated as referencing itself. De-duplicates
 * by (kind,id,path) in first-seen order.
 */
export function extractReferences(text: string): Reference[] {
  // Drop defining `id:`/`epic:` frontmatter lines so self-definitions and the
  // owning epic declaration aren't mis-read as citations to validate.
  const scrubbed = text
    .split('\n')
    .filter((l) => !/^\s*(id|epic):\s/.test(l))
    .join('\n');

  const out: Reference[] = [];
  const seen = new Set<string>();

  const push = (ref: Reference, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  let m: RegExpExecArray | null;

  ARTIFACT_RE.lastIndex = 0;
  while ((m = ARTIFACT_RE.exec(scrubbed)) !== null) {
    const [, word, num, ns] = m;
    const id = canonicalId(word, num);
    const ref: Reference = { kind: KIND_BY_WORD[word], id };
    if (ns) ref.external = true;
    push(ref, `${ref.kind}:${id}:${ns ?? ''}`);
  }

  FILE_HASH_RE.lastIndex = 0;
  while ((m = FILE_HASH_RE.exec(scrubbed)) !== null) {
    const [, path, line] = m;
    push({ kind: 'file', path, line }, `file:${path}`);
  }

  FILE_COLON_RE.lastIndex = 0;
  while ((m = FILE_COLON_RE.exec(scrubbed)) !== null) {
    const [, path, line] = m;
    push({ kind: 'file', path, line }, `file:${path}`);
  }

  return out;
}

/** Resolve one reference against the registry. Returns a violation or null. */
function resolve(
  ref: Reference,
  registry: ReferenceRegistry,
): ReferenceViolation | null {
  // External (@namespace) refs live in another repo's register — exempt.
  if (ref.external) return null;

  switch (ref.kind) {
    case 'spec':
      return registry.specs.has(ref.id!)
        ? null
        : { ref, message: `dangling SPEC reference: ${ref.id} resolves to no spec` };
    case 'decision':
      return registry.decisions.has(ref.id!)
        ? null
        : { ref, message: `dangling DR reference: ${ref.id} resolves to no decision record` };
    case 'epic':
      return registry.epics.has(ref.id!)
        ? null
        : { ref, message: `dangling EPIC reference: ${ref.id} resolves to no epic` };
    case 'file':
      return registry.fileExists(ref.path!)
        ? null
        : {
            ref,
            message: `dangling file citation: ${ref.path}${
              ref.line ? `:${ref.line}` : ''
            } resolves to no file`,
          };
  }
}

/**
 * Check every reference in `text` against the registry; return the violations.
 * Empty array ⇒ all references resolve (the clean case).
 */
export function checkReferences(
  text: string,
  registry: ReferenceRegistry,
): ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];
  for (const ref of extractReferences(text)) {
    const v = resolve(ref, registry);
    if (v) violations.push(v);
  }
  return violations;
}
