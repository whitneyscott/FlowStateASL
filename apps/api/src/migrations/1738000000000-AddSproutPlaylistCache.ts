import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSproutPlaylistCache1738000000000 implements MigrationInterface {
  name = 'AddSproutPlaylistCache1738000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sync_metadata (
        key VARCHAR(64) NOT NULL,
        value VARCHAR(256) NOT NULL,
        PRIMARY KEY (key)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sprout_playlists (
        id VARCHAR(64) NOT NULL,
        title VARCHAR(512) NOT NULL,
        sprout_updated_at TIMESTAMPTZ NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sprout_playlist_videos (
        playlist_id VARCHAR(64) NOT NULL,
        video_id VARCHAR(64) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        title VARCHAR(512) NOT NULL DEFAULT 'Vocabulary Item',
        embed_code TEXT NULL,
        PRIMARY KEY (playlist_id, video_id),
        FOREIGN KEY (playlist_id) REFERENCES sprout_playlists(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sprout_playlist_videos_playlist_position
      ON sprout_playlist_videos (playlist_id, position)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sprout_playlist_videos`);
    await queryRunner.query(`DROP TABLE IF EXISTS sprout_playlists`);
    await queryRunner.query(`DROP TABLE IF EXISTS sync_metadata`);
  }
}
