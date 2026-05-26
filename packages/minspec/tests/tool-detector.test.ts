import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectTools,
  getToolFilePath,
  getDetectedToolPaths,
  TOOL_FILES,
} from '../src/lib/tool-detector';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('tool-detector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-tools-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectTools()', () => {
    it('returns all false when no tool files exist', () => {
      const tools = detectTools(tmpDir);
      expect(tools.claude).toBe(false);
      expect(tools.cursor).toBe(false);
      expect(tools.cline).toBe(false);
      expect(tools.agents).toBe(false);
      expect(tools.windsurf).toBe(false);
    });

    it('detects CLAUDE.md', () => {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude');
      const tools = detectTools(tmpDir);
      expect(tools.claude).toBe(true);
      expect(tools.cursor).toBe(false);
    });

    it('detects .cursorrules', () => {
      fs.writeFileSync(path.join(tmpDir, '.cursorrules'), 'rules');
      const tools = detectTools(tmpDir);
      expect(tools.cursor).toBe(true);
      expect(tools.claude).toBe(false);
    });

    it('detects .clinerules', () => {
      fs.writeFileSync(path.join(tmpDir, '.clinerules'), 'rules');
      const tools = detectTools(tmpDir);
      expect(tools.cline).toBe(true);
    });

    it('detects AGENTS.md', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents');
      const tools = detectTools(tmpDir);
      expect(tools.agents).toBe(true);
    });

    it('detects .windsurfrules', () => {
      fs.writeFileSync(path.join(tmpDir, '.windsurfrules'), 'rules');
      const tools = detectTools(tmpDir);
      expect(tools.windsurf).toBe(true);
    });

    it('detects multiple tools simultaneously', () => {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude');
      fs.writeFileSync(path.join(tmpDir, '.cursorrules'), 'rules');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents');

      const tools = detectTools(tmpDir);
      expect(tools.claude).toBe(true);
      expect(tools.cursor).toBe(true);
      expect(tools.agents).toBe(true);
      expect(tools.cline).toBe(false);
      expect(tools.windsurf).toBe(false);
    });
  });

  describe('getToolFilePath()', () => {
    it('returns correct path for each tool', () => {
      expect(getToolFilePath(tmpDir, 'claude')).toBe(path.join(tmpDir, 'CLAUDE.md'));
      expect(getToolFilePath(tmpDir, 'cursor')).toBe(path.join(tmpDir, '.cursorrules'));
      expect(getToolFilePath(tmpDir, 'cline')).toBe(path.join(tmpDir, '.clinerules'));
      expect(getToolFilePath(tmpDir, 'agents')).toBe(path.join(tmpDir, 'AGENTS.md'));
      expect(getToolFilePath(tmpDir, 'windsurf')).toBe(path.join(tmpDir, '.windsurfrules'));
    });
  });

  describe('getDetectedToolPaths()', () => {
    it('returns empty array when no tools detected', () => {
      expect(getDetectedToolPaths(tmpDir)).toEqual([]);
    });

    it('returns paths only for detected tools', () => {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude');
      fs.writeFileSync(path.join(tmpDir, '.cursorrules'), 'rules');

      const paths = getDetectedToolPaths(tmpDir);
      expect(paths).toHaveLength(2);
      expect(paths).toContain(path.join(tmpDir, 'CLAUDE.md'));
      expect(paths).toContain(path.join(tmpDir, '.cursorrules'));
    });
  });

  describe('TOOL_FILES constant', () => {
    it('has entries for all tool keys', () => {
      expect(TOOL_FILES.claude).toBe('CLAUDE.md');
      expect(TOOL_FILES.cursor).toBe('.cursorrules');
      expect(TOOL_FILES.cline).toBe('.clinerules');
      expect(TOOL_FILES.agents).toBe('AGENTS.md');
      expect(TOOL_FILES.windsurf).toBe('.windsurfrules');
    });
  });
});
