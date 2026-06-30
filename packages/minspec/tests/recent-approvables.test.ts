import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordApprovableView,
  recentApprovables,
  resetRecentApprovables,
} from '../src/lib/recent-approvables';

beforeEach(() => resetRecentApprovables());

describe('recent-approvables (MRU store)', () => {
  it('records only approvable artifacts, ignoring other files', () => {
    recordApprovableView('/ws/README.md');
    recordApprovableView('/ws/src/extension.ts');
    recordApprovableView('/ws/specs/SPEC-001/plan.md'); // not a canonical spec file
    expect(recentApprovables()).toEqual([]);
  });

  it('classifies each recorded artifact by kind', () => {
    recordApprovableView('/ws/specs/SPEC-001/requirements.md');
    recordApprovableView('/ws/docs/decisions/DR-007.md');
    recordApprovableView('/ws/docs/epics/EPIC-002.md');
    expect(recentApprovables().map((r) => r.kind)).toEqual(['epic', 'adr', 'spec']);
  });

  it('orders most-recent first', () => {
    recordApprovableView('/ws/docs/decisions/DR-001.md');
    recordApprovableView('/ws/docs/decisions/DR-002.md');
    recordApprovableView('/ws/docs/decisions/DR-003.md');
    expect(recentApprovables().map((r) => r.fsPath)).toEqual([
      '/ws/docs/decisions/DR-003.md',
      '/ws/docs/decisions/DR-002.md',
      '/ws/docs/decisions/DR-001.md',
    ]);
  });

  it('moves a re-viewed artifact to the front without duplicating it', () => {
    recordApprovableView('/ws/docs/decisions/DR-001.md');
    recordApprovableView('/ws/docs/decisions/DR-002.md');
    recordApprovableView('/ws/docs/decisions/DR-001.md'); // re-view
    expect(recentApprovables().map((r) => r.fsPath)).toEqual([
      '/ws/docs/decisions/DR-001.md',
      '/ws/docs/decisions/DR-002.md',
    ]);
  });

  it('dedupes by resolved path (equivalent paths collapse)', () => {
    recordApprovableView('/ws/docs/decisions/DR-001.md');
    recordApprovableView('/ws/docs/decisions/../decisions/DR-001.md');
    expect(recentApprovables()).toHaveLength(1);
  });

  it('returns a defensive copy callers cannot mutate', () => {
    recordApprovableView('/ws/docs/decisions/DR-001.md');
    recentApprovables().push({ fsPath: '/x', kind: 'adr' });
    expect(recentApprovables()).toHaveLength(1);
  });

  it('ignores undefined (no active editor)', () => {
    recordApprovableView(undefined);
    expect(recentApprovables()).toEqual([]);
  });
});
