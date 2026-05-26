import type { Tier } from './config';

// --- Public interfaces ---

/** A single classification signal emitted by the analyzer */
export interface ClassificationSignal {
  name: string;
  value: number | boolean;
  weight: number;
  tierContribution: Tier;
}

/** Input file for analysis */
export interface AnalyzableFile {
  path: string;
  content: string;
  oldContent?: string;
}

// --- Language analyzer abstraction (tree-sitter swappable) ---

/**
 * Interface for language-specific analyzers.
 * Currently implemented with regex heuristics.
 * Designed so tree-sitter WASM can be swapped in later without changing consumers.
 */
interface LanguageAnalyzer {
  detectNewExports(content: string, oldContent?: string): number;
  detectNewClasses(content: string, oldContent?: string): number;
  detectRemovedExports(content: string, oldContent?: string): number;
  detectSchemaChanges(content: string): boolean;
}

// --- Regex patterns ---

const EXPORT_RE = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
const CLASS_RE = /\bclass\s+(\w+)/g;
const INTERFACE_RE = /\binterface\s+(\w+)/g;

// Schema patterns
const PRISMA_MODEL_RE = /\bmodel\s+\w+/g;
const PRISMA_ATTR_RE = /@@|@relation/g;
const SQL_SCHEMA_RE = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|ADD\s+COLUMN)\b/gi;
const ZOD_SCHEMA_RE = /\bz\.(?:object|array|string|number|enum)\s*\(/g;

// Dependency patterns (package.json content)
const DEP_SECTION_RE = /"(?:dependencies|devDependencies|peerDependencies)"\s*:\s*\{[^}]*\}/g;

// --- Helpers ---

/** Extract all matches of a regex from content, returning matched identifiers */
function extractMatches(content: string, re: RegExp): Set<string> {
  const results = new Set<string>();
  const regex = new RegExp(re.source, re.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    // Use capture group 1 if available (identifier), otherwise full match
    results.add(match[1] ?? match[0]);
  }
  return results;
}

/** Count matches of a regex in content */
function countMatches(content: string, re: RegExp): number {
  const regex = new RegExp(re.source, re.flags);
  const matches = content.match(regex);
  return matches ? matches.length : 0;
}

/** Determine file type category from path */
function getFileCategory(filePath: string): 'js-ts' | 'prisma' | 'sql' | 'package-json' | 'unknown' {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.prisma')) return 'prisma';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('package.json')) return 'package-json';

  // JS/TS files (including JSX/TSX)
  if (/\.[jt]sx?$/.test(lower)) {
    return 'js-ts';
  }

  return 'unknown';
}

// --- Regex-based Language Analyzer ---

class RegexJsTsAnalyzer implements LanguageAnalyzer {
  detectNewExports(content: string, oldContent?: string): number {
    const currentExports = extractMatches(content, EXPORT_RE);
    if (!oldContent) {
      return currentExports.size;
    }
    const oldExports = extractMatches(oldContent, EXPORT_RE);
    let newCount = 0;
    for (const exp of currentExports) {
      if (!oldExports.has(exp)) {
        newCount++;
      }
    }
    return newCount;
  }

  detectNewClasses(content: string, oldContent?: string): number {
    const currentClasses = extractMatches(content, CLASS_RE);
    const currentInterfaces = extractMatches(content, INTERFACE_RE);
    const currentAll = new Set([...currentClasses, ...currentInterfaces]);

    if (!oldContent) {
      return currentAll.size;
    }

    const oldClasses = extractMatches(oldContent, CLASS_RE);
    const oldInterfaces = extractMatches(oldContent, INTERFACE_RE);
    const oldAll = new Set([...oldClasses, ...oldInterfaces]);

    let newCount = 0;
    for (const item of currentAll) {
      if (!oldAll.has(item)) {
        newCount++;
      }
    }
    return newCount;
  }

  detectRemovedExports(content: string, oldContent?: string): number {
    if (!oldContent) return 0;

    const currentExports = extractMatches(content, EXPORT_RE);
    const oldExports = extractMatches(oldContent, EXPORT_RE);

    let removedCount = 0;
    for (const exp of oldExports) {
      if (!currentExports.has(exp)) {
        removedCount++;
      }
    }
    return removedCount;
  }

  detectSchemaChanges(content: string): boolean {
    // For JS/TS, check for Zod schema patterns
    return countMatches(content, ZOD_SCHEMA_RE) > 0;
  }
}

class RegexPrismaAnalyzer implements LanguageAnalyzer {
  detectNewExports(_content: string, _oldContent?: string): number {
    return 0; // Prisma files don't export
  }

  detectNewClasses(_content: string, _oldContent?: string): number {
    return 0; // Prisma models aren't classes
  }

  detectRemovedExports(_content: string, _oldContent?: string): number {
    return 0;
  }

  detectSchemaChanges(content: string): boolean {
    return (
      countMatches(content, PRISMA_MODEL_RE) > 0 ||
      countMatches(content, PRISMA_ATTR_RE) > 0
    );
  }
}

