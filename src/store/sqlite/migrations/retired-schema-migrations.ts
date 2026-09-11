import type { SqliteContext } from "../context.js";

export class RetiredSchemaMigrations {
  constructor(private readonly context: SqliteContext) {}

  removeReportedTraexSessionColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    const obsolete = ["reported_traex_session_id", "reported_traex_session_at"].filter((name) => names.has(name));
    if (!obsolete.length) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      for (const name of obsolete) this.context.database.exec(`ALTER TABLE bindings DROP COLUMN ${name}`);
      this.context.database.exec("COMMIT");
    } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }

  convergeRetiredPromptSteering(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 30").get()) return;
    const promptColumns = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!promptColumns.has("dispatch_kind")) {
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (30)").run();
      return;
    }
    const runCardColumns = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!runCardColumns.has("steering_origin")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted'))");
    if (!runCardColumns.has("steering_failure_kind")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN steering_failure_kind TEXT CHECK(steering_failure_kind IN ('rejected','uncertain'))");
    const retiredPromptColumns = ["source_prompt_id", "steering_origin", "dispatch_kind"].filter((column) => promptColumns.has(column));
    const timestamp = now();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.prepare(`
        UPDATE prompt_jobs
        SET state = 'failed', observation_state = 'completed', was_detached = CASE state WHEN 'running' THEN 1 ELSE was_detached END,
          error = CASE state
            WHEN 'queued' THEN 'Retired steering work was rejected during upgrade and was not sent.'
            ELSE 'Retired steering delivery may already have reached Herdr; inspect the pane before retrying.'
          END, updated_at = ?
        WHERE dispatch_kind = 'steering' AND state IN ('queued','running')
      `).run(timestamp);
      this.context.database.prepare(`
        UPDATE run_cards
        SET phase = 'failed', finished_at = ?, queue_position = 0,
          notice = CASE (SELECT state FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id)
            WHEN 'failed' THEN CASE (SELECT was_detached FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id)
              WHEN 1 THEN 'Retired steering delivery may already have reached Herdr; inspect the pane before retrying.'
              ELSE 'Retired steering work was rejected during upgrade and was not sent.'
            END
            ELSE notice
          END,
          activity_at = ?, view_version = view_version + 1, updated_at = ?
        WHERE prompt_id IN (SELECT id FROM prompt_jobs WHERE dispatch_kind = 'steering' AND state = 'failed' AND updated_at = ?)
      `).run(timestamp, timestamp, timestamp, timestamp);
      this.context.database.exec(`
        DROP VIEW IF EXISTS run_cards_view;
        DROP INDEX IF EXISTS prompt_jobs_dispatch;
        DROP INDEX IF EXISTS prompt_jobs_source_prompt_once;
        DROP INDEX IF EXISTS prompt_jobs_queue_kind;
        DROP INDEX IF EXISTS prompt_jobs_priority_queue;
        ALTER TABLE run_cards DROP COLUMN steering_failure_kind;
        ALTER TABLE run_cards DROP COLUMN steering_origin;
        ${retiredPromptColumns.map((column) => `ALTER TABLE prompt_jobs DROP COLUMN ${column};`).join("\n        ")}
        CREATE INDEX prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
      `);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (30)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }
}

function now(): string { return new Date().toISOString(); }
