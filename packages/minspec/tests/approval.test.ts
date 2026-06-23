import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  hashContent,
  hashSpecFile,
  hashSpecFileNormalized,
  normalizeSpecContent,
  resolveStatus,
  approveSpec,
  revokeApproval,
  getApprovalStatus,
  loadApprovals,
  saveApprovals,
} from '../src/lib/approval';
import { setSpecStatus, parseSpec } from '../src/lib/spec';

let tmp: string;
let specPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-approval-'));
  fs.mkdirSync(path.join(tmp, 'specs'));
  specPath = path.join(tmp, 'specs', 'SPEC-007-thing.md');
  fs.writeFileSync(specPath, '---\nid: SPEC-007\ntier: T3\n---\n# Thing\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hashContent — matches sha256sum', () => {
  it('Node crypto agrees with the shell sha256sum the gate hook uses', () => {
    const nodeHash = hashSpecFile(specPath);
    let shellHash: string;
    try {
      shellHash = execFileSync('sha256sum', [specPath]).toString().split(/\s+/)[0];
    } catch {
      return; // sha256sum unavailable on this platform — skip cross-check
    }
    expect(nodeHash).toBe(shellHash);
  });

  it('is stable for identical bytes and differs on change', () => {
    const a = hashContent('hello');
    const b = hashContent('hello');
    const c = hashContent('hello!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('resolveStatus — pure', () => {
  it('unapproved when no record', () => {
    expect(resolveStatus(undefined, 'abc')).toBe('unapproved');
  });
  it('approved when hash matches', () => {
    expect(resolveStatus({ specHash: 'abc', approvedAt: 't', tier: 'T3' }, 'abc')).toBe('approved');
  });
  it('stale when hash differs', () => {
    expect(resolveStatus({ specHash: 'abc', approvedAt: 't', tier: 'T3' }, 'xyz')).toBe('stale');
  });
  it('unapproved when file unreadable (null hash)', () => {
    expect(resolveStatus({ specHash: 'abc', approvedAt: 't', tier: 'T3' }, null)).toBe('unapproved');
  });
});

describe('approve / revoke lifecycle', () => {
  it('approveSpec then getApprovalStatus = approved', () => {
    approveSpec(tmp, 'SPEC-007', specPath, 'T3', () => new Date('2026-05-30T00:00:00Z'));
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('approved');
    const store = loadApprovals(tmp);
    expect(store['SPEC-007'].tier).toBe('T3');
    expect(store['SPEC-007'].approvedAt).toBe('2026-05-30T00:00:00.000Z');
  });

  it('editing the spec after approval makes it stale', () => {
    approveSpec(tmp, 'SPEC-007', specPath, 'T3');
    fs.appendFileSync(specPath, '\nmore content\n');
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('stale');
  });

  it('revokeApproval removes the record', () => {
    approveSpec(tmp, 'SPEC-007', specPath, 'T3');
    expect(revokeApproval(tmp, 'SPEC-007')).toBe(true);
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('unapproved');
    expect(revokeApproval(tmp, 'SPEC-007')).toBe(false);
  });

  it('approvals.json survives a malformed file (returns empty)', () => {
    fs.mkdirSync(path.join(tmp, '.minspec'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.minspec', 'approvals.json'), '{ not json');
    expect(loadApprovals(tmp)).toEqual({});
  });
});

// Invariant (T0) — #252. The v2 normalized hash EXCLUDES the `status:` line, so a
// lifecycle flip can never stale a just-approved spec — in EITHER order. This
// supersedes the old flip-then-hash dance (DR-003): order no longer matters.
describe('status flip never stales an approval (v2 — status excluded, #252)', () => {
  const SPECIFYING = '---\nid: SPEC-007\nstatus: specifying\ntier: T3\n---\n# Thing\n';

  beforeEach(() => fs.writeFileSync(specPath, SPECIFYING));

  it('flip-then-hash → status implementing AND approved', () => {
    setSpecStatus(specPath, 'implementing');
    approveSpec(tmp, 'SPEC-007', specPath, 'T3');

    expect(parseSpec(fs.readFileSync(specPath, 'utf-8')).frontmatter.status).toBe('implementing');
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('approved');
  });

  it('hash-then-flip → still approved (the old flip-order bug is gone)', () => {
    // Under v1 raw-bytes this left the spec stale; v2 excludes the status line,
    // so recording before the flip is now safe.
    approveSpec(tmp, 'SPEC-007', specPath, 'T3');
    setSpecStatus(specPath, 'implementing');
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('approved');
  });

  it('records hashVersion 2 on new approvals', () => {
    approveSpec(tmp, 'SPEC-007', specPath, 'T3');
    expect(loadApprovals(tmp)['SPEC-007'].hashVersion).toBe(2);
  });
});

// Invariant (T0) — #252 normalization. The contract hash must IGNORE volatile /
// mechanical bytes (status line, relative-link path renumbering) but STILL change
// on any substantive edit (the anti-hole guard).
describe('normalizeSpecContent — excludes volatile bytes only (#252)', () => {
  it('strips the status frontmatter line', () => {
    const withStatus = '---\nid: SPEC-1\nstatus: specifying\ntier: T3\n---\n# X\n';
    const flipped = '---\nid: SPEC-1\nstatus: implementing\ntier: T3\n---\n# X\n';
    expect(normalizeSpecContent(withStatus)).toBe(normalizeSpecContent(flipped));
    expect(normalizeSpecContent(withStatus)).not.toContain('status:');
  });

  it('collapses relative-link URLs (sibling dir renumbering is invisible)', () => {
    const before = 'See [SPEC-6](../stub-completeness-gate/requirements.md) here.';
    const after = 'See [SPEC-6](../SPEC-006-stub-completeness-gate/requirements.md) here.';
    expect(normalizeSpecContent(before)).toBe(normalizeSpecContent(after));
  });

  it('ANTI-HOLE: link TEXT changes are still visible (only the URL is collapsed)', () => {
    const a = 'See [SPEC-6](../x/requirements.md).';
    const b = 'See [SPEC-9](../x/requirements.md).';
    expect(normalizeSpecContent(a)).not.toBe(normalizeSpecContent(b));
  });

  it('ANTI-HOLE: requirement prose changes still change the hash', () => {
    const a = '---\nid: SPEC-1\nstatus: new\n---\n## FR-1\nMust do X.\n';
    const b = '---\nid: SPEC-1\nstatus: new\n---\n## FR-1\nMust do Y.\n';
    expect(normalizeSpecContent(a)).not.toBe(normalizeSpecContent(b));
  });

  it('ANTI-HOLE: non-status frontmatter (tier) changes still change the hash', () => {
    const a = '---\nid: SPEC-1\nstatus: new\ntier: T2\n---\n# X\n';
    const b = '---\nid: SPEC-1\nstatus: new\ntier: T4\n---\n# X\n';
    expect(normalizeSpecContent(a)).not.toBe(normalizeSpecContent(b));
  });

  it('leaves absolute/external links and anchors untouched', () => {
    const s = 'a [x](https://e.com/p) b [y](#anchor) c';
    expect(normalizeSpecContent(s)).toBe(s);
  });
});

// Backward compatibility (T0) — #252. A v1 record (no hashVersion) must keep
// raw-bytes comparison so upgrading the extension does not falsely stale every
// previously-approved spec.
describe('v1 records keep raw comparison; v2 use normalized (#252)', () => {
  const SPEC = '---\nid: SPEC-007\nstatus: implementing\ntier: T3\n---\n# Thing\n';
  beforeEach(() => fs.writeFileSync(specPath, SPEC));

  it('v1 record: flipping status DOES stale (legacy raw behavior preserved)', () => {
    // Hand-write a v1 record (raw hash, no hashVersion).
    saveApprovals(tmp, {
      'SPEC-007': { specHash: hashSpecFile(specPath)!, approvedAt: 't', tier: 'T3' },
    });
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('approved');
    setSpecStatus(specPath, 'done');
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('stale');
  });

  it('v2 record: flipping status does NOT stale', () => {
    saveApprovals(tmp, {
      'SPEC-007': { specHash: hashSpecFileNormalized(specPath)!, approvedAt: 't', tier: 'T3', hashVersion: 2 },
    });
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('approved');
    setSpecStatus(specPath, 'done');
    expect(getApprovalStatus(tmp, 'SPEC-007', specPath)).toBe('approved');
  });
});

// Cross-language parity (T0) — #252. The TS normalizeSpecContent and the python
// gate's normalize() MUST produce identical output, or the UI and the edit-gate
// would disagree on staleness.
describe('normalization parity: TS === spec-gate.py --normalize (#252)', () => {
  it('python gate normalizes identically to approval.ts', () => {
    const gate = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'spec-gate.py');
    if (!fs.existsSync(gate)) return; // gate not present — skip
    const fixture =
      '---\nid: SPEC-1\nstatus: implementing\ntier: T3\nepic: EPIC-1\n---\n' +
      '## FR-1\nLinks: [a](../old-dir/requirements.md), [b](./x.md), ' +
      '[ext](https://e.com), [anc](#h).\nstatus: not-a-frontmatter-line-but-matches\n';
    const f = path.join(tmp, 'fixture.md');
    fs.writeFileSync(f, fixture);
    let pyOut: string;
    try {
      pyOut = execFileSync('python3', [gate, '--normalize', f]).toString();
    } catch {
      return; // python3 unavailable — skip cross-check
    }
    expect(normalizeSpecContent(fixture)).toBe(pyOut);
  });
});
