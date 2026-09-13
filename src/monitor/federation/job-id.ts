// IDs are portable filename stems, never paths. Leave room for lock-owner suffixes.
const JOB_ID_START = /^[A-Za-z0-9_]/;
const UNSAFE_JOB_ID_CHARACTER = /[^A-Za-z0-9._-]/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function isSafeFederatedJobId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 96 && JOB_ID_START.test(value) &&
    !UNSAFE_JOB_ID_CHARACTER.test(value) && !WINDOWS_DEVICE.test(value);
}

export class InvalidFederatedJobIdError extends Error {
  readonly code = "INVALID_FEDERATED_JOB_ID";
  constructor() {
    super("Federated job identifier must be a portable filename stem.");
    this.name = "InvalidFederatedJobIdError";
  }
}

export function assertSafeFederatedJobId(value: unknown): asserts value is string {
  if (!isSafeFederatedJobId(value)) throw new InvalidFederatedJobIdError();
}

export class FederatedJobIdentityMismatchError extends Error {
  readonly code = "FEDERATED_JOB_IDENTITY_MISMATCH";
  constructor() {
    super("A federated job update cannot change the locked job identifier.");
    this.name = "FederatedJobIdentityMismatchError";
  }
}

export function assertFederatedJobIdentity(value: unknown, expected: string): void {
  assertSafeFederatedJobId(value);
  if (value !== expected) throw new FederatedJobIdentityMismatchError();
}

export function invalidFederatedJobIdResponse(): { code: string; error: string } {
  const error = new InvalidFederatedJobIdError();
  return { code: error.code, error: error.message };
}
