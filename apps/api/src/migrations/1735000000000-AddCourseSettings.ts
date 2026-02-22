import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCourseSettings1735000000000 implements MigrationInterface {
  name = 'AddCourseSettings1735000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE course_settings (
        course_id TEXT NOT NULL PRIMARY KEY,
        selected_curriculums JSONB NOT NULL DEFAULT '[]',
        selected_units JSONB NOT NULL DEFAULT '[]',
        progress_assignment_id VARCHAR(64),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS course_settings`);
  }
}
