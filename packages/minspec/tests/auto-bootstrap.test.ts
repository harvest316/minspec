import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  isMinspecInitialized,
  hasHarnessDrift,
  hasUnclassifiedChanges,
  hasUnbackfilledEpics,
  loadPreferences,
  savePreferences,
  preferencesPath,
  runBootstrap,
  isWatchedGitPath,
  BOOTSTRAP_STEPS,
  type BootstrapVsCode,
  type BootstrapStep,
} from '../src/lib/auto-bootstrap';
import { saveHashes } from '../src/lib/merge-refresh';
import { TEMPLATES, TEMPLATE_OUTPUT_PATHS } from '../src/lib/template-registry';

/** Build a BootstrapVsCode stub with spies for assertions */
function makeVsCodeStub(
  overrides: Partial<{
    enabled: boolean;
    response: string | undefined;
  }> = {},
) {
  const enabled = overrides.enabled ?? true;
  const response = overrides.response;
  const showPrompt = vi.fn(async () => response);
  const executeCommand = vi.fn(async () => undefined);
  const stub: BootstrapVsCode = {
    isEnabled: () => enabled,
    showPrompt,
    executeCommand,
  };
  return { stub, showPrompt, executeCommand };
}

describe('auto-bootstrap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-bootstrap-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // T0: missing .minspec/ detection
  // =========================================================================

  describe('isMinspecInitialized()', () => {
    it('T0: returns false when .minspec/ is missing', () => {
      expect(isMinspecInitialized(tmpDir)).toBe(false);
    });

    it('T0: returns true when .minspec/ exists', () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      expect(isMinspecInitialized(tmpDir)).toBe(true);
    });
  });

  // =========================================================================
  // T0: harness drift detection
  // =========================================================================

  describe('hasHarnessDrift()', () => {
    it('T0: returns false when .minspec/ is missing', () => {
      expect(hasHarnessDrift(tmpDir)).toBe(false);
    });

    it('T0: returns false when no harness files exist', () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      expect(hasHarnessDrift(tmpDir)).toBe(false);
    });

    it('T0: returns false when harness file matches the bundled template', () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      // Write the CLAUDE.md template content verbatim
      const relPath = TEMPLATE_OUTPUT_PATHS['CLAUDE.md'];
      fs.writeFileSync(path.join(tmpDir, relPath), TEMPLATES['CLAUDE.md']);
      // Pretend hashes already match (no stored map; content == template)
      expect(hasHarnessDrift(tmpDir)).toBe(false);
    });

    it('T0: returns true when stored hashes differ from current template hashes', () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      const relPath = TEMPLATE_OUTPUT_PATHS['CLAUDE.md'];
      // Write a stale version of CLAUDE.md
      fs.writeFileSync(
        path.join(tmpDir, relPath),
        '# Old\n\n## Overview\n\nstale content\n',
      );
      // Mock stored hashes pointing at sections that no longer hash-match
      // the bundled template — simulating "template updated upstream".
      saveHashes(tmpDir, {
        [relPath]: {
          // Heading that exists in the real CLAUDE template
          Overview: 'deadbeef-stale-hash-from-old-template-version',
          __preamble__: 'also-stale',
        },
      });
      expect(hasHarnessDrift(tmpDir)).toBe(true);
    });

    it('T0: detects drift when no hashes stored but file differs from template', () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      const relPath = TEMPLATE_OUTPUT_PATHS['CLAUDE.md'];
      // Write a file with same headings as template but body content differs
      const templateSrc = TEMPLATES['CLAUDE.md'];
      const modified = templateSrc.replace(
        /## Overview\n\n[\s\S]*?\n\n##/,
        '## Overview\n\nUSER MANUALLY EDITED THIS\n\n##',
      );
      fs.writeFileSync(path.join(tmpDir, relPath), modified);
      // No stored hashes — code path: compare body hashes to template hashes
      expect(hasHarnessDrift(tmpDir)).toBe(true);
    });
  });

  // =========================================================================
  // T0: unclassified-changes detection
  // =========================================================================

  describe('hasUnclassifiedChanges()', () => {
    it('T0: returns false when workspace is not a git repo', () => {
      expect(hasUnclassifiedChanges(tmpDir)).toBe(false);
    });

    it('T0: returns false when .git/index has not changed since HEAD', () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const headPath = path.join(tmpDir, '.git', 'HEAD');
      const indexPath = path.join(tmpDir, '.git', 'index');
      fs.writeFileSync(headPath, 'ref: refs/heads/main\n');
      fs.writeFileSync(indexPath, 'binary index contents');
      // Force the timestamps: index NOT newer than HEAD
      const now = Date.now();
      fs.utimesSync(headPath, now / 1000, now / 1000);
      fs.utimesSync(indexPath, now / 1000, (now - 5000) / 1000);
      expect(hasUnclassifiedChanges(tmpDir)).toBe(false);
    });

    it('T0: returns true when .git/index is newer and no classifications exist', () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const headPath = path.join(tmpDir, '.git', 'HEAD');
      const indexPath = path.join(tmpDir, '.git', 'index');
      fs.writeFileSync(headPath, 'ref: refs/heads/main\n');
      fs.writeFileSync(indexPath, 'binary index contents');

      const now = Date.now();
      // HEAD mtime well in the past, index mtime is "now" → activity detected
      fs.utimesSync(headPath, (now - 60000) / 1000, (now - 60000) / 1000);
      fs.utimesSync(indexPath, now / 1000, now / 1000);

      expect(hasUnclassifiedChanges(tmpDir)).toBe(true);
      // It must also create the classifications dir
      expect(
        fs.existsSync(path.join(tmpDir, '.minspec', 'classifications')),
      ).toBe(true);
    });

    it('T0: returns false when a classification file is newer than .git/index', () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      const headPath = path.join(tmpDir, '.git', 'HEAD');
      const indexPath = path.join(tmpDir, '.git', 'index');
      fs.writeFileSync(headPath, 'ref: refs/heads/main\n');
      fs.writeFileSync(indexPath, 'binary index contents');

      const classificationsDir = path.join(tmpDir, '.minspec', 'classifications');
      fs.mkdirSync(classificationsDir, { recursive: true });
      const cachePath = path.join(classificationsDir, 'latest.json');
      fs.writeFileSync(cachePath, '{"tier":"T2"}');

      // index is "now", classification cache is even newer
      const now = Date.now();
      fs.utimesSync(headPath, (now - 60000) / 1000, (now - 60000) / 1000);
      fs.utimesSync(indexPath, (now - 5000) / 1000, (now - 5000) / 1000);
      fs.utimesSync(cachePath, now / 1000, now / 1000);

      expect(hasUnclassifiedChanges(tmpDir)).toBe(false);
    });
  });

  // =========================================================================
  // T0: preferences persistence
  // =========================================================================

  describe('preferences', () => {
    it('T0: loadPreferences returns {} when file does not exist', () => {
      expect(loadPreferences(tmpDir)).toEqual({});
    });

    it('T0: savePreferences creates .minspec/ and writes JSON', () => {
      savePreferences(tmpDir, { skipInitPrompt: true });
      expect(fs.existsSync(preferencesPath(tmpDir))).toBe(true);
      const loaded = loadPreferences(tmpDir);
      expect(loaded.skipInitPrompt).toBe(true);
    });

    it('T0: savePreferences merges with existing preferences (does not clobber)', () => {
      savePreferences(tmpDir, { skipInitPrompt: true });
      savePreferences(tmpDir, { skipRefreshPrompt: true });
      const loaded = loadPreferences(tmpDir);
      expect(loaded.skipInitPrompt).toBe(true);
      expect(loaded.skipRefreshPrompt).toBe(true);
    });

    it('T0: loadPreferences returns {} when file contains invalid JSON', () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      fs.writeFileSync(preferencesPath(tmpDir), 'not json!');
      expect(loadPreferences(tmpDir)).toEqual({});
    });
  });

  // =========================================================================
  // T0: master toggle (minspec.autoBootstrap.enabled)
  // =========================================================================

  describe('runBootstrap() — master toggle', () => {
    it('T0: returns {enabled:false} and surfaces no prompt when disabled', async () => {
      // Even if .minspec/ is missing — should NOT prompt when disabled
      const { stub, showPrompt, executeCommand } = makeVsCodeStub({ enabled: false });
      const result = await runBootstrap(tmpDir, stub);
      expect(result.enabled).toBe(false);
      expect(showPrompt).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('T0: surfaces init prompt when .minspec/ missing and enabled', async () => {
      const { stub, showPrompt } = makeVsCodeStub({ response: 'Not Now' });
      const result = await runBootstrap(tmpDir, stub);
      expect(result.offered).toBe('init');
      expect(showPrompt).toHaveBeenCalledTimes(1);
      const [msg, actions] = showPrompt.mock.calls[0]!;
      expect(msg).toMatch(/isn't initialized/);
      expect(actions).toEqual(['Initialize', 'Not Now', "Don't ask again"]);
    });

    it("T0: runs minspec.init when user picks Initialize", async () => {
      const { stub, executeCommand } = makeVsCodeStub({ response: 'Initialize' });
      const result = await runBootstrap(tmpDir, stub);
      expect(result.choice).toBe('Initialize');
      expect(executeCommand).toHaveBeenCalledWith('minspec.init');
    });

    it("T0: Not Now does NOT persist any skip preference", async () => {
      const { stub } = makeVsCodeStub({ response: 'Not Now' });
      await runBootstrap(tmpDir, stub);
      // Preferences file may or may not exist; either way no skip flag set
      const prefs = loadPreferences(tmpDir);
      expect(prefs.skipInitPrompt).toBeFalsy();
    });

    it("T0: Don't ask again persists skipInitPrompt: true", async () => {
      const { stub } = makeVsCodeStub({ response: "Don't ask again" });
      await runBootstrap(tmpDir, stub);
      const prefs = loadPreferences(tmpDir);
      expect(prefs.skipInitPrompt).toBe(true);
    });
  });

  // =========================================================================
  // T0: honoring "Don't ask again" preferences
  // =========================================================================

  describe('runBootstrap() — honoring skip preferences', () => {
    it('T0: respects skipInitPrompt and surfaces no init toast', async () => {
      // .minspec/ missing → would normally trigger init prompt
      savePreferences(tmpDir, { skipInitPrompt: true });
      const { stub, showPrompt } = makeVsCodeStub();
      const result = await runBootstrap(tmpDir, stub);
      expect(showPrompt).not.toHaveBeenCalled();
      expect(result.offered).toBeNull();
    });

    it('T0: respects skipRefreshPrompt and skips refresh step', async () => {
      // Setup: .minspec exists + stale hashes (would normally trigger refresh)
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      const relPath = TEMPLATE_OUTPUT_PATHS['CLAUDE.md'];
      fs.writeFileSync(
        path.join(tmpDir, relPath),
        '# Old\n\n## Overview\n\nstale\n',
      );
      saveHashes(tmpDir, { [relPath]: { Overview: 'stale-hash', __preamble__: 'stale' } });
      savePreferences(tmpDir, { skipRefreshPrompt: true });

      const { stub, showPrompt } = makeVsCodeStub();
      const result = await runBootstrap(tmpDir, stub);
      // No refresh prompt; classify step would also not fire (no .git)
      expect(showPrompt).not.toHaveBeenCalled();
      expect(result.offered).toBeNull();
    });

    it('T0: only surfaces ONE prompt per activation (priority: init > refresh > classify)', async () => {
      // Workspace with no .minspec → init wins, even if drift/classify
      // conditions are also met.
      const { stub, showPrompt } = makeVsCodeStub({ response: 'Not Now' });
      const result = await runBootstrap(tmpDir, stub);
      expect(showPrompt).toHaveBeenCalledTimes(1);
      expect(result.offered).toBe('init');
    });

    it('T0: surfaces refresh prompt when init satisfied + drift detected', async () => {
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
      const relPath = TEMPLATE_OUTPUT_PATHS['CLAUDE.md'];
      fs.writeFileSync(
        path.join(tmpDir, relPath),
        '# Old\n\n## Overview\n\nstale\n',
      );
      saveHashes(tmpDir, { [relPath]: { Overview: 'stale', __preamble__: 'stale' } });

      const { stub, showPrompt, executeCommand } = makeVsCodeStub({ response: 'Refresh' });
      const result = await runBootstrap(tmpDir, stub);
      expect(result.offered).toBe('refresh');
      expect(showPrompt).toHaveBeenCalledTimes(1);
      expect(showPrompt.mock.calls[0]![0]).toMatch(/Harness templates updated/);
      expect(executeCommand).toHaveBeenCalledWith('minspec.initRefresh');
    });
  });

  // =========================================================================
  // Step-table sanity
  // =========================================================================

  describe('hasUnbackfilledEpics()', () => {
    function specFile(root: string, dir: string, id: string, epic?: string): void {
      const d = path.join(root, 'specs', dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${id}.md`), [
        '---', `id: ${id}`, `title: ${id}`, 'tier: T2', 'status: new', 'created: 2026-05-31',
        ...(epic ? [`epic: ${epic}`] : []), 'phases:', '  specify: done', '---', '', `# ${id}`, '',
      ].join('\n'));
    }
    function cfg(root: string): void {
      fs.mkdirSync(path.join(root, '.minspec'), { recursive: true });
      fs.writeFileSync(path.join(root, '.minspec', 'config.json'), JSON.stringify({ version: '1' }));
    }
    function epic(root: string, id: string): void {
      const d = path.join(root, 'docs', 'epics');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${id}-x.md`), `---\nid: ${id}\nslug: x\ntitle: X\nstatus: active\norder: 1\n---\n`);
    }

    it('false on a fresh project with no specs', () => {
      cfg(tmpDir);
      expect(hasUnbackfilledEpics(tmpDir)).toBe(false);
    });

    it('true when specs exist but the epic registry is empty (even one spec)', () => {
      cfg(tmpDir);
      specFile(tmpDir, 'a', 'SPEC-001');
      expect(hasUnbackfilledEpics(tmpDir)).toBe(true);
    });

    it('false when a registry exists and fewer than 3 untagged', () => {
      cfg(tmpDir);
      epic(tmpDir, 'EPIC-001');
      specFile(tmpDir, 'a', 'SPEC-001');
      specFile(tmpDir, 'b', 'SPEC-002');
      expect(hasUnbackfilledEpics(tmpDir)).toBe(false);
    });

    it('true when a registry exists but ≥3 artifacts lack an epic ref', () => {
      cfg(tmpDir);
      epic(tmpDir, 'EPIC-001');
      specFile(tmpDir, 'a', 'SPEC-001');
      specFile(tmpDir, 'b', 'SPEC-002');
      specFile(tmpDir, 'c', 'SPEC-003');
      expect(hasUnbackfilledEpics(tmpDir)).toBe(true);
    });

    it('false when a registry exists and all artifacts are tagged', () => {
      cfg(tmpDir);
      epic(tmpDir, 'EPIC-001');
      specFile(tmpDir, 'a', 'SPEC-001', 'EPIC-001');
      specFile(tmpDir, 'b', 'SPEC-002', 'EPIC-001');
      specFile(tmpDir, 'c', 'SPEC-003', 'EPIC-001');
      expect(hasUnbackfilledEpics(tmpDir)).toBe(false);
    });
  });

  describe('BOOTSTRAP_STEPS', () => {
    it('contains init, refresh, classify, backfill in that order', () => {
      const kinds = BOOTSTRAP_STEPS.map((s: BootstrapStep) => s.kind);
      expect(kinds).toEqual(['init', 'refresh', 'classify', 'backfill']);
    });

    it('each step wires to an existing minspec command', () => {
      const expected: Record<string, string> = {
        init: 'minspec.init',
        refresh: 'minspec.initRefresh',
        classify: 'minspec.classify',
        backfill: 'minspec.backfillEpics',
      };
      for (const step of BOOTSTRAP_STEPS) {
        expect(step.commandId).toBe(expected[step.kind]);
      }
    });
  });

  // =========================================================================
  // Git watcher path filter
  // =========================================================================

  describe('isWatchedGitPath()', () => {
    it('matches .git/HEAD', () => {
      expect(isWatchedGitPath('/repo/.git/HEAD')).toBe(true);
    });

    it('matches .git/refs/heads/main', () => {
      expect(isWatchedGitPath('/repo/.git/refs/heads/main')).toBe(true);
    });

    it('matches nested branch refs', () => {
      expect(isWatchedGitPath('/repo/.git/refs/heads/feat/new-thing')).toBe(true);
    });

    it('rejects unrelated paths', () => {
      expect(isWatchedGitPath('/repo/.git/config')).toBe(false);
      expect(isWatchedGitPath('/repo/.git/refs/tags/v1')).toBe(false);
      expect(isWatchedGitPath('/repo/src/HEAD')).toBe(false);
    });

    it('handles windows-style backslashes', () => {
      expect(isWatchedGitPath('C:\\repo\\.git\\HEAD')).toBe(true);
      expect(isWatchedGitPath('C:\\repo\\.git\\refs\\heads\\main')).toBe(true);
    });
  });
});
