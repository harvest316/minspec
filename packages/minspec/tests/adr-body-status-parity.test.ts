/**
 * T3 — accepting a DR must reconcile ALL the places its status lives (#1624).
 *
 * Bug: a DR's status lives in three places — frontmatter `status:`, the body's
 * `## Status` section, and the INDEX entry. `setAdrStatus` rewrote only the
 * frontmatter, and `applyStatus` regenerated only the INDEX. The body was never
 * touched, so every acceptance left the file asserting two different statuses at
 * once. The #626 parity rule then failed — correctly, but only AFTER the accept
 * had landed, and because the accept path writes to `main` directly (DR-051), it
 * landed there. That took main red for four consecutive ci.yml runs on
 * 2026-08-19 and blocked every open PR.
 *
 * Conservative by design: only a RECOGNISED status word is rewritten. Prose we
 * do not understand is left alone for the validator to flag, because silently
 * mangling a hand-authored rationale is worse than a caught parity error.
 */
import { describe, it, expect } from 'vitest';
import { reconcileBodyStatus, statusProseWouldInvert, setAdrStatus } from '../src/lib/adr-manager';
import { inspectAllStatusClaims } from '../src/lib/status-parity';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const doc = (bodyStatus: string) =>
  `---\nid: DR-999\nstatus: proposed\n---\n\n# DR-999: Thing\n\n## Status\n\n${bodyStatus}\n\n## Context\n\nUnrelated **Proposed** word that must not be touched.\n`;

describe('#1624 — reconcileBodyStatus keeps the body in step with the frontmatter', () => {
  it('THE #1624 CASE: rewrites the bold status token on accept', () => {
    const out = reconcileBodyStatus(doc('**Proposed.** The decision was made by the founder.'), 'accepted');
    expect(out).toContain('**Accepted.** The decision was made by the founder.');
    expect(out).not.toContain('**Proposed.**');
  });

  it('preserves the surrounding prose verbatim', () => {
    const out = reconcileBodyStatus(doc('**Proposed.** Pending *MinSpec: Accept ADR*.'), 'accepted');
    expect(out).toContain('Pending *MinSpec: Accept ADR*.');
  });

  it('handles a token with no trailing period', () => {
    expect(reconcileBodyStatus(doc('**Proposed** — awaiting sign-off.'), 'accepted'))
      .toContain('**Accepted** — awaiting sign-off.');
  });

  it('only touches the FIRST token inside ## Status, never later sections', () => {
    const out = reconcileBodyStatus(doc('**Proposed.** Body.'), 'accepted');
    // The word in ## Context must survive untouched — a global replace would eat it.
    expect(out).toContain('Unrelated **Proposed** word that must not be touched.');
  });

  it('is a no-op when the DR has no ## Status section (60 of 86 DRs)', () => {
    const noSection = `---\nid: DR-998\nstatus: proposed\n---\n\n# DR-998\n\n## Context\n\nText.\n`;
    expect(reconcileBodyStatus(noSection, 'accepted')).toBe(noSection);
  });

  it('leaves UNRECOGNISED prose alone rather than mangling it', () => {
    // No known status word to anchor on → return unchanged and let the parity
    // validator flag it. Guessing here would corrupt hand-authored rationale.
    const odd = doc('This DR is in an unusual state described at length.');
    expect(reconcileBodyStatus(odd, 'accepted')).toBe(odd);
  });

  it('round-trips every status value', () => {
    for (const s of ['proposed', 'accepted', 'deprecated', 'superseded'] as const) {
      const cap = s[0].toUpperCase() + s.slice(1);
      expect(reconcileBodyStatus(doc('**Proposed.** x'), s)).toContain(`**${cap}.** x`);
    }
  });
});

