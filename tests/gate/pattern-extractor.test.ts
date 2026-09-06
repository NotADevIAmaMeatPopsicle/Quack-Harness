import * as fs from "node:fs/promises";
import { extractPatterns, formatPatternsForPrompt } from "../../src/gate/pattern-extractor";
import type { ParsedTask, FileModification } from "../../src/core/types";

// ─── Mock filesystem ────────────────────────────────────────────────

jest.mock("node:fs/promises");

const mockedFs = fs as jest.Mocked<typeof fs>;

// ─── Helpers ────────────────────────────────────────────────────────

function makeTask(filesToModify: FileModification[]): ParsedTask {
  return {
    id: "TASK-100",
    title: "Test task",
    priority: "P1-HIGH",
    effort: "2h",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "",
    currentState: "",
    recommendedApproach: "",
    filesToModify,
    successCriteria: [],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "",
  };
}

const SERVICE_FILE_CONTENT = `'use strict';

const { serviceWrapper } = require('../utils/error-handler');
const clientRepository = require('../repositories/client.repository');

const getClient = serviceWrapper(async (exampleId, clientId) => {
  const client = await clientRepository.findByExampleId(exampleId, clientId);
  if (!client) throw new NotFoundError('Client not found');
  return { clientName: client.first_name, visitCount: client.visit_count };
});

const updateClient = serviceWrapper(async (exampleId, clientId, data) => {
  if (!data.email) throw new ValidationError('Email is required');
  return clientRepository.update(exampleId, clientId, data);
});

module.exports = { getClient, updateClient };
`;

const REPO_FILE_CONTENT = `'use strict';

const { repositoryWrapper } = require('../utils/error-handler');
const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

const findByExampleId = repositoryWrapper(async (exampleId, clientId) => {
  return sequelize.query(
    'SELECT * FROM fct.clients WHERE example_id = $1 AND client_id = $2',
    { bind: [exampleId, clientId], type: QueryTypes.SELECT }
  );
});

module.exports = { findByExampleId };
`;

const TS_FILE_CONTENT = `import { AppError, ValidationError } from '../errors';
import type { ClientProfile } from '../types';

export async function fetchProfile(id: number): Promise<ClientProfile> {
  if (id <= 0) throw new ValidationError('Invalid ID');
  return { clientName: 'test', totalSpend: 100 };
}

export class ProfileService {
  async getById(id: number) { return fetchProfile(id); }
}
`;

// ─── Tests ──────────────────────────────────────────────────────────

