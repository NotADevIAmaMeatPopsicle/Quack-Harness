import { matchTaskHeading } from "./task-parser.js";

/**
 * Read only the first H1 declaration. Reconciliation intentionally accepts
 * partial specs, while executable-task inventories still use parseTaskFile.
 * Legacy IDs are opt-in for historical residual/status evidence only.
 */
export function declaredTaskIdFromSpec(
  content: string,
  options: { allowLegacyIds?: boolean } = {},
): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("# ")) continue;
    const heading = line.slice(2).trim();
    const canonical = matchTaskHeading(heading);
    if (canonical) return canonical.id;
    if (!options.allowLegacyIds) return undefined;
    // These two historical families predate the canonical executable grammar.
    return heading.match(
      /^(TASK-(?:BS-\d+|SAURUS-REM-\d{3}))(?:\s*[:\u2014\u2013-]\s*.+|\s*)$/,
    )?.[1];
  }
  return undefined;
}
