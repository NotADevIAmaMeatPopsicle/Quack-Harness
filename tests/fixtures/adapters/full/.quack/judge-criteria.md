## Project-Specific Evaluation Criteria

In addition to standard scope and quality checks, evaluate:

- All database queries include tenant_id filtering (multi-tenant isolation)
- Error responses use AppError subclasses, not raw Error
- Test files use generateToken(), never loginUser()
- New API endpoints return { status: 'success', data: T } wrapper
- Controllers use controllerWrapper() for error handling
