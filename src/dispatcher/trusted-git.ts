// Dispatcher compatibility surface for the single trusted-Git boundary.
// The implementation lives beside the worker executable resolver so sync and
// async host-authority callers cannot drift onto different security policies.

export { runTrustedGitSync, type TrustedGitSyncOptions } from "../worker/trusted-executable.js";
