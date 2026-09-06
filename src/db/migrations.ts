/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
// ─── Database Migrations ───────────────────────────────────────────
// Versioned schema definitions using PRAGMA user_version.
// Each migration runs in a transaction and increments the version.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseInstance = any;

export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseInstance) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description:
      "Initial schema — task status, sessions, dispatch jobs, verified, checkpoints, prep cache, queue",
    up(db) {
      db.exec(`
        CREATE TABLE task_status (
          task_id         TEXT PRIMARY KEY,
          status          TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          updated_by      TEXT NOT NULL DEFAULT 'system',
          previous_status TEXT
        );

        CREATE TABLE sessions (
          session_id      TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          project         TEXT NOT NULL,
          title           TEXT,
          start_time      TEXT NOT NULL,
          status          TEXT NOT NULL,
          outcome         TEXT,
          total_cost_usd  REAL,
          duration_ms     INTEGER,
          turns_used      INTEGER
        );
        CREATE INDEX idx_sessions_task ON sessions(task_id);
        CREATE INDEX idx_sessions_status ON sessions(status);

        CREATE TABLE dispatch_jobs (
          task_id         TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL,
          pid             INTEGER NOT NULL,
          started_at      TEXT NOT NULL,
          status          TEXT NOT NULL,
          exit_code       INTEGER,
          worktree_path   TEXT,
          container_id    TEXT,
          key_id          TEXT,
          output_tail     TEXT
        );

        CREATE TABLE verified (
          task_id         TEXT PRIMARY KEY,
          verified_at     TEXT NOT NULL,
          commit_sha      TEXT NOT NULL,
          method          TEXT NOT NULL,
          verdict         TEXT NOT NULL,
          criteria_checked INTEGER NOT NULL,
          criteria_passed  INTEGER NOT NULL,
          notes           TEXT
        );

        CREATE TABLE checkpoints (
          task_id         TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL,
          completed_stages TEXT NOT NULL,
          branch_name     TEXT,
          total_cost_usd  REAL DEFAULT 0,
          retries_used    INTEGER DEFAULT 0,
          started_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          parent_task_id  TEXT,
          shared_branch   TEXT,
          agent_result    TEXT,
          judge_result    TEXT,
          gate_result     TEXT
        );

        CREATE TABLE prep_cache (
          task_id         TEXT PRIMARY KEY,
          prepared_at     TEXT NOT NULL,
          schema_valid    INTEGER NOT NULL,
          depth_score     REAL NOT NULL,
          depth_ready     INTEGER NOT NULL,
          deficiencies    TEXT DEFAULT '[]',
          outcome         TEXT NOT NULL,
          content_hash    TEXT,
          stale           INTEGER DEFAULT 0,
          preflight_data  TEXT
        );

        CREATE TABLE queue_items (
          task_id         TEXT PRIMARY KEY,
          status          TEXT NOT NULL,
          priority        INTEGER NOT NULL,
          blocked_by      TEXT DEFAULT '[]',
          enqueued_at     TEXT NOT NULL,
          started_at      TEXT,
          completed_at    TEXT,
          outcome         TEXT,
          cost_usd        REAL,
          duration_ms     INTEGER,
          retry_count     INTEGER DEFAULT 0,
          error           TEXT,
          dispatch_options TEXT
        );
      `);
    },
  },
  {
    version: 2,
    description: "Add verified.updated_at cursor for federation sync",
    up(db) {
      const columns = db.prepare("PRAGMA table_info(verified)").all() as Array<{ name?: string }>;
      const hasUpdatedAt = columns.some((column) => column.name === "updated_at");
      if (!hasUpdatedAt) {
        db.exec("ALTER TABLE verified ADD COLUMN updated_at TEXT");
      }
      db.exec(`
        UPDATE verified
        SET updated_at = COALESCE(updated_at, verified_at)
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_verified_updated_at ON verified(updated_at)");
    },
  },
  {
    version: 3,
    description: "Add canonical readiness snapshots and effective spec persistence",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS readiness_snapshots (
          task_id             TEXT NOT NULL,
          spec_hash           TEXT NOT NULL,
          base_spec_hash      TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          schema_valid        INTEGER NOT NULL,
          schema_errors       TEXT DEFAULT '[]',
          depth_score         REAL NOT NULL,
          depth_ready         INTEGER NOT NULL,
          deficiencies        TEXT DEFAULT '[]',
          outcome             TEXT NOT NULL,
          prep_data           TEXT,
          preflight_data      TEXT,
          effective_spec_data TEXT,
          stale_reason        TEXT,
          source              TEXT,
          generator_version   TEXT,
          PRIMARY KEY (task_id, spec_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_readiness_snapshots_task_updated
          ON readiness_snapshots(task_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_readiness_snapshots_base_hash
          ON readiness_snapshots(base_spec_hash);

        CREATE TABLE IF NOT EXISTS effective_specs (
          task_id             TEXT NOT NULL,
          base_spec_hash      TEXT NOT NULL,
          effective_spec_hash TEXT NOT NULL,
          status              TEXT NOT NULL,
          content             TEXT NOT NULL,
          deficiencies        TEXT DEFAULT '[]',
          source              TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          PRIMARY KEY (task_id, base_spec_hash, effective_spec_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_effective_specs_task_updated
          ON effective_specs(task_id, updated_at DESC);
      `);

      type LegacyPrepRow = {
        task_id: string;
        prepared_at: string;
        schema_valid: number;
        depth_score: number;
        depth_ready: number;
        deficiencies: string | null;
        outcome: string;
        content_hash: string | null;
        stale: number;
        preflight_data: string | null;
      };

      const legacyRows = db.prepare("SELECT * FROM prep_cache").all() as LegacyPrepRow[];
      const insertSnapshot = db.prepare(`
        INSERT OR IGNORE INTO readiness_snapshots (
          task_id,
          spec_hash,
          base_spec_hash,
          created_at,
          updated_at,
          schema_valid,
          schema_errors,
          depth_score,
          depth_ready,
          deficiencies,
          outcome,
          prep_data,
          preflight_data,
          effective_spec_data,
          stale_reason,
          source,
          generator_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of legacyRows) {
        let parsedDeficiencies: string[] = [];
        try {
          const parsed = JSON.parse(row.deficiencies ?? "[]");
          if (Array.isArray(parsed)) {
            parsedDeficiencies = parsed.filter(
              (value): value is string => typeof value === "string",
            );
          }
        } catch {
          parsedDeficiencies = [];
        }

        const specHash = row.content_hash ?? `legacy:${row.task_id}:${row.prepared_at}`;
        const prepData = JSON.stringify({
          taskId: row.task_id,
          preparedAt: row.prepared_at,
          schemaValid: row.schema_valid === 1,
          schemaErrors: [],
          depthScore: row.depth_score,
          depthReady: row.depth_ready === 1,
          deficiencies: parsedDeficiencies,
          outcome: row.outcome,
          stale: row.stale === 1,
          contentHash: row.content_hash ?? undefined,
        });

        insertSnapshot.run(
          row.task_id,
          specHash,
          row.content_hash,
          row.prepared_at,
          row.prepared_at,
          row.schema_valid,
          "[]",
          row.depth_score,
          row.depth_ready,
          JSON.stringify(parsedDeficiencies),
          row.outcome,
          prepData,
          row.preflight_data,
          null,
          row.stale === 1 ? "legacy_stale_flag" : null,
          "legacy_prep_cache",
          "migration-v3",
        );
      }
    },
  },
  {
    version: 4,
    description: "Add effective_specs.commit_sha for TASK-922 auto-enrichment commit audit trail",
    up(db) {
      const columns = db.prepare("PRAGMA table_info(effective_specs)").all() as Array<{
        name?: string;
      }>;
      const hasCommitSha = columns.some((column) => column.name === "commit_sha");
      if (!hasCommitSha) {
        db.exec("ALTER TABLE effective_specs ADD COLUMN commit_sha TEXT");
      }
    },
  },
  {
    version: 5,
    description:
      "Add coordination_messages table for agent-to-agent coordination broker (TASK-926)",
    up(db) {
      db.exec(`
        CREATE TABLE coordination_messages (
          message_id    TEXT PRIMARY KEY,
          topic_id      TEXT,
          parent_id     TEXT,
          pair_id       TEXT NOT NULL,
          from_id       TEXT NOT NULL,
          to_id         TEXT NOT NULL,
          kind          TEXT NOT NULL,
          subject       TEXT,
          body          TEXT NOT NULL,
          context_json  TEXT,
          status        TEXT NOT NULL DEFAULT 'unread',
          posted_at     TEXT NOT NULL,
          ack_at        TEXT,
          reply_id      TEXT
        );
        CREATE INDEX idx_coord_pair_status ON coordination_messages(pair_id, status);
        CREATE INDEX idx_coord_to_status ON coordination_messages(to_id, status);
        CREATE INDEX idx_coord_topic ON coordination_messages(topic_id);
        CREATE INDEX idx_coord_posted ON coordination_messages(posted_at);
      `);
    },
  },
  {
    version: 6,
    description:
      "Add verified_history: an append-only record of every verification write (TASK-1321, P2-5 follow-up)",
    up(db) {
      // WHY THIS EXISTS. `verified` keys on `task_id` and its writer uses
      // ON CONFLICT(task_id) DO UPDATE, so it holds only the LATEST
      // verdict. The design doc called it an append-only audit ledger; it
      // never was. A re-verification silently destroyed the prior verdict,
      // so there was no way to see that a task was VERIFIED and later
      // re-verified differently, which is exactly the thing an audit
      // trail exists to show.
      //
      // `verified` stays as-is and remains the fast latest-verdict
      // lookup, so no reader changes and nothing can break. This table is
      // purely additive and starts empty: history that was already
      // overwritten is gone and CANNOT be reconstructed, which is worth
      // stating plainly rather than implying a backfill is possible.
      db.exec(`
        CREATE TABLE verified_history (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id          TEXT NOT NULL,
          verified_at      TEXT NOT NULL,
          recorded_at      TEXT NOT NULL,
          commit_sha       TEXT NOT NULL,
          method           TEXT NOT NULL,
          verdict          TEXT NOT NULL,
          criteria_checked INTEGER NOT NULL,
          criteria_passed  INTEGER NOT NULL,
          notes            TEXT,
          /* The verdict this write REPLACED, or NULL on the first write
             for a task. Stored rather than derived so a reader can see a
             transition without walking the whole history. */
          previous_verdict TEXT
        );
        CREATE INDEX idx_verified_history_task ON verified_history(task_id, id);
      `);
    },
  },
];

/**
 * Run all pending migrations. Each migration is wrapped in a transaction.
 * Uses PRAGMA user_version to track the current schema version.
 */
export function runMigrations(db: DatabaseInstance): number {
  const currentVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  let applied = 0;

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    const runMigration = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    runMigration();
    applied++;
  }

  return applied;
}