// ─── The write/read asymmetry the reviewers caught ──────────────────────────
// The first version matched only a BOLD `**Proposed.**` token, while the parity
// gate also reads a plain-text leading word and the head-blockquote form. A
// writer narrower than its reader silently leaves exactly the claims the gate
// then fails on. These pin the shapes that asymmetry missed.
describe('#1624 — the writer covers every shape the parity reader recognises', () => {
  const withBody = (body: string) =>
    `---\nid: DR-997\nstatus: proposed\n---\n\n# DR-997\n\n## Status\n\n${body}\n\n## Context\n\nc\n`;

  it('plain-text leading word, no emphasis at all', () => {
    const out = reconcileBodyStatus(withBody('Proposed. Awaiting sign-off.'), 'accepted');
    expect(out).toContain('Accepted. Awaiting sign-off.');
  });

  it('single-asterisk emphasis', () => {
    expect(reconcileBodyStatus(withBody('*Proposed* — pending.'), 'accepted'))
      .toContain('*Accepted* — pending.');
  });

  it('head-blockquote form `> **Status: proposed — …**`', () => {
    const doc = `---\nid: DR-996\nstatus: proposed\n---\n\n# DR-996\n\n> **Status: proposed — born per DR-029**\n\n## Context\n\nc\n`;
    const out = reconcileBodyStatus(doc, 'accepted');
    expect(out).toContain('Status: accepted');
    expect(out).not.toContain('Status: proposed');
  });

  it('preserves lowercase when the original was lowercase', () => {
    const doc = `---\nid: DR-995\nstatus: proposed\n---\n\n# DR-995\n\n> **Status: proposed — x**\n\n## Context\n\nc\n`;
    expect(reconcileBodyStatus(doc, 'accepted')).toContain('Status: accepted');
  });

  it('leaves a freeform status line alone (not in the vocabulary)', () => {
    const doc = withBody('Clarify complete — awaiting Accept.');
    expect(reconcileBodyStatus(doc, 'accepted')).toBe(doc);
  });

  it('writer and reader agree: after a rewrite the parity gate sees no mismatch', () => {
    // The property that matters, asserted end-to-end against the REAL reader
    // rather than against this module's idea of what a claim looks like.
    const doc = withBody('Proposed. Awaiting sign-off.');
    const out = reconcileBodyStatus(doc, 'accepted');
    const claims = inspectAllStatusClaims(out, 'dr').filter((c) => c.kind === 'comparable');
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect((c as { token: string }).token).toBe('accepted');
  });
});

// ─── #1833: prose that NEGATES a status word must refuse, not invert ─────────
//
// reconcileBodyStatus swaps the token and cannot see the rest of the sentence.
// Accepting DR-088 produced "**Accepted** 2026-08-24. Not accepted, and an agent
// must never mint that." — and `npm run validate` PASSES on it, because the #626
// parity rule compares the token to the frontmatter and never reads the clause
// after it. The mechanism that keeps the gate green produced the exact false
// signpost the gate exists to prevent.
//
// Narrow by measurement, not by taste: across the 27 DRs carrying a body status
// claim, "mentions a status word" fires on 9 — nearly all benign history
// ("Accepted 2026-08-05. Proposed 2026-06-23"), where swapping is correct.
// "Negates a status word" fires on exactly 1: DR-088.
describe('#1833 — a status line whose prose negates a status word', () => {
  const dr088 = (token: string) =>
    `---\nid: DR-088\nstatus: proposed\n---\n\n# DR-088\n\n## Status\n\n**${token}** 2026-08-24. Not accepted, and an agent must never mint that.\n\n## Context\n\nc\n`;

  it('THE #1833 CASE: is detected', () => {
    const r = statusProseWouldInvert(dr088('Proposed'), 'accepted');
    expect(r).not.toBeNull();
    expect(r!.text).toContain('Not accepted');
  });

  it('is NOT rewritten — the pure function leaves it alone rather than inverting it', () => {
    const doc = dr088('Proposed');
    expect(reconcileBodyStatus(doc, 'accepted')).toBe(doc);
  });

  it('setAdrStatus REFUSES, and writes nothing at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr1833-'));
    const f = path.join(dir, 'DR-088.md');
    fs.writeFileSync(f, dr088('Proposed'));
    const before = fs.readFileSync(f, 'utf-8');
    expect(() => setAdrStatus(f, 'accepted')).toThrow(/negates a status word/);
    // The load-bearing half: refusing AFTER writing frontmatter would leave the file
    // asserting two statuses — the very state this mechanism exists to prevent.
    expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('benign HISTORY is still rewritten — the rule is negation, not mention', () => {
    // "Accepted 2026-08-05 … Proposed 2026-06-23" records history; swapping is right.
    const hist = `---\nid: DR-039\nstatus: proposed\n---\n\n# DR-039\n\n## Status\n\nProposed 2026-06-23. Superseded plan recorded 2026-06-01.\n\n## Context\n\nc\n`;
    expect(statusProseWouldInvert(hist, 'accepted')).toBeNull();
    expect(reconcileBodyStatus(hist, 'accepted')).toContain('Accepted 2026-06-23');
  });

  it('the whole real corpus stays acceptable — exactly one DR refuses', () => {
    // Guards against a rule that is technically correct and practically unusable:
    // an over-broad version blocked acceptance on 9 of 27 DRs.
    const dir = path.resolve(__dirname, '../../../docs/decisions');
    const refused = fs
      .readdirSync(dir)
      .filter((f) => /^DR-\d+\.md$/.test(f))
      .filter((f) => statusProseWouldInvert(fs.readFileSync(path.join(dir, f), 'utf-8'), 'accepted'));
    expect(refused.length).toBeLessThanOrEqual(1);
  });
});
