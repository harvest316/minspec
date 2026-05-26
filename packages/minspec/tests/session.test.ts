import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadSession,
  saveSession,
  clearSession,
  isFileInScope,
  addToScope,
  addSpecToSession,
  createSession,
  getSessionPath,
} from '../src/lib/session';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('session', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-session-test-'));
    fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveSession() + loadSession() round-trip', () => {
    it('persists and loads session state', () => {
      const session = createSession('Implement auth', 'minspec', 'feat', ['SPEC-001'], ['src/auth.ts']);
      saveSession(tmpDir, session);

      const loaded = loadSession(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.scope).toBe('Implement auth');
      expect(loaded!.project).toBe('minspec');
      expect(loaded!.type).toBe('feat');
      expect(loaded!.specIds).toEqual(['SPEC-001']);
      expect(loaded!.fileAllowlist).toEqual(['src/auth.ts']);
      expect(loaded!.startedAt).toBeTruthy();
    });

    it('creates .minspec dir if it does not exist', () => {
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-bare-'));
      const session = createSession('Test', 'test', 'bug');
      saveSession(bareDir, session);

      expect(fs.existsSync(path.join(bareDir, '.minspec', 'session.json'))).toBe(true);
      fs.rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('loadSession()', () => {
    it('returns null when no session file exists', () => {
      expect(loadSession(tmpDir)).toBeNull();
    });

    it('returns null when session file is invalid JSON', () => {
      fs.writeFileSync(getSessionPath(tmpDir), 'not json', 'utf-8');
      expect(loadSession(tmpDir)).toBeNull();
    });

    it('returns null when session file has missing required fields', () => {
      fs.writeFileSync(
        getSessionPath(tmpDir),
        JSON.stringify({ scope: 'test' }), // missing project, type, startedAt
        'utf-8',
      );
      expect(loadSession(tmpDir)).toBeNull();
    });

    it('defaults specIds and fileAllowlist to empty arrays if missing', () => {
      fs.writeFileSync(
        getSessionPath(tmpDir),
        JSON.stringify({
          scope: 'test',
          project: 'p',
          type: 'feat',
          startedAt: '2026-01-01T00:00:00Z',
        }),
        'utf-8',
      );
      const loaded = loadSession(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.specIds).toEqual([]);
      expect(loaded!.fileAllowlist).toEqual([]);
    });
  });

  describe('clearSession()', () => {
    it('removes the session file', () => {
      const session = createSession('Test', 'test', 'bug');
      saveSession(tmpDir, session);
      expect(loadSession(tmpDir)).not.toBeNull();

      clearSession(tmpDir);
      expect(loadSession(tmpDir)).toBeNull();
    });

    it('is no-op when no session file exists', () => {
      clearSession(tmpDir); // Should not throw
    });
  });

  describe('isFileInScope()', () => {
    it('returns true when allowlist is empty (no restrictions)', () => {
      const session = createSession('Test', 'test', 'feat');
      expect(isFileInScope(session, path.join(tmpDir, 'anything.ts'), tmpDir)).toBe(true);
    });

    it('returns true for exact match in allowlist', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/auth.ts']);
      expect(isFileInScope(session, path.join(tmpDir, 'src', 'auth.ts'), tmpDir)).toBe(true);
    });

    it('returns false for file not in allowlist', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/auth.ts']);
      expect(isFileInScope(session, path.join(tmpDir, 'src', 'other.ts'), tmpDir)).toBe(false);
    });

    it('returns true for file in allowed directory', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src']);
      expect(isFileInScope(session, path.join(tmpDir, 'src', 'deep', 'nested.ts'), tmpDir)).toBe(true);
    });

    it('handles glob-like directory patterns with /*', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/*']);
      expect(isFileInScope(session, path.join(tmpDir, 'src', 'auth.ts'), tmpDir)).toBe(true);
      expect(isFileInScope(session, path.join(tmpDir, 'lib', 'other.ts'), tmpDir)).toBe(false);
    });

    it('handles files outside the workspace root', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/auth.ts']);
      expect(isFileInScope(session, '/completely/different/path.ts', tmpDir)).toBe(false);
    });
  });

  describe('addToScope()', () => {
    it('adds a file to the allowlist', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/auth.ts']);
      const updated = addToScope(session, path.join(tmpDir, 'src', 'other.ts'), tmpDir);
      expect(updated.fileAllowlist).toContain('src/other.ts');
      expect(updated.fileAllowlist).toContain('src/auth.ts');
    });

    it('does not add duplicates', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/auth.ts']);
      const updated = addToScope(session, path.join(tmpDir, 'src', 'auth.ts'), tmpDir);
      expect(updated.fileAllowlist).toEqual(['src/auth.ts']);
    });

    it('returns new object (immutable)', () => {
      const session = createSession('Test', 'test', 'feat', [], ['src/auth.ts']);
      const updated = addToScope(session, path.join(tmpDir, 'src', 'other.ts'), tmpDir);
      expect(updated).not.toBe(session);
      expect(session.fileAllowlist).toEqual(['src/auth.ts']); // Original unchanged
    });
  });

  describe('addSpecToSession()', () => {
    it('adds a spec ID to the session', () => {
      const session = createSession('Test', 'test', 'feat', ['SPEC-001']);
      const updated = addSpecToSession(session, 'SPEC-002');
      expect(updated.specIds).toEqual(['SPEC-001', 'SPEC-002']);
    });

    it('does not add duplicates', () => {
      const session = createSession('Test', 'test', 'feat', ['SPEC-001']);
      const updated = addSpecToSession(session, 'SPEC-001');
      expect(updated.specIds).toEqual(['SPEC-001']);
    });
  });

  describe('createSession()', () => {
    it('creates a valid session with defaults', () => {
      const session = createSession('Scope', 'proj', 'bug');
      expect(session.scope).toBe('Scope');
      expect(session.project).toBe('proj');
      expect(session.type).toBe('bug');
      expect(session.specIds).toEqual([]);
      expect(session.fileAllowlist).toEqual([]);
      expect(session.startedAt).toBeTruthy();
      // Verify ISO timestamp format
      expect(() => new Date(session.startedAt)).not.toThrow();
    });
  });
});
