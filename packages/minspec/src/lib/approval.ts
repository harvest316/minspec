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

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { specHash } from '@aiclarity/shared';
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
 */
export function approveSpec(
  rootDir: string,
  specFilePath: string,
  tier: Tier,
  email: string,
  now: () => Date = () => new Date(),
): ApprovalRecord {
  const hash = canonicalSpecHash(specFilePath);
  if (hash === null) {
    throw new Error(`Cannot read spec file to approve: ${specFilePath}`);
  }
  const record: ApprovalRecord = {
    specPath: specRelPath(rootDir, specFilePath),
    specHash: hash,
    approvedAt: now().toISOString(),
    approvedBy: email,
    tier,
    migrated: false,
    baselineBlob: '', // Slice 3 will replace '' with the real mintBaseline() result.
    // reviewStart omitted — reserved for M3 (FR-7); JSON.stringify drops undefined.
  };
  writeRecord(rootDir, record);
  return record;
}

/** Remove a spec's approval sidecar. Returns true if one existed. */
export function revokeApproval(rootDir: string, specFilePath: string): boolean {
  return removeRecord(rootDir, specRelPath(rootDir, specFilePath));
}
