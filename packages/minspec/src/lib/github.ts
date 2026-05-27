import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Check if the `gh` CLI is available and authenticated.
 */
export async function isGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      timeout: 5000,
      env: { ...process.env },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the GitHub repo (owner/name) from the git remote in rootDir.
 * Returns null if no remote found or not a GitHub repo.
 */
export async function getRepoFromRemote(rootDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: rootDir,
      timeout: 5000,
    });
    const url = stdout.trim();
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (sshMatch) return sshMatch[1];
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch {
    return null;
  }
}