describe("extractPatterns", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: files don't exist
    mockedFs.stat.mockRejectedValue({ code: "ENOENT" });
    mockedFs.readFile.mockRejectedValue({ code: "ENOENT" });
    mockedFs.readdir.mockRejectedValue({ code: "ENOENT" });
  });

  test("extracts exports from CommonJS module.exports", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as fs.FileHandle extends never
      ? never
      : Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(SERVICE_FILE_CONTENT);

    const task = makeTask([
      { path: "src/services/client.service.js", action: "Modify", notes: "" },
    ]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].exists).toBe(true);
    expect(result.patterns[0].exports).toContain("getClient");
    expect(result.patterns[0].exports).toContain("updateClient");
  });

  test("extracts wrapper pattern", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(SERVICE_FILE_CONTENT);

    const task = makeTask([
      { path: "src/services/client.service.js", action: "Modify", notes: "" },
    ]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].wrapperPattern).toBe("serviceWrapper");
  });

  test("extracts error handling patterns", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(SERVICE_FILE_CONTENT);

    const task = makeTask([
      { path: "src/services/client.service.js", action: "Modify", notes: "" },
    ]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].errorHandling).toContain("NotFoundError");
    expect(result.patterns[0].errorHandling).toContain("ValidationError");
  });

  test("extracts import patterns", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(SERVICE_FILE_CONTENT);

    const task = makeTask([
      { path: "src/services/client.service.js", action: "Modify", notes: "" },
    ]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].importPatterns).toContain("../utils/error-handler");
    expect(result.patterns[0].importPatterns).toContain("../repositories/client.repository");
  });

  test("detects mixed field naming", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(SERVICE_FILE_CONTENT);

    const task = makeTask([
      { path: "src/services/client.service.js", action: "Modify", notes: "" },
    ]);

    const result = await extractPatterns(task, "/project");
    // File has camelCase (clientName, visitCount, exampleId, clientId, etc.) dominating over
    // snake_case (first_name, visit_count), so camelCase wins at >3:1 ratio
    expect(result.patterns[0].fieldNaming).toBe("camelCase");
  });

  test("extracts repositoryWrapper from repo files", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(REPO_FILE_CONTENT);

    const task = makeTask([
      { path: "src/repositories/client.repository.js", action: "Modify", notes: "" },
    ]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].wrapperPattern).toBe("repositoryWrapper");
    expect(result.patterns[0].exports).toContain("findByExampleId");
  });

  test("extracts ESM exports from TypeScript", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(TS_FILE_CONTENT);

    const task = makeTask([{ path: "src/services/profile.ts", action: "Modify", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].exports).toContain("fetchProfile");
    expect(result.patterns[0].exports).toContain("ProfileService");
    expect(result.patterns[0].errorHandling).toContain("ValidationError");
    expect(result.patterns[0].errorHandling).toContain("AppError");
  });

  test("returns empty pattern for missing files", async () => {
    const task = makeTask([{ path: "src/services/missing.ts", action: "Modify", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].exists).toBe(false);
    expect(result.patterns[0].exports).toEqual([]);
  });

  test("returns empty pattern for Create actions", async () => {
    mockedFs.readdir.mockRejectedValue({ code: "ENOENT" });

    const task = makeTask([{ path: "src/services/new-service.ts", action: "Create", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].exists).toBe(false);
  });

  test("scans sibling files for Create actions", async () => {
    // readdir returns sibling files
    mockedFs.readdir.mockResolvedValue([
      { name: "existing.service.ts", isFile: () => true },
      { name: "another.service.ts", isFile: () => true },
      { name: "not-code.json", isFile: () => true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

    // stat + readFile for sibling files
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(SERVICE_FILE_CONTENT);

    const task = makeTask([{ path: "src/services/new-service.ts", action: "Create", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.siblingPatterns.length).toBeGreaterThan(0);
    expect(result.siblingPatterns[0].wrapperPattern).toBe("serviceWrapper");
  });

  test("caps at MAX_FILES (10)", async () => {
    const files: FileModification[] = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      action: "Modify" as const,
      notes: "",
    }));

    const task = makeTask(files);
    const result = await extractPatterns(task, "/project");

    // Should only process first 10
    expect(result.patterns.length).toBeLessThanOrEqual(10);
  });

  test("extracts patterns from Reference action entries (treats like Modify)", async () => {
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(TS_FILE_CONTENT);

    const task = makeTask([
      { path: "src/context/ref-file.ts", action: "Reference", notes: "context only" },
    ]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].exists).toBe(true);
    expect(result.patterns[0].exports).toContain("fetchProfile");
  });

  test("does not return empty patterns for Reference entries when file exists (regression guard)", async () => {
    mockedFs.stat.mockResolvedValue({ size: 200 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue("export const CONSTANT = 42;");

    const task = makeTask([{ path: "src/context/constants.ts", action: "Reference", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    // Without the fix, patterns would be empty (Reference was silently skipped)
    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.patterns[0].exists).toBe(true);
  });

  test("marks Reference entry as exists:true when file is present (not treated like Create)", async () => {
    mockedFs.stat.mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue("export {};");

    const task = makeTask([{ path: "src/context/existing.ts", action: "Reference", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].exists).toBe(true);
  });

  test("skips files larger than 50KB", async () => {
    mockedFs.stat.mockResolvedValue({ size: 60 * 1024 } as Awaited<ReturnType<typeof fs.stat>>);

    const task = makeTask([{ path: "src/huge-file.ts", action: "Modify", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].exists).toBe(false);
  });

  test("includes snippet of first 30 lines", async () => {
    const longContent = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    mockedFs.stat.mockResolvedValue({ size: 500 } as Awaited<ReturnType<typeof fs.stat>>);
    mockedFs.readFile.mockResolvedValue(longContent);

    const task = makeTask([{ path: "src/file.ts", action: "Modify", notes: "" }]);

    const result = await extractPatterns(task, "/project");
    expect(result.patterns[0].snippet).toContain("line 1");
    expect(result.patterns[0].snippet).toContain("line 30");
    expect(result.patterns[0].snippet).not.toContain("line 31");
  });
});

describe("formatPatternsForPrompt", () => {
  test("returns empty string when no patterns exist", () => {
    const result = formatPatternsForPrompt({
      patterns: [
        {
          filePath: "new.ts",
          exists: false,
          exports: [],
          wrapperPattern: null,
          errorHandling: [],
          importPatterns: [],
          fieldNaming: "unknown",
          lineCount: 0,
          snippet: "",
        },
      ],
      siblingPatterns: [],
    });
    expect(result).toBe("");
  });

  test("formats existing file patterns", () => {
    const result = formatPatternsForPrompt({
      patterns: [
        {
          filePath: "src/services/foo.ts",
          exists: true,
          exports: ["fooService"],
          wrapperPattern: "serviceWrapper",
          errorHandling: ["ValidationError"],
          importPatterns: ["../utils/error-handler"],
          fieldNaming: "camelCase",
          lineCount: 100,
          snippet: "const x = 1;",
        },
      ],
      siblingPatterns: [],
    });

    expect(result).toContain("## Codebase Patterns");
    expect(result).toContain("src/services/foo.ts");
    expect(result).toContain("serviceWrapper");
    expect(result).toContain("fooService");
    expect(result).toContain("ValidationError");
    expect(result).toContain("camelCase");
    expect(result).toContain("ground truth");
  });

  test("formats sibling patterns separately", () => {
    const result = formatPatternsForPrompt({
      patterns: [],
      siblingPatterns: [
        {
          filePath: "src/services/existing.ts",
          exists: true,
          exports: ["existingFn"],
          wrapperPattern: "controllerWrapper",
          errorHandling: [],
          importPatterns: [],
          fieldNaming: "camelCase",
          lineCount: 50,
          snippet: "",
        },
      ],
    });

    expect(result).toContain("Sibling Files");
    expect(result).toContain("existing.ts");
    expect(result).toContain("controllerWrapper");
  });
});
