import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSproutPlaylistVideoDuration1739200000000 implements MigrationInterface {
  name = 'AddSproutPlaylistVideoDuration1739200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sprout_playlist_videos
      ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sprout_playlist_videos
      DROP COLUMN IF EXISTS duration_seconds
    `);
  }
}
