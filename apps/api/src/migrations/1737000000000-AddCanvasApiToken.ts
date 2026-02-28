import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCanvasApiToken1737000000000 implements MigrationInterface {
  name = 'AddCanvasApiToken1737000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "course_settings"
      ADD COLUMN IF NOT EXISTS "canvas_api_token" varchar(256) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "course_settings"
      DROP COLUMN IF EXISTS "canvas_api_token"
    `);
  }
}
