// ─── Producer B: Production-Deploy Classifier (TASK-1312) ──────────
// Pure, per-command classification of deploy-shaped Bash commands.
//
// HONESTY (round-1 mandated): per-command classification is ATTEMPT
// VISIBILITY, not a guarantee. Env-var indirection (`export T=prod-host
// && docker push "$T"`) and split sequences (`docker tag` then `docker
// push`) evade the resolved-destination tier by construction. Real deploy
// prevention in this ecosystem lives at credential boundaries, not
// command parsing. Session-stream classification with argument
// provenance is a wiring-slice consideration, out of scope here.
//
// Tiers:
//   - "resolved_destination": deploy verb + a configured production
//     marker resolvable in the SAME command → `production_deploy`
//     candidate fact (the only tier the wiring slice may treat as
//     safety-grade).
//   - "shape_only": deploy verb, unresolved destination → advisory-tier
//     fact, never safety.

import { splitCommandSegments } from "../../worker/git-floor.js";

export interface ProductionMarkers {
  /** Registry hosts/prefixes, matched case-insensitively as substrings. */
  registries?: string[];
  /** Environment names, matched case-insensitively as substrings. */
  environments?: string[];
  /** Additional regex sources (case-insensitive) that mark production. */
  extraCommandPatterns?: string[];
}

export interface DeployFact {
  kind: "deploy";
  tier: "resolved_destination" | "shape_only";
  verb: string;
  /** The marker that resolved the destination (resolved tier only). */
  marker?: string;
  candidateSafetyCode?: "production_deploy";
  /** The offending command segment (truncated). */
  segment: string;
}

interface DeployVerbSpec {
  verb: string;
  pattern: RegExp;
}

const DEPLOY_VERBS: DeployVerbSpec[] = [
  { verb: "docker push", pattern: /(^|\s)docker\s+push(\s|$)/ },
  {
    verb: "aws ecs",
    pattern: /(^|\s)aws\s+ecs\s+(update-service|create-deployment|deploy)(\s|$)/,
  },
  { verb: "aws ssm send-command", pattern: /(^|\s)aws\s+ssm\s+send-command(\s|$)/ },
  { verb: "kubectl apply", pattern: /(^|\s)kubectl\s+(apply|rollout)(\s|$)/ },
  { verb: "terraform apply", pattern: /(^|\s)terraform\s+apply(\s|$)/ },
  { verb: "gh workflow run", pattern: /(^|\s)gh\s+workflow\s+run(\s|$)/ },
  { verb: "eb deploy", pattern: /(^|\s)eb\s+deploy(\s|$)/ },
  { verb: "fly deploy", pattern: /(^|\s)fly(ctl)?\s+deploy(\s|$)/ },
  { verb: "vercel --prod", pattern: /(^|\s)vercel\b[^\n]*\s--prod(\s|$)/ },
  { verb: "npm publish", pattern: /(^|\s)npm\s+publish(\s|$)/ },
];

function truncateSegment(segment: string): string {
  return segment.length > 200 ? `${segment.slice(0, 200)}…` : segment;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Boundary-aware marker test (round-2: a marker `prod` must not match
 * `product` — occurrences need non-alphanumeric boundaries).
 */
function markerMatches(segment: string, marker: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(marker)}([^A-Za-z0-9]|$)`, "i").test(segment);
}

function resolveMarker(segment: string, markers: ProductionMarkers): string | undefined {
  for (const registry of markers.registries ?? []) {
    if (registry && markerMatches(segment, registry)) return registry;
  }
  for (const environment of markers.environments ?? []) {
    if (environment && markerMatches(segment, environment)) return environment;
  }
  for (const source of markers.extraCommandPatterns ?? []) {
    if (!source) continue;
    try {
      if (new RegExp(source, "i").test(segment)) return source;
    } catch {
      // Invalid pattern sources are skipped, never thrown: a bad adapter
      // entry must not break command classification.
    }
  }
  return undefined;
}

/**
 * Classify one raw Bash command (segment-split like the git floor) into
 * deploy facts. Pure; consumed today only by evidence/event recording.
 */
export function classifyDeployCommand(
  command: string,
  markers: ProductionMarkers = {},
): DeployFact[] {
  const facts: DeployFact[] = [];
  for (const segment of splitCommandSegments(command)) {
    for (const { verb, pattern } of DEPLOY_VERBS) {
      if (!pattern.test(segment)) continue;
      const marker = resolveMarker(segment, markers);
      facts.push({
        kind: "deploy",
        tier: marker !== undefined ? "resolved_destination" : "shape_only",
        verb,
        ...(marker !== undefined ? { marker } : {}),
        ...(marker !== undefined ? { candidateSafetyCode: "production_deploy" as const } : {}),
        segment: truncateSegment(segment),
      });
    }
  }
  return facts;
}
