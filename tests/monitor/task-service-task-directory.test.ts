// TASK-1338-C pre-change record: the test executed and failed because the
// deliberate public accessor did not exist.

import * as path from "node:path";

import { TaskService } from "../../src/monitor/task-service";
import { createSingleClaimantFixture, removeFixture } from "../helpers/duplicate-claimants-fixture";

it("exposes the resolved task directory without exposing private state", () => {
  const fixture = createSingleClaimantFixture("quack-task-directory-");
  try {
    const service = new TaskService(fixture.root, "docs/tasks");
    const getTaskDirectory = (service as unknown as { getTaskDirectory: () => string })
      .getTaskDirectory;

    expect(getTaskDirectory.call(service)).toBe(path.resolve(fixture.root, "docs/tasks"));
  } finally {
    removeFixture(fixture.root);
  }
});
