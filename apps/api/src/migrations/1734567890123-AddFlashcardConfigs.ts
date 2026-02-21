import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFlashcardConfigs1734567890123 implements MigrationInterface {
  name = 'AddFlashcardConfigs1734567890123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE flashcard_configs (
        course_id TEXT NOT NULL,
        resource_link_id TEXT NOT NULL,
        curriculum VARCHAR(64) NOT NULL,
        unit VARCHAR(64) NOT NULL,
        section VARCHAR(64) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (course_id, resource_link_id)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS flashcard_configs`);
  }
}
