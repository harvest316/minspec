import * as fs from 'fs';
import * as path from 'path';

/** Which AI tool config files are detected in the workspace */
export interface DetectedTools {
  readonly claude: boolean;     // CLAUDE.md exists
  readonly cursor: boolean;     // .cursorrules exists
  readonly cline: boolean;      // .clinerules exists
  readonly agents: boolean;     // AGENTS.md exists
  readonly windsurf: boolean;   // .windsurfrules exists
}

/** Map from tool key to the filename it uses */
export const TOOL_FILES: Record<keyof DetectedTools, string> = {
  claude: 'CLAUDE.md',
  cursor: '.cursorrules',
  cline: '.clinerules',
  agents: 'AGENTS.md',
  windsurf: '.windsurfrules',
};

/**
 * Detect which AI tool config files exist in the workspace root.
 * Pure file-existence check — no network, no AI calls.
 */
export function detectTools(rootDir: string): DetectedTools {
  return {
    claude: fs.existsSync(path.join(rootDir, TOOL_FILES.claude)),
    cursor: fs.existsSync(path.join(rootDir, TOOL_FILES.cursor)),
    cline: fs.existsSync(path.join(rootDir, TOOL_FILES.cline)),
    agents: fs.existsSync(path.join(rootDir, TOOL_FILES.agents)),
    windsurf: fs.existsSync(path.join(rootDir, TOOL_FILES.windsurf)),
  };
}

/**
 * Get the full file path for a detected tool's config file.
 */
export function getToolFilePath(rootDir: string, tool: keyof DetectedTools): string {
  return path.join(rootDir, TOOL_FILES[tool]);
}

/**
 * Get all detected tool file paths (only those that exist).
 */
export function getDetectedToolPaths(rootDir: string): string[] {
  const tools = detectTools(rootDir);
  const paths: string[] = [];
  for (const [key, exists] of Object.entries(tools)) {
    if (exists) {
      paths.push(getToolFilePath(rootDir, key as keyof DetectedTools));
    }
  }
  return paths;
}
