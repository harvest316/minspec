/**
 * Spec Approval State — DR-012, amended by SPEC-022 / DR-034.
 *
 * Approval is an explicit human act, recorded as a CANONICAL content hash of the
 * spec (FR-3, `@aiclarity/shared` specHash) — NOT raw file bytes. The canonical
 * hash excludes the lifecycle fields (`status`/`phases`), so the tool's own
 * status flips and deterministic lifecycle transitions no longer void approval;
 * editing the body or any other frontmatter field still does (re-review).
 *
 * Ground truth is COMMITTED and path-keyed (FR-1): one sidecar per spec under
 * `.minspec/approvals/<repo-relative-spec-path>.json`, owned by `approval-store.ts`.
 * Records are ATTRIBUTED (FR-2): they carry who approved (`approvedBy` =
 * `git config user.email`, captured offline at approval time — Tier-0, no network).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { execFileSync } from 'child_process';
import { specHash, getSpecBodyOnly } from '@aiclarity/shared';
import type { Tier } from './config';
import {
  readRecord,
  writeRecord,
  removeRecord,
  toPosixRel,
} from './approval-store';

export type ApprovalStatus = 'approved' | 'stale' | 'unapproved';

/**
 * The FR-2 attributed approval record — the on-disk sidecar shape.
 *
 * `migrated` is `true` only for FR-5 backfilled records (an approval the human
 * never performed, flagged so the gate treats it valid-but-flagged — "re-approve
 * to clear"). A `migrated:true` record still resolves to `approved` for the
 * derive (non-blocking, warn-first), but carries its honest provenance.
 *
 * SPEC-017 adds two fields:
 *   `baselineBlob`  — FR-1 baseline pointer. One of THREE closed forms, frozen
 *                     forever (committed): a 40-hex git blob SHA | the literal
 *                     string 'gzip:fallback' (GZIP_MARKER) | '' (both mint paths
 *                     failed → no M1 datapoint). On-disk back-compat: absent in
 *                     legacy records (pre-SPEC-017) — `readRecord` normalizes
 *                     absent → '' so this required-string always holds in memory.
 *                     NEVER use a required-string validator or every legacy
 *                     approval silently drops (Costly #1, AC-1 back-compat).
 *   `reviewStart`   — RESERVED for M3 (FR-7, time-to-approve). NOT populated in
 *                     M1. Optional so M3 can backfill without a second migration.
 */
export interface ApprovalRecord {
  readonly specPath: string;       // repo-relative, POSIX, e.g. specs/minspec/SPEC-007-foo/requirements.md
  readonly specHash: string;       // canonical hash (FR-3), hex
  readonly approvedAt: string;     // ISO-8601 UTC
  readonly approvedBy: string;     // git config user.email at approval time
  readonly tier: Tier;
  readonly migrated: boolean;
  readonly baselineBlob: string;   // FR-1: 40-hex SHA | 'gzip:fallback' | '' (see above)
  readonly reviewStart?: string;   // RESERVED for M3 (FR-7) — absent in M1; ISO-8601 UTC when set
}

/** Repo-relative POSIX path for a spec file, the approval store's key. */
export function specRelPath(rootDir: string, specFilePath: string): string {
  return toPosixRel(path.relative(rootDir, specFilePath));
}

// ─── SPEC-017 Slice 3 — Baseline mint / recover (FR-1, DR-043) ──────────────

/**
 * Frozen sentinel for the gzip-fallback baseline form.
 * Non-hex, never empty, stable forever — `recoverBaseline` branches by EXACT
 * equality, so this must never change. The closed set is: 40-hex SHA |
 * 'gzip:fallback' | '' (both paths failed → no M1 datapoint).
 */
export const GZIP_MARKER = 'gzip:fallback';

/**
 * Encode a repo-relative POSIX specPath into a SINGLE, git-legal ref component.
 * Hashing sidesteps git's ref-name grammar (no '..', no '.lock' suffix, no
 * leading '.', no control chars, no trailing '/'), which a legal spec path could
 * otherwise trip — making `update-ref` reject an honest path and strand an
 * unpinned blob for gc to prune.
 */
export function refKey(specPath: string): string {
  return crypto.createHash('sha256').update(specPath).digest('hex');
}

