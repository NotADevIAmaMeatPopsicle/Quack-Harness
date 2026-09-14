# Public self-development conventions

Follow AGENTS.md and the assigned task scope. The initial adapter is scoped to
the Reviews UI pilot: full build, existing review API regressions and changed
TypeScript lint. It is not a universal verification policy for every backlog item.
Each task adds its own required regression commands; the operator updates the
adapter's required suite selection before dispatching a different feature area.

For TASK-1401, the adapter additionally requires its real-browser regression
suite and direct page TSX lint; the existing lint-diff script only discovers `.ts` files.
frontend/.eslintrc.cjs points TSX lint at the frontend TypeScript project.
Never silently omit a task-mandated check because the adapter's baseline passes.
Do not change scripts/lint-diff.js as part of this UI task.

Read existing API producers before defining a display contract. `gate.mergeReady`
is a documentation gate result, not proof of a verified code verdict. Show both.
Missing fields mean unknown, and server errors must not leave a success banner.
Preserve raw review JSON as secondary diagnostic detail, rendering all content
as text. Tests use local fixtures, no paid model requests or live jobs.
