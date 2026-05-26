import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildContext, renderTemplate, renderAll, type TemplateContext } from '../src/lib/template-engine';
import { TEMPLATE_NAMES, type TemplateName } from '../src/lib/template-registry';
import { DEFAULT_CONFIG } from '../src/lib/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('template-engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-tpl-test-'));
    // Create .minspec dir with config
    const minspecDir = path.join(tmpDir, '.minspec');
    fs.mkdirSync(minspecDir, { recursive: true });
    fs.writeFileSync(
      path.join(minspecDir, 'config.json'),
      JSON.stringify(DEFAULT_CONFIG, null, 2),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildContext()', () => {
    it('derives project name from directory name', () => {
      const ctx = buildContext(tmpDir);
      expect(ctx.projectName).toBe(path.basename(tmpDir));
    });

    it('derives project name from package.json if present', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-awesome-project' }),
      );
      const ctx = buildContext(tmpDir);
      expect(ctx.projectName).toBe('my-awesome-project');
    });

    it('strips org prefix from package.json name', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: '@org/my-lib' }),
      );
      const ctx = buildContext(tmpDir);
      expect(ctx.projectName).toBe('my-lib');
    });

    it('uses config values for specsDir and decisionsDir', () => {
      const ctx = buildContext(tmpDir);
      expect(ctx.specsDir).toBe('specs');
      expect(ctx.decisionsDir).toBe('docs/decisions');
    });

    it('uses custom config values', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.minspec', 'config.json'),
        JSON.stringify({ ...DEFAULT_CONFIG, specsDir: 'my-specs', decisionsDir: 'adr' }),
      );
      const ctx = buildContext(tmpDir);
      expect(ctx.specsDir).toBe('my-specs');
      expect(ctx.decisionsDir).toBe('adr');
    });

    it('loads invariants from constitution if present', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.minspec', 'constitution.md'),
        '## Invariants\n\n1. No AI dependency\n2. No backend\n',
      );
      const ctx = buildContext(tmpDir);
      expect(ctx.invariants).toEqual(['No AI dependency', 'No backend']);
    });

    it('returns empty arrays when no constitution exists', () => {
      const ctx = buildContext(tmpDir);
      expect(ctx.invariants).toEqual([]);
      expect(ctx.principles).toEqual([]);
      expect(ctx.constraints).toEqual([]);
    });
  });

  describe('renderTemplate()', () => {
    const baseContext: TemplateContext = {
      projectName: 'TestProject',
      specsDir: 'specs',
      decisionsDir: 'docs/decisions',
      invariants: ['Rule one', 'Rule two'],
      principles: ['Principle A'],
      constraints: ['Constraint X'],
    };

    it('substitutes projectName in all templates', () => {
      for (const name of TEMPLATE_NAMES) {
        const result = renderTemplate(name, baseContext);
        expect(result).toContain('TestProject');
      }
    });

    it('substitutes specsDir in CLAUDE.md', () => {
      const result = renderTemplate('CLAUDE.md', baseContext);
      expect(result).toContain('`specs/`');
    });

    it('substitutes decisionsDir in AGENTS.md', () => {
      const result = renderTemplate('AGENTS.md', baseContext);
      expect(result).toContain('`docs/decisions/`');
    });

    it('renders invariants list in CLAUDE.md', () => {
      const result = renderTemplate('CLAUDE.md', baseContext);
      expect(result).toContain('1. Rule one');
      expect(result).toContain('2. Rule two');
    });

    it('renders invariants as bullets in .cursorrules', () => {
      const result = renderTemplate('.cursorrules', baseContext);
      expect(result).toContain('- Rule one');
      expect(result).toContain('- Rule two');
    });

    it('renders constitution sections', () => {
      const result = renderTemplate('constitution.md', baseContext);
      expect(result).toContain('1. Rule one');
      expect(result).toContain('2. Rule two');
      expect(result).toContain('1. Principle A');
      expect(result).toContain('1. Constraint X');
    });

    it('renders fallback content when arrays are empty', () => {
      const emptyCtx: TemplateContext = {
        ...baseContext,
        invariants: [],
        principles: [],
        constraints: [],
      };
      const result = renderTemplate('constitution.md', emptyCtx);
      expect(result).toContain('<!-- Add invariants here');
      expect(result).toContain('<!-- Add principles here');
      expect(result).toContain('<!-- Add constraints here');
    });

    it('produces valid markdown (no unresolved Handlebars expressions)', () => {
      for (const name of TEMPLATE_NAMES) {
        const result = renderTemplate(name, baseContext);
        // No leftover {{ }} expressions
        expect(result).not.toMatch(/\{\{[^}]+\}\}/);
      }
    });

    it('handles missing optional context gracefully', () => {
      const minCtx: TemplateContext = {
        projectName: 'Minimal',
        specsDir: 'specs',
        decisionsDir: 'decisions',
        invariants: [],
        principles: [],
        constraints: [],
      };
      // Should not throw for any template
      for (const name of TEMPLATE_NAMES) {
        expect(() => renderTemplate(name, minCtx)).not.toThrow();
      }
    });
  });

  describe('renderAll()', () => {
    it('returns a map with all template names', () => {
      const ctx: TemplateContext = {
        projectName: 'Test',
        specsDir: 'specs',
        decisionsDir: 'docs/decisions',
        invariants: [],
        principles: [],
        constraints: [],
      };
      const results = renderAll(ctx);
      expect(results.size).toBe(TEMPLATE_NAMES.length);
      for (const name of TEMPLATE_NAMES) {
        expect(results.has(name)).toBe(true);
        expect(results.get(name)!.length).toBeGreaterThan(0);
      }
    });
  });
});
