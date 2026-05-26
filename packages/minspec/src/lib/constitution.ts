/**
 * Constitution parser — extracts invariants, principles, and constraints
 * from .minspec/constitution.md.
 * Pure logic, no vscode dependency.
 */

/** Parsed constitution sections */
export interface Constitution {
  readonly invariants: string[];
  readonly principles: string[];
  readonly constraints: string[];
}

/** Empty constitution (no rules defined) */
export const EMPTY_CONSTITUTION: Constitution = {
  invariants: [],
  principles: [],
  constraints: [],
};

/**
 * Extract list items from a markdown section body.
 * Supports both numbered lists (1. item) and bullet lists (- item / * item).
 * Skips HTML comments (<!-- ... -->).
 */
function extractListItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines, comments, and headings
    if (!trimmed || trimmed.startsWith('<!--') || trimmed.startsWith('#')) {
      continue;
    }
    // Numbered list: "1. item text"
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      items.push(numberedMatch[1].trim());
      continue;
    }
    // Bullet list: "- item" or "* item"
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
      continue;
    }
  }
  return items;
}

/**
 * Parse sections from markdown content delimited by ## headings.
 * Returns a map of heading (lowercased) → body text.
 */
function parseSectionsLower(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      sections.set(currentHeading.toLowerCase(), currentBody.join('\n'));
    }
    currentBody = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^## (.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Parse a constitution markdown file into structured data.
 * Extracts items from ## Invariants, ## Principles, and ## Constraints sections.
 */
export function parseConstitution(content: string): Constitution {
  if (!content || !content.trim()) {
    return EMPTY_CONSTITUTION;
  }

  const sections = parseSectionsLower(content);

  return {
    invariants: extractListItems(sections.get('invariants') ?? ''),
    principles: extractListItems(sections.get('principles') ?? ''),
    constraints: extractListItems(sections.get('constraints') ?? ''),
  };
}
