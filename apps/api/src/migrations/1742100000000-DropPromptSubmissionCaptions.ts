import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sign-to-voice now uses Canvas media_tracks only; captions are no longer stored in app DB. */
export class DropPromptSubmissionCaptions1742100000000 implements MigrationInterface {
  name = 'DropPromptSubmissionCaptions1742100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_prompt_submission_captions_status`);
    await queryRunner.query(`DROP TABLE IF EXISTS prompt_submission_captions`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE prompt_submission_captions (
        course_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        captions_status VARCHAR(16) NOT NULL,
        vtt_text TEXT,
        error_message TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, assignment_id, user_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_prompt_submission_captions_status
      ON prompt_submission_captions (course_id, assignment_id, captions_status)
    `);
  }
}
