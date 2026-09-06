# TypeScript Conventions

## Code Style
- Strict TypeScript (`strict: true` in tsconfig)
- No `any` unless absolutely necessary
- async/await everywhere (no raw Promise chains)
- Throw typed errors, catch at boundaries

## Naming
- Files: kebab-case (`event-reader.ts`, `llm-judge.ts`)
- Types/Interfaces: PascalCase (`ParsedTask`, `EventWriter`)
- Functions/variables: camelCase
- Constants: UPPER_SNAKE_CASE (`JUDGE_MAX_TURNS`)

## File Structure
- Source: `src/` mirrors test structure in `tests/`
- Each module has a top-of-file comment block explaining purpose
- Imports grouped: node builtins, then external packages, then local modules

## Testing
- Jest with ts-jest
- Test files mirror source: `src/foo/bar.ts` → `tests/foo/bar.test.ts`
- Use descriptive `describe`/`test` blocks
- Mock external dependencies (SDK, filesystem) — never call real LLM APIs in tests
- Temp directories for filesystem tests, cleaned up in `afterEach`

## SDK Integration
- Agent SDK loaded via lazy ESM dynamic import (`await import(...)`)
- Type shims defined locally to avoid ESM/CJS import issues
- `SDKAssistantMessage.message.content` is `ContentBlock[]`, not a string
- `SDKResultSuccess` uses `total_cost_usd` (snake_case), `num_turns`
- Always provide `_setQueryFn()` test hook for mocking SDK calls

## Architecture Rules
- Core modules must never reference specific frameworks
- Adapter config is the only codebase-specific knowledge
- EventWriter is always optional — functions work without it
- MCP tools are restricted: verify (adapter commands), git (no push/reset)
