# Project Conventions

## Architecture Rules (ADR-012)
Routes -> Controllers -> Services -> Repositories -> Database
- Routes only handle HTTP concerns (status codes, headers)
- Controllers validate input and call services
- Services contain business logic, no req/res objects
- Repositories handle data access

## Field Naming (ADR-002)
- Database columns: snake_case
- API request/response: camelCase
- DTOs handle conversion automatically

## Testing
- Run tests with: npm test
- Use Jest for unit tests
- All tests must pass before committing
