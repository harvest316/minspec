import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  evaluateConstitution,
  isAllTemplate,
  PROPOSE_ACTION_LABEL,
  PROPOSE_COMMAND_ID,
} from '../src/lib/constitution-nudge';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-nudge-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConstitution(content: string): void {
  const dir = path.join(tmp, '.minspec');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'constitution.md'), content);
}

const ALL_TEMPLATE = `# proj — Constitution

## Invariants

Rules that must never be violated.

<!-- Add invariants here. Example: -->
<!-- 1. No breaking changes -->

## Principles

Guidelines.

<!-- Add principles here -->

## Constraints

Constraints.

<!-- Add constraints here -->
`;

describe('isAllTemplate', () => {
  it('true for all-comment template', () => {
    expect(isAllTemplate(ALL_TEMPLATE)).toBe(true);
  });

  it('true when only MinSpec DRAFT entries are present (no human content)', () => {
    const seeded = `## Invariants

- DRAFT: Runs offline.
  > _proposed because no network deps_
`;
    expect(isAllTemplate(seeded)).toBe(true);
  });

  it('false once a human (non-DRAFT) invariant is present', () => {
    const human = `## Invariants

1. A human-authored invariant.
`;
    expect(isAllTemplate(human)).toBe(false);
  });
});

describe('evaluateConstitution (FR-6)', () => {
  it('all-template constitution → empty=true with author advisory', () => {
    writeConstitution(ALL_TEMPLATE);
    const nudge = evaluateConstitution(tmp);
    expect(nudge.empty).toBe(true);
    expect(nudge.message).toMatch(/author/i);
  });

  it('populated (human invariant) constitution → empty=false (no false nudge)', () => {
    writeConstitution(`## Invariants

1. A human invariant.
`);
    const nudge = evaluateConstitution(tmp);
    expect(nudge.empty).toBe(false);
  });

  it('missing constitution.md → empty=true and never throws', () => {
    expect(() => evaluateConstitution(tmp)).not.toThrow();
    expect(evaluateConstitution(tmp).empty).toBe(true);
  });

  it('carries the offer-to-fix action metadata (#320)', () => {
    writeConstitution(ALL_TEMPLATE);
    const nudge = evaluateConstitution(tmp);
    expect(nudge.fixActionLabel).toBe(PROPOSE_ACTION_LABEL);
    expect(nudge.fixCommandId).toBe(PROPOSE_COMMAND_ID);
    expect(nudge.fixCommandId).toBe('minspec.constitutionPropose');
  });
});
