export interface TestOutputAnalysis {
  count?: number;
  explicitNoTests: boolean;
}

export function isTestCommand(name: string, command: string): boolean {
  return (
    /\b(test(s)?|jest|vitest|pytest)\b/i.test(name) ||
    /\b(jest|vitest|pytest|cargo test|go test)\b/i.test(command) ||
    /\b(npm|pnpm|yarn)\s+(run\s+)?test\b/i.test(command)
  );
}

export function analyzeTestOutput(stdout: string, stderr = ""): TestOutputAnalysis {
  const output = [stdout, stderr].filter(Boolean).join("\n");

  const countPatterns = [
    /All\s+(\d+)\s+tests?\s+passed/i,
    /Tests?:\s*(\d+)\s+passed/i,
    /Tests?\s+(\d+)\s+passed/i,
    /(\d+)\s+tests?\s+passed/i,
    /(\d+)\s+passed/i,
    /test result:.*?(\d+)\s+passed/i,
  ];

  for (const pattern of countPatterns) {
    const match = pattern.exec(output);
    if (match) {
      const count = Number.parseInt(match[1] ?? "0", 10);
      return { count, explicitNoTests: count === 0 };
    }
  }

  if (/PASS\n.*?ok\s+/i.test(output)) {
    return { count: 1, explicitNoTests: false };
  }

  const explicitNoTests =
    /\b0\s+tests?\b/i.test(output) ||
    /\b0\/0\b/.test(output) ||
    /no tests? (found|ran|run|matched)/i.test(output) ||
    /no test files? (found|matched)/i.test(output) ||
    /passWithNoTests/i.test(output);

  return explicitNoTests ? { count: 0, explicitNoTests: true } : { explicitNoTests: false };
}
