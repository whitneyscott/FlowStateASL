import { MigrationInterface, QueryRunner } from 'typeorm';

export class PromptSubmissionCaptions1742000000000 implements MigrationInterface {
  name = 'PromptSubmissionCaptions1742000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS prompt_submission_captions`);
  }
}
