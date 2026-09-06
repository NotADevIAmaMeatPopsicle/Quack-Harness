// ─── Producer B tests (TASK-1312) ───────────────────────────────────

import { classifyDeployCommand } from "../../../src/judgment/producers/deploy-classifier";

const MARKERS = {
  registries: ["000000000000.dkr.ecr.us-east-1.amazonaws.com"],
  environments: ["example-production"],
};

describe("classifyDeployCommand — resolved-destination tier", () => {
  it("docker push to a configured registry", () => {
    const facts = classifyDeployCommand(
      "docker push 000000000000.dkr.ecr.us-east-1.amazonaws.com/example-service-backend:prod",
      MARKERS,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].tier).toBe("resolved_destination");
    expect(facts[0].candidateSafetyCode).toBe("production_deploy");
    expect(facts[0].marker).toBe(MARKERS.registries[0]);
  });

  it("aws ecs update-service naming a configured environment", () => {
    const facts = classifyDeployCommand(
      "aws ecs update-service --cluster example-production --service backend --force-new-deployment",
      MARKERS,
    );
    expect(facts[0].tier).toBe("resolved_destination");
  });

  it("extraCommandPatterns resolve as regex", () => {
    const facts = classifyDeployCommand("terraform apply -var env=prd-east", {
      extraCommandPatterns: ["env=prd-"],
    });
    expect(facts[0].tier).toBe("resolved_destination");
  });

  it("invalid extra patterns are skipped, never thrown", () => {
    const facts = classifyDeployCommand("terraform apply", {
      extraCommandPatterns: ["([unclosed"],
    });
    expect(facts[0].tier).toBe("shape_only");
  });

  it("round-2: markers match on boundaries — 'prod' must not match 'product'", () => {
    const markers = { environments: ["prod"] };
    expect(classifyDeployCommand("kubectl apply -f product-catalog.yaml", markers)[0].tier).toBe(
      "shape_only",
    );
    expect(classifyDeployCommand("kubectl apply --context prod -f x.yaml", markers)[0].tier).toBe(
      "resolved_destination",
    );
    expect(classifyDeployCommand("docker push registry/app:prod", markers)[0].tier).toBe(
      "resolved_destination",
    );
  });
});

describe("classifyDeployCommand — shape-only tier", () => {
  it("docker push to an unconfigured registry stays shape-only (negative case)", () => {
    const facts = classifyDeployCommand("docker push localhost:5000/dev-image:latest", MARKERS);
    expect(facts[0].tier).toBe("shape_only");
    expect(facts[0].candidateSafetyCode).toBeUndefined();
  });

  it("deploy verbs with no markers configured stay shape-only", () => {
    for (const command of [
      "kubectl apply -f deployment.yaml",
      "kubectl rollout restart deployment/x",
      "gh workflow run deploy.yml",
      "eb deploy",
      "fly deploy",
      "flyctl deploy",
      "vercel build --prod",
      "npm publish",
      "aws ssm send-command --instance-ids i-123",
    ]) {
      const facts = classifyDeployCommand(command);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].tier).toBe("shape_only");
    }
  });
});

describe("classifyDeployCommand — non-deploy commands", () => {
  it.each([
    "docker build -t x .",
    "docker tag a b",
    "npm test",
    "aws s3 ls",
    "kubectl get pods",
    "git status",
    "npm run publish-docs",
  ])("ignores %s", (command) => {
    expect(classifyDeployCommand(command, MARKERS)).toEqual([]);
  });
});

describe("classifyDeployCommand — documented evasion residual (pinned)", () => {
  it("env-var indirection stays shape-only by construction", () => {
    const facts = classifyDeployCommand('docker push "$TARGET"', MARKERS);
    expect(facts[0].tier).toBe("shape_only");
  });

  it("compound commands classify per segment", () => {
    const facts = classifyDeployCommand(
      "docker build -t x . && docker push 000000000000.dkr.ecr.us-east-1.amazonaws.com/x",
      MARKERS,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].tier).toBe("resolved_destination");
  });
});