class RegexSqlAnalyzer implements LanguageAnalyzer {
  detectNewExports(_content: string, _oldContent?: string): number {
    return 0;
  }

  detectNewClasses(_content: string, _oldContent?: string): number {
    return 0;
  }

  detectRemovedExports(_content: string, _oldContent?: string): number {
    return 0;
  }

  detectSchemaChanges(content: string): boolean {
    return countMatches(content, SQL_SCHEMA_RE) > 0;
  }
}

// --- Analyzer registry ---

function getAnalyzer(category: 'js-ts' | 'prisma' | 'sql' | 'package-json' | 'unknown'): LanguageAnalyzer | null {
  switch (category) {
    case 'js-ts':
      return new RegexJsTsAnalyzer();
    case 'prisma':
      return new RegexPrismaAnalyzer();
    case 'sql':
      return new RegexSqlAnalyzer();
    default:
      return null;
  }
}

// --- Dependency change detection ---

function detectDependencyChanges(content: string, oldContent?: string): number {
  if (!oldContent) {
    // New package.json — count all dependency entries
    const matches = content.match(DEP_SECTION_RE);
    if (!matches) return 0;
    let count = 0;
    for (const section of matches) {
      // Count quoted keys inside the section (each dep is "name": "version")
      const deps = section.match(/"[^"]+"\s*:\s*"[^"]+"/g);
      count += deps ? deps.length : 0;
    }
    return count;
  }

  // Diff dependencies between old and new
  const parseDeps = (raw: string): Set<string> => {
    const result = new Set<string>();
    const sections = raw.match(DEP_SECTION_RE);
    if (!sections) return result;
    for (const section of sections) {
      const entries = section.match(/"([^"]+)"\s*:\s*"[^"]+"/g);
      if (entries) {
        for (const entry of entries) {
          // Skip the section key itself (dependencies, devDependencies, etc.)
          const nameMatch = entry.match(/^"([^"]+)"/);
          if (nameMatch && !nameMatch[1].endsWith('ependencies')) {
            result.add(nameMatch[1]);
          }
        }
      }
    }
    return result;
  };

  const oldDeps = parseDeps(oldContent);
  const newDeps = parseDeps(content);

  let changes = 0;
  // New deps
  for (const dep of newDeps) {
    if (!oldDeps.has(dep)) changes++;
  }
  // Removed deps
  for (const dep of oldDeps) {
    if (!newDeps.has(dep)) changes++;
  }
  return changes;
}

// --- Main analyzer function ---

/**
 * Analyze changed files and produce classification signals.
 *
 * This is the primary entry point for the AST analysis layer.
 * Currently uses regex-based heuristics; designed for future tree-sitter swap-in.
 *
 * Gracefully returns empty signals for unsupported file types or invalid input.
 */
export async function analyzeAstSignals(
  changedFiles: AnalyzableFile[],
): Promise<ClassificationSignal[]> {
  const signals: ClassificationSignal[] = [];

  if (!changedFiles || changedFiles.length === 0) {
    return signals;
  }

  let totalNewExports = 0;
  let totalNewClasses = 0;
  let totalRemovedExports = 0;
  let hasSchemaChange = false;
  let totalDepChanges = 0;

  for (const file of changedFiles) {
    // Guard against null/undefined/empty content
    if (!file || !file.content) continue;

    const category = getFileCategory(file.path);

    // Handle package.json separately
    if (category === 'package-json') {
      totalDepChanges += detectDependencyChanges(file.content, file.oldContent);
      continue;
    }

    const analyzer = getAnalyzer(category);
    if (!analyzer) continue; // Unknown file type — graceful fallback

    totalNewExports += analyzer.detectNewExports(file.content, file.oldContent);
    totalNewClasses += analyzer.detectNewClasses(file.content, file.oldContent);
    totalRemovedExports += analyzer.detectRemovedExports(file.content, file.oldContent);

    if (!hasSchemaChange && analyzer.detectSchemaChanges(file.content)) {
      hasSchemaChange = true;
    }
  }

  // Emit signals based on aggregated analysis

  if (totalNewExports > 0) {
    signals.push({
      name: 'new_exports',
      value: totalNewExports,
      weight: totalNewExports >= 3 ? 3 : 2,
      tierContribution: totalNewExports >= 3 ? 'T3' : 'T2',
    });
  }

  if (totalNewClasses > 0) {
    signals.push({
      name: 'new_classes',
      value: totalNewClasses,
      weight: 2,
      tierContribution: 'T2',
    });
  }

  if (totalRemovedExports > 0) {
    signals.push({
      name: 'removed_exports',
      value: totalRemovedExports,
      weight: 3,
      tierContribution: 'T3',
    });
  }

  if (hasSchemaChange) {
    signals.push({
      name: 'schema_change',
      value: true,
      weight: 4,
      tierContribution: 'T3',
    });
  }

  if (totalDepChanges > 0) {
    signals.push({
      name: 'dependency_changes',
      value: totalDepChanges,
      weight: totalDepChanges >= 3 ? 3 : 1,
      tierContribution: totalDepChanges >= 3 ? 'T3' : 'T2',
    });
  }

  return signals;
}
