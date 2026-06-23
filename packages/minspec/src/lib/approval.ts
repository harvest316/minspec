/**
 * Spec Approval State — DR-012
 *
 * Approval is an explicit human act, recorded as a content hash of the spec
 * file. Editing the spec changes the hash → the approval auto-invalidates
 * ("stale"), forcing re-review.
 *
 * The hash binds the spec's *contract* (#252). v1 records hashed the raw file
 * bytes (sha256sum parity); that cried wolf — a directory rename's internal-ref
 * renumbering (#83) or a `status:` lifecycle flip mutated the bytes and falsely
 * invalidated a human approval. v2 records hash a NORMALIZED form
 * ({@link normalizeSpecContent}) that excludes those volatile/mechanical bytes.
 * The normalization MUST stay byte-identical to `scripts/hooks/spec-gate.py`
 * (`normalize()`), so the bash/python edit-gate and this module agree exactly.
 *
 * State lives in `.minspec/approvals.json`:
 *   { "SPEC-007": { "specHash": "ab12…", "approvedAt": "2026-05-30T…", "tier": "T3", "hashVersion": 2 } }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Tier } from './config';

export type ApprovalStatus = 'approved' | 'stale' | 'unapproved';

/**
 * Approval-hash format version (#252).
 *  - v1 (absent): `specHash` is sha256 of the raw file bytes (sha256sum parity).
 *  - v2: `specHash` is sha256 of the *normalized contract* (see
 *    {@link normalizeSpecContent}) — volatile/mechanical bytes excluded.
 * Old v1 records keep raw comparison (no mass re-staling on upgrade); new
 * approvals are written at the current version.
 */
export type HashVersion = 1 | 2;
export const CURRENT_HASH_VERSION: HashVersion = 2;

export interface ApprovalRecord {
  readonly specHash: string;
  readonly approvedAt: string;
  readonly tier: Tier;
  /** Absent ⇒ 1 (raw bytes). See {@link HashVersion}. */
  readonly hashVersion?: HashVersion;
}

export interface ApprovalStore {
  [specId: string]: ApprovalRecord;
}

const APPROVALS_FILE = 'approvals.json';

function approvalsPath(rootDir: string): string {
  return path.join(rootDir, '.minspec', APPROVALS_FILE);
}

/** sha256 hex of raw bytes. Accepts a Buffer or string. Matches `sha256sum`. */
export function hashContent(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Hash a spec file by its raw bytes (v1). Returns null if unreadable. */
export function hashSpecFile(filePath: string): string | null {
  try {
    return hashContent(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Normalize spec content before hashing (#252). Approval binds the *contract*,
 * not volatile/mechanical bytes. Two exclusions:
 *  1. The lifecycle `status:` frontmatter line — written by the approve flow /
 *     `setSpecStatus` and independently validated by the spec-validator; it is
 *     not part of the contract a human reviews. (Excluding it also retires the
 *     fragile flip-then-hash ordering dance — a status flip no longer perturbs
 *     the hash.)
 *  2. Relative-link URLs (`./…` / `../…`) — automated directory renumbering
 *     (#83) rewrites sibling-spec link *paths* without changing what is
 *     referenced. Link *text* is preserved, so changing the referenced spec is
 *     still caught.
 *
 * Anything excluded here is gated elsewhere (status by the validator; link text
 * stays hashed), so this does not open a hole where a substantive edit hides.
 *
 * MUST stay byte-identical to `scripts/hooks/spec-gate.py::normalize` — the two
 * regexes below are intentionally trivial so both languages reproduce them
 * exactly. A parity test pins this (`approval.test.ts`).
 */
export function normalizeSpecContent(text: string): string {
  return text
    .replace(/^status:.*\r?\n/gm, '')
    .replace(/\]\(\.{1,2}\/[^)]*\)/g, '](RELLINK)');
}

/** Hash a spec file's normalized contract (v2). Returns null if unreadable. */
export function hashSpecFileNormalized(filePath: string): string | null {
  try {
    return hashContent(normalizeSpecContent(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

/** Hash a spec file at the given format version (v1 raw, v2 normalized). */
export function hashSpecFileAt(filePath: string, version: HashVersion): string | null {
  return version >= 2 ? hashSpecFileNormalized(filePath) : hashSpecFile(filePath);
}

export function loadApprovals(rootDir: string): ApprovalStore {
  const p = approvalsPath(rootDir);
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Shallow shape validation — drop malformed records rather than throw.
    const store: ApprovalStore = {};
    for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        rec && typeof rec === 'object' &&
        typeof (rec as ApprovalRecord).specHash === 'string' &&
        typeof (rec as ApprovalRecord).approvedAt === 'string'
      ) {
        // Preserve hashVersion only when it is a recognized value; an absent or
        // junk version reads as v1 (raw) via the `?? 1` fallbacks downstream.
        const v = (rec as ApprovalRecord).hashVersion;
        store[id] =
          v === 2 || v === 1 ? (rec as ApprovalRecord) : ({ ...(rec as ApprovalRecord), hashVersion: undefined } as ApprovalRecord);
      }
    }
    return store;
  } catch {
    return {};
  }
}

export function saveApprovals(rootDir: string, store: ApprovalStore): void {
  const dir = path.join(rootDir, '.minspec');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(approvalsPath(rootDir), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Resolve approval status for a spec given its current on-disk content.
 * Pure given (record, currentHash) — exported for direct unit testing.
 */
export function resolveStatus(
  record: ApprovalRecord | undefined,
  currentHash: string | null,
): ApprovalStatus {
  if (!record) return 'unapproved';
  if (currentHash === null) return 'unapproved';
  return record.specHash === currentHash ? 'approved' : 'stale';
}

/** Read approval status for a spec from disk. */
export function getApprovalStatus(
  rootDir: string,
  specId: string,
  specFilePath: string,
): ApprovalStatus {
  const store = loadApprovals(rootDir);
  const record = store[specId];
  if (!record) return 'unapproved';
  // Hash the current file at the record's own format version, so v1 records keep
  // raw comparison (no false stale after upgrade) and v2 records compare the
  // normalized contract (#252).
  const currentHash = hashSpecFileAt(specFilePath, record.hashVersion ?? 1);
  return resolveStatus(record, currentHash);
}

/**
 * Record an approval binding the current file hash. Returns the new record.
 * `now` is injectable for deterministic tests.
 */
export function approveSpec(
  rootDir: string,
  specId: string,
  specFilePath: string,
  tier: Tier,
  now: () => Date = () => new Date(),
): ApprovalRecord {
  const specHash = hashSpecFileNormalized(specFilePath);
  if (specHash === null) {
    throw new Error(`Cannot read spec file to approve: ${specFilePath}`);
  }
  const record: ApprovalRecord = {
    specHash,
    approvedAt: now().toISOString(),
    tier,
    hashVersion: CURRENT_HASH_VERSION,
  };
  const store = loadApprovals(rootDir);
  store[specId] = record;
  saveApprovals(rootDir, store);
  return record;
}

/** Remove an approval. Returns true if one existed. */
export function revokeApproval(rootDir: string, specId: string): boolean {
  const store = loadApprovals(rootDir);
  if (!(specId in store)) return false;
  delete store[specId];
  saveApprovals(rootDir, store);
  return true;
}
