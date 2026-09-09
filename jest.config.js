/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
  coverageDirectory: "coverage",
  // Cap parallelism to prevent CPU/memory saturation with 79 suites.
  // Heavy integration suites (monitor, dispatcher) create HTTP servers and
  // file watchers that timeout under high concurrency.
  maxWorkers: "50%",
  // Default 5s is too tight for integration tests under parallel load.
  // Individual suites can override with jest.setTimeout() for longer tests.
  testTimeout: 15_000,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      { tsconfig: "tsconfig.eslint.json", diagnostics: { ignoreCodes: [151002] } },
    ],
  },
};
