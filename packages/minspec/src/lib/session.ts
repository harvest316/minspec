import * as fs from 'fs';
import * as path from 'path';

/** Session types matching SDD methodology */
export type SessionType = 'bug' | 'feat' | 'explore' | 'plan';

/** Persisted session state — stored in .minspec/session.json */
export interface SessionState {
  readonly scope: string;
  readonly project: string;
  readonly type: SessionType;
  readonly startedAt: string;       // ISO timestamp
  readonly specIds: string[];       // specs being worked on
  readonly fileAllowlist: string[]; // relative paths within scope
}

const SESSION_FILE = 'session.json';

/**
 * Get the path to the session file.
 */
export function getSessionPath(rootDir: string): string {
  return path.join(rootDir, '.minspec', SESSION_FILE);
}

/**
 * Load the current session from .minspec/session.json.
 * Returns null if no session file exists or is invalid.
 */
export function loadSession(rootDir: string): SessionState | null {
  const sessionPath = getSessionPath(rootDir);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const parsed = JSON.parse(raw) as SessionState;
    // Basic validation
    if (!parsed.scope || !parsed.project || !parsed.type || !parsed.startedAt) {
      return null;
    }
    return {
      scope: parsed.scope,
      project: parsed.project,
      type: parsed.type,
      startedAt: parsed.startedAt,
      specIds: Array.isArray(parsed.specIds) ? parsed.specIds : [],
      fileAllowlist: Array.isArray(parsed.fileAllowlist) ? parsed.fileAllowlist : [],
    };
  } catch {
    return null;
  }
}

/**
 * Save session state to .minspec/session.json.
 * Creates .minspec/ if it doesn't exist.
 */
export function saveSession(rootDir: string, session: SessionState): void {
  const minspecDir = path.join(rootDir, '.minspec');
  if (!fs.existsSync(minspecDir)) {
    fs.mkdirSync(minspecDir, { recursive: true });
  }
  const sessionPath = getSessionPath(rootDir);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf-8');
}

/**
 * Clear the active session by removing the session file.
 */
export function clearSession(rootDir: string): void {
  const sessionPath = getSessionPath(rootDir);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}

/**
 * Check if a file path is within the current session's scope.
 * Uses the fileAllowlist — if the list is empty, everything is in scope.
 * Paths are compared relative to rootDir.
 */
export function isFileInScope(session: SessionState, filePath: string, rootDir: string): boolean {
  // Empty allowlist means everything is in scope (no restrictions)
  if (session.fileAllowlist.length === 0) {
    return true;
  }

  // Normalize to relative path
  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');

  for (const allowed of session.fileAllowlist) {
    const normalizedAllowed = allowed.replace(/\\/g, '/');

    // Exact match
    if (relativePath === normalizedAllowed) {
      return true;
    }

    // Directory prefix match (allowed path is a directory containing the file)
    if (relativePath.startsWith(normalizedAllowed + '/')) {
      return true;
    }

    // Glob-like pattern: if allowlist entry ends with /*, match the directory
    if (normalizedAllowed.endsWith('/*')) {
      const dir = normalizedAllowed.slice(0, -2);
      if (relativePath.startsWith(dir + '/')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Add a file to the session's allowlist.
 * Returns a new session object (immutable).
 */
export function addToScope(session: SessionState, filePath: string, rootDir: string): SessionState {
  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');

  // Don't add duplicates
  if (session.fileAllowlist.includes(relativePath)) {
    return session;
  }

  return {
    ...session,
    fileAllowlist: [...session.fileAllowlist, relativePath],
  };
}

/**
 * Add a spec ID to the session.
 * Returns a new session object (immutable).
 */
export function addSpecToSession(session: SessionState, specId: string): SessionState {
  if (session.specIds.includes(specId)) {
    return session;
  }
  return {
    ...session,
    specIds: [...session.specIds, specId],
  };
}

/**
 * Create a new session state object.
 */
export function createSession(
  scope: string,
  project: string,
  type: SessionType,
  specIds?: string[],
  fileAllowlist?: string[],
): SessionState {
  return {
    scope,
    project,
    type,
    startedAt: new Date().toISOString(),
    specIds: specIds ?? [],
    fileAllowlist: fileAllowlist ?? [],
  };
}
