# Sample Platform Issues — parser fixture

This fixture reproduces every structural irregularity observed in the real
`project-wiki/wiki/quack/platform-issues.md`, so the parser's guards are
exercised even on a machine that has no wiki clone.

---

## Active issues

| ID | Title | Severity | Status |
|---|---|---|---|
| QPI-101 | A resolved one | P1 | resolved |
| QPI-102 | An open one | P2 | open |

## Entry template

Copy this block. The heading below sits inside a code fence and is NOT an
entry; a fence-blind parser reports it as one, which is how the real ledger
gets miscounted by exactly one.

```markdown
## QPI-NNN — Short imperative title

- **Status:** open / investigating / waiting-on / resolved
- **Severity:** P0 / P1 / P2
- **First seen:** YYYY-MM-DD
```

---

## QPI-101 — Em dash separator, bulleted metadata, resolved

- **Status:** resolved — deployed `abc1234` (TASK-800), verified 2026-05-11
- **Severity:** P1
- **First seen:** 2026-05-04
- **Hosts affected:** headnode
- **Filed by:** Someone

The first prose paragraph is what the atlas shows on a bug card.

### Reproduction

1. Do a thing at `src/monitor/server.ts:4278` and watch it fail.

---

## QPI-102 - ASCII hyphen separator, unbulleted metadata, open

**Status:** OPEN
**Severity:** P2 - casing is inconsistent across the file
**Found:** 2026-07-30
**Component:** `monitor/`, spec parsing plus chokidar file watching

An open entry whose anchors use a bare filename with no directory, which is
how the newer entries are written: `dispatch-manager.ts:720-723` and then a
line-only continuation `:792-796` that inherits the file from earlier in the
same sentence. A port like `:3337` must not be read as a line number.

## QPI-103: colon separator with no space before it

**Status:** **SCHEDULER LEG FIXED 2026-08-10 (merged `7a6dd39`, pending deploy); source archaeology OPEN.**

A status value that opens with bold-inside-bold and describes a partial fix.

## See also

This level-2 section sits between entries. Splitting on `^## QPI-` alone
would silently fold it, and the four links below, into QPI-103's body.

- `docs/QUACK_ADMIN_OPERATING_MANUAL.md` — full admin contract
- `docs/TROUBLESHOOTING.md` — operator-facing known issues

---

## QPI-104 — No status line at all

### Date: 2026-05-16

Two real entries carry no `**Status:**` and no `**Severity:**`. They must be
emitted with an explicit reason, never dropped.

## QPI-105 — Status that matches no rule

- **Status:** startup_matrix_complete_auto_fallback_validated
- **Severity:** P2

An unclassifiable status is a finding. Counting it as resolved is the failure
mode this fixture exists to pin.

## QPI-106 — Metadata below a sub-heading, and a wrapped value

**Status:** workaround_active

### CORRECTION 2026-08-10

- Some bullet that separates the status from the rest of the metadata.

### The fix

**Severity:** P1
**Found:** 2026-08-01
- **Resolved:** 2026-05-13 by TASK-918. The route now reports the canonical
  verification-store write outcome and persisted row metadata; stale writes
  return HTTP 409 instead of a request-echo success body.

## QPI-107 — Mixed bulleted and unbulleted metadata across a blank line

- **Status:** mitigated_operationally

**Severity:** P1 — blocks productive dispatch
**Hosts:** headnode

An anchor carrying sentence punctuation and an approximation marker:
`blueprint-agent.ts:~143-180, :416`. Without stripping the trailing comma and
tolerating the tilde, the strongest anchor in a real entry is dropped.

## QPI-108 — Prose that mentions the status field, and a src-relative anchor

- **Status:** fixed_headnode_laptop_pending — deployed to the headnode; the
  laptop listener restart is still pending.
- **Severity:** P2

The parser's `## Metadata` block has a `**Status:**` field; a false "present"
deletes it. That sentence is prose, not metadata, and only a line-anchored
rule keeps it out.

A path relative to a src subtree with the prefix omitted:
(`federation/status.ts:49-73`) has no case for one state.
