import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSproutPlaylistColumns1739000000000 implements MigrationInterface {
  name = 'AddSproutPlaylistColumns1739000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sprout_playlists ADD COLUMN IF NOT EXISTS curriculum VARCHAR(64)`);
    await queryRunner.query(`ALTER TABLE sprout_playlists ADD COLUMN IF NOT EXISTS unit VARCHAR(64)`);
    await queryRunner.query(`ALTER TABLE sprout_playlists ADD COLUMN IF NOT EXISTS section VARCHAR(64)`);
    await queryRunner.query(`ALTER TABLE sprout_playlists ADD COLUMN IF NOT EXISTS deck_title VARCHAR(512)`);

    await queryRunner.query(`
      UPDATE sprout_playlists
      SET
        curriculum = TRIM(SPLIT_PART(title, '.', 1)),
        unit = TRIM(SPLIT_PART(title, '.', 2)),
        section = TRIM(SPLIT_PART(title, '.', 3)),
        deck_title = COALESCE(
          NULLIF(TRIM(array_to_string((string_to_array(title, '.'))[4:], '.')), ''),
          title
        )
      WHERE title IS NOT NULL
        AND (string_to_array(title, '.'))[1] IS NOT NULL
        AND (string_to_array(title, '.'))[2] IS NOT NULL
        AND (string_to_array(title, '.'))[3] IS NOT NULL
    `);

    await queryRunner.query(`
      UPDATE sprout_playlists
      SET
        curriculum = COALESCE(NULLIF(TRIM(curriculum), ''), 'unknown'),
        unit = COALESCE(NULLIF(TRIM(unit), ''), ''),
        section = COALESCE(NULLIF(TRIM(section), ''), ''),
        deck_title = COALESCE(NULLIF(TRIM(deck_title), ''), title)
      WHERE curriculum IS NULL OR unit IS NULL OR section IS NULL OR deck_title IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE sprout_playlists
      ALTER COLUMN curriculum SET NOT NULL,
      ALTER COLUMN unit SET NOT NULL,
      ALTER COLUMN section SET NOT NULL,
      ALTER COLUMN deck_title SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sprout_playlists_curriculum
      ON sprout_playlists (curriculum)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sprout_playlists_curriculum_unit
      ON sprout_playlists (curriculum, unit)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sprout_playlists_curriculum_unit_section
      ON sprout_playlists (curriculum, unit, section)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sprout_playlists_curriculum_unit_section`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sprout_playlists_curriculum_unit`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sprout_playlists_curriculum`);
    await queryRunner.query(`
      ALTER TABLE sprout_playlists
      DROP COLUMN IF EXISTS curriculum,
      DROP COLUMN IF EXISTS unit,
      DROP COLUMN IF EXISTS section,
      DROP COLUMN IF EXISTS deck_title
    `);
  }
}
