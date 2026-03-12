import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPromptManagerTables1739100000000 implements MigrationInterface {
  name = 'AddPromptManagerTables1739100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE assignment_prompts (
        course_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        resource_link_id TEXT NOT NULL DEFAULT '',
        prompt_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, assignment_id, user_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE student_resets (
        course_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, assignment_id, user_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS student_resets`);
    await queryRunner.query(`DROP TABLE IF EXISTS assignment_prompts`);
  }
}