/**
 * Write a gzip-compressed body snapshot to `.minspec/snapshots/<refKey>.json.gz`
 * as the DR-043 per-machine fallback when git blob pinning is unavailable.
 * Returns true on success, false on any error (so mintBaseline can degrade to '').
 */
function writeGzipFallback(rootDir: string, specPath: string, bodyBuf: Buffer): boolean {
  try {
    const dir = path.join(rootDir, '.minspec', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const gz = zlib.gzipSync(bodyBuf);
    fs.writeFileSync(path.join(dir, `${refKey(specPath)}.json.gz`), gz);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint the FR-4 body-only baseline as a pinned git blob (DR-043).
 *
 * Strategy (in order):
 *   1. `git hash-object -w --stdin` → blob SHA (content-addressed, deduped,
 *      dirty-tree-safe).
 *   2. `git update-ref refs/minspec/snapshots/<refKey(specPath)> <sha>` pins the
 *      blob so `git gc` cannot prune it.  Returns the SHA on success.
 *   3. If the pin fails (shouldn't, but defensive) → the blob is unpinned and
 *      gc-prunable; fall through to gzip fallback so nothing is left dangling.
 *   4. If `hash-object` throws (non-git dir, git absent) → gzip fallback.
 *   5. If gzip also fails → return '' (no M1 datapoint, approval still written).
 *
 * A returned 40-hex SHA therefore means "blob written AND pinned by a ref."
 * NEVER returns a SHA whose blob is unpinned.  Tier-0, offline.
 */
export function mintBaseline(rootDir: string, specPath: string, bodyOnly: string): string {
  const buf = Buffer.from(bodyOnly, 'utf-8');
  try {
    // DR-043 pt 1: content-addressed blob (zlib-compressed, deduped; dirty-tree-safe).
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: rootDir,
      input: buf,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    // DR-043 pt 2: pin against gc under a sanitized, always-legal ref name.
    try {
      execFileSync(
        'git',
        ['update-ref', `refs/minspec/snapshots/${refKey(specPath)}`, sha],
        { cwd: rootDir, stdio: 'ignore' },
      );
      return sha; // blob written AND pinned — durable.
    } catch {
      // Pin failed → the blob is unpinned and gc could prune it later.
      // Fall through to a pinned-somewhere fallback rather than return a fragile SHA.
      return writeGzipFallback(rootDir, specPath, buf) ? GZIP_MARKER : '';
    }
  } catch {
    // DR-043 pt 5: non-git (or git absent) → gzip sidecar, per-machine fallback.
    return writeGzipFallback(rootDir, specPath, buf) ? GZIP_MARKER : '';
  }
}

/**
 * Recover the FR-4 body-only baseline from the ledger record.
 *
 * Branches by EXACT equality of `record.baselineBlob`:
 *   ''  or absent → undefined (no datapoint, e.g. legacy record or all-paths-failed)
 *   === GZIP_MARKER → gunzip `.minspec/snapshots/<refKey>.json.gz`; any error → undefined
 *   40-hex SHA → `git cat-file blob <sha>` → body string; any error (including a
 *                gc-pruned blob that outlived the ledger SHA) → undefined, NEVER throw.
 *
 * This function NEVER throws — any error degrades to undefined (INV — Deterministic).
 */
export function recoverBaseline(rootDir: string, record: ApprovalRecord): string | undefined {
  const blob = record.baselineBlob;
  if (!blob || blob === '') return undefined;

  if (blob === GZIP_MARKER) {
    try {
      const gz = fs.readFileSync(
        path.join(rootDir, '.minspec', 'snapshots', `${refKey(record.specPath)}.json.gz`),
      );
      return zlib.gunzipSync(gz).toString('utf-8');
    } catch {
      return undefined;
    }
  }

  // 40-hex SHA → git cat-file blob
  if (/^[0-9a-f]{40}$/i.test(blob)) {
    try {
      return execFileSync('git', ['cat-file', 'blob', blob], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf-8');
    } catch {
      return undefined; // blob gone (gc-pruned or missing) → no datapoint, never throw
    }
  }

  return undefined; // unrecognized form → degrade
}

/**
 * Canonical hash of a spec file's current content (FR-3). Returns null if the
 * file is unreadable. Replaces the old raw-byte `hashSpecFile`.
 */
export function canonicalSpecHash(specFilePath: string): string | null {
  try {
    return specHash(fs.readFileSync(specFilePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Capture the approver's identity offline (Tier-0, no network) — `git config
 * user.email` at approval time. An empty/missing value degrades to `'unknown'`;
 * never throws, so an approval is never blocked on git config (AC-3).
 */
export function gitConfigEmail(rootDir: string): string {
  try {
    return (
      execFileSync('git', ['config', 'user.email'], { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve approval status given a record and the spec's current CANONICAL hash.
 * Pure — exported for direct unit testing. A `migrated` record is `approved`
 * (valid-but-flagged) when its hash matches; the `migrated` provenance is carried
 * on the record itself for the gate/validator to surface.
 */
export function resolveStatus(
  record: ApprovalRecord | undefined,
  currentHash: string | null,
): ApprovalStatus {
  if (!record) return 'unapproved';
  if (currentHash === null) return 'unapproved';
  return record.specHash === currentHash ? 'approved' : 'stale';
}

/** Read approval status for a spec from its committed sidecar. */
export function getApprovalStatus(rootDir: string, specFilePath: string): ApprovalStatus {
  const rel = specRelPath(rootDir, specFilePath);
  return resolveStatus(readRecord(rootDir, rel), canonicalSpecHash(specFilePath));
}

/** Read the raw approval record for a spec (or undefined), for callers needing `migrated`. */
export function getApprovalRecord(rootDir: string, specFilePath: string): ApprovalRecord | undefined {
  return readRecord(rootDir, specRelPath(rootDir, specFilePath));
}

/**
 * Record an approval binding the spec's current CANONICAL content hash. Writes a
 * committed, attributed, path-keyed sidecar. Returns the new record.
 *
 * `email` is the captured `git config user.email` (the caller passes
 * `gitConfigEmail(rootDir)`). `now` is injectable for deterministic tests.
 * Path-keyed — the spec `id` is no longer part of the signature.
 *
 * SPEC-017 Slice 3: reads the spec file ONCE; derives both `specHash(raw)` and
 * `bodyOnly = getSpecBodyOnly(raw)` from the SAME in-memory string (no double-read,
 * no TOCTOU skew). Mints the FR-4 body-only baseline AFTER building the record.
 * Approval NEVER fails on a mint error — any git/gzip error degrades; the record
 * is written regardless (INV — Non-destructive, AC-1).
 */
export function approveSpec(
  rootDir: string,
  specFilePath: string,
  tier: Tier,
  email: string,
  now: () => Date = () => new Date(),
): ApprovalRecord {
  // 0. Single read — hash and baseline both derive from THESE bytes (no double-read,
  //    no TOCTOU skew between specHash and baselineBlob).
  let raw: string;
  try {
    raw = fs.readFileSync(specFilePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read spec file to approve: ${specFilePath}`);
  }
  const hash = specHash(raw); // canonical-hash boundary (SPEC-022)

  // 1. FR-4 body-only bytes — NOT the canonical-hash boundary. The baseline diff
  //    measures LLM prose, so frontmatter is excluded ENTIRELY (canonical keeps
  //    frontmatter-minus-lifecycle; see §Why two boundaries in design.md).
  const bodyOnly = getSpecBodyOnly(raw);
  const specPath = specRelPath(rootDir, specFilePath);

  // 2. Mint + pin the baseline (git blob → sanitized ref), gzip fallback if non-git
  //    OR if the ref pin fails — never leave a blob unpinned (gc would prune it).
  //    Any error here degrades to '' (no M1 datapoint); approval is always written.
  const baselineBlob = mintBaseline(rootDir, specPath, bodyOnly);

  const record: ApprovalRecord = {
    specPath,
    specHash: hash,
    approvedAt: now().toISOString(),
    approvedBy: email,
    tier,
    migrated: false,
    baselineBlob, // reviewStart omitted — reserved for M3 (FR-7); JSON.stringify drops undefined.
  };
  writeRecord(rootDir, record);
  return record;
}

/** Remove a spec's approval sidecar. Returns true if one existed. */
export function revokeApproval(rootDir: string, specFilePath: string): boolean {
  return removeRecord(rootDir, specRelPath(rootDir, specFilePath));
}
