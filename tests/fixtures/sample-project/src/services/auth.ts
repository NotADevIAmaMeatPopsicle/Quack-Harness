export interface AuthResult {
  token: string;
  expiresAt: Date;
}

export function authenticate(username: string, password: string): AuthResult {
  // Validate credentials
  if (!username || !password) {
    throw new Error("Username and password are required");
  }

  return {
    token: "sample-token",
    expiresAt: new Date(Date.now() + 3600000),
  };
}

export function validateToken(token: string): boolean {
  return token.length > 0;
}
