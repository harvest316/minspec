/**
 * Example source file for CodeLens testing.
 * This file is mapped to SPEC-001 via traceability.json.
 */

export function authenticateUser(email: string, password: string): boolean {
  // Placeholder implementation for testing
  if (!email || !password) {
    return false;
  }
  return true;
}

export function hashPassword(plaintext: string): string {
  // Placeholder — real implementation would use bcrypt
  return `hashed:${plaintext}`;
}

export class AuthService {
  private tokens: Map<string, string> = new Map();

  login(email: string, password: string): string | null {
    if (authenticateUser(email, password)) {
      const token = `jwt-${Date.now()}`;
      this.tokens.set(email, token);
      return token;
    }
    return null;
  }

  logout(email: string): void {
    this.tokens.delete(email);
  }
}
