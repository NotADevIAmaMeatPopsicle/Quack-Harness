import { authenticate, validateToken } from "../../src/services/auth";

describe("auth", () => {
  it("should authenticate valid credentials", () => {
    const result = authenticate("user", "pass");
    expect(result.token).toBeDefined();
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it("should reject empty credentials", () => {
    expect(() => authenticate("", "")).toThrow("Username and password are required");
  });

  it("should validate non-empty tokens", () => {
    const valid = validateToken("some-token");
    expect(valid).toBe(true);
  });
});
