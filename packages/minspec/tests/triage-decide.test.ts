import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// T0 invariant test for the deterministic triage gate (scripts/triage-decide.sh).
//
// The gate BACKS the LLM triage agent's judgment: a `human_only` or T3/T4 verdict
// must NEVER become `agent-ready`, no matter what the (untrusted-input-reading)
// agent emits. It must also fail CLOSED on any garbled / missing verdict.
// Root cause it guards: triage-inbox.sh was inert in headless mode and, once fixed,
// must not let a prompt-injected "agent-ready" reach an auto-build path.

const DECIDE = path.resolve(__dirname, '..', '..', '..', 'scripts', 'triage-decide.sh');

function verdict(fields: Partial<Record<'decision' | 'role' | 'tier' | 'human_only' | 'rationale', string>>): string {
  const f = { decision: 'agent-ready', role: 'dev', tier: 'T1', human_only: 'no', rationale: 'x', ...fields };
  return [
    'TRIAGE_VERDICT_BEGIN',
    `decision: ${f.decision}`,
    `role: ${f.role}`,
    `tier: ${f.tier}`,
    `human_only: ${f.human_only}`,
    `rationale: ${f.rationale}`,
    'TRIAGE_VERDICT_END',
  ].join('\n');
}

/** Run the gate, returning trimmed "<label> <role>" stdout even on non-zero exit. */
function decide(input: string): string {
  try {
    return execFileSync('bash', [DECIDE], { input, encoding: 'utf8' }).trim();
  } catch (e: any) {
    return String(e.stdout ?? '').trim();
  }
}

describe('triage-decide.sh — deterministic triage gate', () => {
  it('T1 + agent-ready (auto-buildable) → agent-ready (the only auto path)', () => {
    expect(decide(verdict({ tier: 'T1', decision: 'agent-ready' }))).toBe('agent-ready dev');
  });

  it('T2 + agent-ready → agent-ready', () => {
    expect(decide(verdict({ tier: 'T2', decision: 'agent-ready', role: 'architect' }))).toBe('agent-ready architect');
  });

  // The load-bearing invariant: injected/incorrect agent-ready cannot escape the gate.
  it('human_only=yes ALWAYS overrides agent-ready → needs-review', () => {
    expect(decide(verdict({ human_only: 'yes', tier: 'T1', decision: 'agent-ready' }))).toBe('needs-review dev');
  });

  it('human_only=true (alt spelling) also overrides → needs-review', () => {
    expect(decide(verdict({ human_only: 'true', tier: 'T2', decision: 'agent-ready' }))).toBe('needs-review dev');
  });

  it('T3 never auto-builds → needs-review', () => {
    expect(decide(verdict({ tier: 'T3', decision: 'agent-ready' }))).toBe('needs-review dev');
  });

  it('T4 never auto-builds → needs-review', () => {
    expect(decide(verdict({ tier: 'T4', decision: 'agent-ready' }))).toBe('needs-review dev');
  });

  it('needs-info decision is preserved', () => {
    expect(decide(verdict({ decision: 'needs-info', tier: 'T2' }))).toBe('needs-info dev');
  });

  it('unknown tier → needs-info (cannot size the work)', () => {
    expect(decide(verdict({ tier: 'T9' }))).toBe('needs-info dev');
  });

  it('garbled role falls back to reviewer (human-facing)', () => {
    expect(decide(verdict({ role: 'wizard', tier: 'T2', decision: 'agent-ready' }))).toBe('agent-ready reviewer');
  });

  it('no verdict block at all → fails closed to needs-review', () => {
    expect(decide('the model rambled and emitted no verdict block')).toBe('needs-review reviewer');
  });

  it('case-insensitive field names are honored', () => {
    const upper = 'TRIAGE_VERDICT_BEGIN\nDECISION: agent-ready\nROLE: dev\nTIER: T1\nHUMAN_ONLY: no\nRATIONALE: x\nTRIAGE_VERDICT_END';
    expect(decide(upper)).toBe('agent-ready dev');
  });

  it('surrounding model prose does not break extraction', () => {
    const noisy = `Here is my analysis.\n\n${verdict({ tier: 'T1', decision: 'agent-ready' })}\n\nThanks!`;
    expect(decide(noisy)).toBe('agent-ready dev');
  });
});
