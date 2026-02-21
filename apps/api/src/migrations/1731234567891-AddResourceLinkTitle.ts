import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResourceLinkTitle1731234567891 implements MigrationInterface {
  name = 'AddResourceLinkTitle1731234567891';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE prompt_configs ADD COLUMN IF NOT EXISTS resource_link_title TEXT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE prompt_configs DROP COLUMN IF EXISTS resource_link_title`,
    );
  }
}
