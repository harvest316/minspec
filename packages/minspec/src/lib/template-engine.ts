/**
 * Template engine — renders Handlebars templates with project context.
 * Pure logic, no vscode dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import { loadConfig, type MinspecConfig } from './config';
import { TEMPLATES, TEMPLATE_NAMES, type TemplateName } from './template-registry';
import { parseConstitution, type Constitution } from './constitution';

/** Variables available to all templates */
export interface TemplateContext {
  readonly projectName: string;
  readonly specsDir: string;
  readonly decisionsDir: string;
  readonly invariants: string[];
  readonly principles: string[];
  readonly constraints: string[];
}

/**
 * Register custom Handlebars helpers.
 * Called once at module load.
 */
function registerHelpers(): void {
  // {{incremented @index}} → 1-based index for numbered lists
  Handlebars.registerHelper('incremented', (index: number) => index + 1);
}

// Register helpers on module load
registerHelpers();

/**
 * Build template context from project root directory.
 * Reads config and constitution if they exist.
 */
export function buildContext(rootDir: string, config?: MinspecConfig): TemplateContext {
  const resolvedConfig = config ?? loadConfig(rootDir);

  // Derive project name from directory name (or package.json if available)
  let projectName = path.basename(rootDir);
  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name && typeof pkg.name === 'string') {
        // Strip org prefix if present (e.g., @aiclarity/minspec → minspec)
        projectName = pkg.name.replace(/^@[^/]+\//, '');
      }
    } catch {
      // Fall back to directory name
    }
  }

  // Load constitution if it exists
  const constitutionPath = path.join(rootDir, '.minspec', 'constitution.md');
  let constitution: Constitution = { invariants: [], principles: [], constraints: [] };
  if (fs.existsSync(constitutionPath)) {
    const content = fs.readFileSync(constitutionPath, 'utf-8');
    constitution = parseConstitution(content);
  }

  return {
    projectName,
    specsDir: resolvedConfig.specsDir,
    decisionsDir: resolvedConfig.decisionsDir,
    invariants: constitution.invariants,
    principles: constitution.principles,
    constraints: constitution.constraints,
  };
}

/**
 * Render a single template by name with the given context.
 * Returns the rendered markdown string.
 */
export function renderTemplate(templateName: TemplateName, context: TemplateContext): string {
  const source = TEMPLATES[templateName];
  if (!source) {
    throw new Error(`Unknown template: ${templateName}`);
  }
  const compiled = Handlebars.compile(source, { noEscape: true });
  return compiled(context);
}

/**
 * Render all templates with the given context.
 * Returns a map of template name → rendered content.
 */
export function renderAll(context: TemplateContext): Map<TemplateName, string> {
  const results = new Map<TemplateName, string>();
  for (const name of TEMPLATE_NAMES) {
    results.set(name, renderTemplate(name, context));
  }
  return results;
}
