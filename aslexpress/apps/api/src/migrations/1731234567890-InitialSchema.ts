import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1731234567890 implements MigrationInterface {
  name = 'InitialSchema1731234567890';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE prompt_configs (
        course_id TEXT NOT NULL,
        resource_link_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, resource_link_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE blocked_attempts (
        course_id TEXT NOT NULL,
        resource_link_id TEXT NOT NULL DEFAULT '',
        fingerprint_hash TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, resource_link_id, fingerprint_hash)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_blocked_course_link ON blocked_attempts(course_id, resource_link_id)
    `);
    await queryRunner.query(`
      CREATE TABLE assessment_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        resource_link_id TEXT NOT NULL DEFAULT '',
        deck_ids TEXT[] NOT NULL DEFAULT '{}',
        word_count INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        score_total INTEGER NOT NULL DEFAULT 0,
        prompt_snapshot_html TEXT,
        selected_cards_html TEXT,
        canvas_file_id TEXT,
        upload_progress_offset INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','uploading','failed')),
        sync_error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        submitted_at TIMESTAMPTZ,
        UNIQUE (course_id, assignment_id, user_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sessions_failed ON assessment_sessions(course_id, user_id, sync_status) WHERE sync_status = 'failed'
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sessions_uploading ON assessment_sessions(course_id, user_id, sync_status) WHERE sync_status = 'uploading'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sessions_uploading`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sessions_failed`);
    await queryRunner.query(`DROP TABLE IF EXISTS assessment_sessions`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_blocked_course_link`);
    await queryRunner.query(`DROP TABLE IF EXISTS blocked_attempts`);
    await queryRunner.query(`DROP TABLE IF EXISTS prompt_configs`);
  }
}
