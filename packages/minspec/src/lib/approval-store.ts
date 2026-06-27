/**
 * Path-keyed approval sidecar store — SPEC-022 / DR-034 (FR-1).
 *
 * Replaces the gitignored, id-keyed `.minspec/approvals.json` map with one
 * COMMITTED sidecar file per spec, keyed by the spec's repo-relative path:
 *
 *   .minspec/approvals/specs/minspec/SPEC-007-foo/requirements.md.json
 *
 * One file per spec means a merge conflict arises only when two devs approve the
 * SAME spec (a genuine conflict), never when they approve different specs. The
 * key is the spec's repo-relative POSIX path — inherently unique (INV-5), so it
 * sidesteps the cross-product SPEC-id collision (#58) within the approval
 * keyspace without depending on the broader id-policy fix.
 *
 * Tier-0: `fs` + `path` only. No `vscode`, no network. Owns the on-disk shape;
 * `approval.ts` delegates its read/write to this module and computes the
 * canonical hash via `@aiclarity/shared`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ApprovalRecord } from './approval';
import type { Tier } from './config';

const APPROVALS_DIR = '.minspec/approvals';

/**
 * POSIX-normalize a repo-relative spec path so Windows (`\`) and POSIX (`/`)
 * produce the same sidecar key (INV-5: the key is a function of the path alone).
 *
 * Converts BOTH the platform separator and a literal backslash to `/`. The latter
 * is what makes the key genuinely platform-independent: a `path.relative` on
 * Windows yields `\`, but on a POSIX runner `path.sep` is `/`, so splitting on
 * `path.sep` alone would leave a Windows-shaped input untouched. A backslash is
 * never a legitimate path char in our spec keys, so normalizing it is safe.
 */
export function toPosixRel(specRelPath: string): string {
  return specRelPath.split(path.sep).join('/').split('\\').join('/').replace(/^\.\//, '');
}

/**
 * The sidecar file path for a spec. Pure function of (rootDir, repo-relative spec
 * path): `<rootDir>/.minspec/approvals/<posix-rel>.json`. Two distinct spec paths
 * yield two distinct sidecars; the same spec path always yields the same sidecar.
 */
export function sidecarPath(rootDir: string, specRelPath: string): string {
  const posix = toPosixRel(specRelPath);
  return path.join(rootDir, ...APPROVALS_DIR.split('/'), ...posix.split('/')) + '.json';
}

/**
 * Shallow shape-validation — drop a malformed sidecar rather than throw. A record
 * must carry the FR-2 fields with the right primitive types; a partial/garbage
 * file is treated as "no record" (so the spec reads unapproved, fail-safe).
 *
 * SPEC-017 back-compat (AC-1, Costly #1): `baselineBlob` and `reviewStart` are
 * validated as `string | undefined` — NEVER required-string. Legacy records
 * (pre-SPEC-017) lack `baselineBlob`; a required-string check here would silently
 * drop every existing approval (the gate would flag every approved spec as
 * unapproved). Instead: absent is VALID, present must be string. `readRecord`
 * normalizes absent → '' so the required-string type holds in memory (see below).
 */
function isValidRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.specPath === 'string' &&
    typeof r.specHash === 'string' &&
    typeof r.approvedAt === 'string' &&
    typeof r.approvedBy === 'string' &&
    typeof r.tier === 'string' &&
    typeof r.migrated === 'boolean' &&
    // back-compat: legacy records predate baselineBlob → absent is valid (no M1
    // datapoint), present must be a string. NEVER required, or legacy approvals drop.
    (r.baselineBlob === undefined || typeof r.baselineBlob === 'string') &&
    // M3-reserved placeholder: optional, present must be a string.
    (r.reviewStart === undefined || typeof r.reviewStart === 'string')
  );
}

/**
 * Normalize a validated on-disk object to a type-safe in-memory ApprovalRecord.
 *
 * SPEC-017 normalization: `baselineBlob` absent on disk (legacy pre-SPEC-017
 * record) is normalized to `''` so the required-string type always holds in
 * memory. `readRecord` and `listRecords` both call this after `isValidRecord`.
 */
function normalizeRecord(v: unknown): ApprovalRecord {
  const r = v as Record<string, unknown>;
  const base = {
    specPath: r.specPath as string,
    specHash: r.specHash as string,
    approvedAt: r.approvedAt as string,
    approvedBy: r.approvedBy as string,
    tier: r.tier as Tier,
    migrated: r.migrated as boolean,
    baselineBlob: typeof r.baselineBlob === 'string' ? r.baselineBlob : '',
  };
  if (typeof r.reviewStart === 'string') {
    return { ...base, reviewStart: r.reviewStart };
  }
  return base;
}

/**
 * Read the sidecar record for a spec, or undefined if absent/malformed.
 *
 * SPEC-017 normalization (AC-1 back-compat): if the on-disk record lacks
 * `baselineBlob` (legacy pre-SPEC-017 shape), it is normalized to `''` in memory
 * so the required-string type `ApprovalRecord.baselineBlob` always holds. This
 * keeps `readRecord`'s return type honest (no type lie) while preserving every
 * legacy approval as a valid, readable record. `reviewStart` is left as-is
 * (undefined when absent, which is correct for the optional field).
 */
export function readRecord(rootDir: string, specRelPath: string): ApprovalRecord | undefined {
  const p = sidecarPath(rootDir, specRelPath);
  if (!fs.existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    return isValidRecord(parsed) ? normalizeRecord(parsed) : undefined;
  } catch {
    return undefined;
  }
}

/** Write one sidecar (mkdir -p its nested dir). Pretty-printed + trailing newline. */
export function writeRecord(rootDir: string, rec: ApprovalRecord): void {
  const p = sidecarPath(rootDir, rec.specPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n', 'utf-8');
}

/** Unlink one sidecar. Returns true if one existed. */
export function removeRecord(rootDir: string, specRelPath: string): boolean {
  const p = sidecarPath(rootDir, specRelPath);
  if (!fs.existsSync(p)) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Walk `.minspec/approvals/` recursively and return every valid `.json` record. */
export function listRecords(rootDir: string): ApprovalRecord[] {
  const base = path.join(rootDir, ...APPROVALS_DIR.split('/'));
  const out: ApprovalRecord[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as unknown;
          if (isValidRecord(parsed)) out.push(normalizeRecord(parsed));
        } catch {
          // skip malformed
        }
      }
    }
  };
  walk(base);
  return out;
}
