# TASK-042: Implement User Authentication

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 6-8 hours
- **Status:** READY
- **Blocked By:** [TASK-040, TASK-041]
- **Blocks:** [TASK-043, TASK-044, TASK-045]
- **Conventions:** [ADR-012, STYLE-001]
- **Tags:** backend, auth, security

## Problem Statement
The application currently has no authentication system. Users can access all endpoints without any identity verification, which is a security risk and blocks all user-specific features.

## Current State
All API routes in `src/routes/` are unprotected. There is no user model, no login endpoint, and no session or token management. The database schema has a `users` table placeholder but no columns defined.

## Recommended Approach
Implement JWT-based authentication with refresh tokens. Create a user model with email/password, a registration endpoint, a login endpoint that returns access + refresh tokens, and middleware that validates the access token on protected routes.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/models/user.ts | Create | User model with email, hashed password, timestamps |
| src/routes/auth.ts | Create | Register, login, refresh, logout endpoints |
| src/middleware/auth.ts | Create | JWT validation middleware |
| src/services/auth.service.ts | Create | Token generation, password hashing |
| tests/routes/auth.test.ts | Create | Integration tests for auth endpoints |
| src/config/jwt.ts | Modify | Add JWT secret and expiry configuration |

## Success Criteria
- [ ] Users can register with email and password
- [ ] Users can login and receive JWT access + refresh tokens
- [ ] Protected routes return 401 without valid token
- [ ] Refresh token endpoint issues new access token
- [ ] Passwords are hashed with bcrypt (never stored plaintext)
- [ ] All existing tests still pass

## Testing Requirements
- [ ] Unit tests for password hashing and token generation
- [ ] Integration tests for register, login, refresh, logout flows
- [ ] Test that protected routes reject invalid/expired tokens
- [ ] All tests pass: `npm test`

## Context References
- ADR-012: Layered architecture (routes -> controllers -> services -> repositories)
- STYLE-001: TypeScript naming conventions
- docs/api-spec.md: API endpoint specifications
- TASK-040: Database schema setup (completed)
