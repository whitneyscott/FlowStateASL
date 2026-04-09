import { MigrationInterface, QueryRunner } from 'typeorm';

export class CanvasApiTokenText1740000000000 implements MigrationInterface {
  name = 'CanvasApiTokenText1740000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "course_settings"
      ALTER COLUMN "canvas_api_token" TYPE text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "course_settings"
      ALTER COLUMN "canvas_api_token" TYPE varchar(256)
    `);
  }
}
