import { MigrationInterface, QueryRunner } from 'typeorm';

/** Removes disposable-token table; video proxy no longer uses DB grants. */
export class DropVideoProxyGrantTable1741100000000 implements MigrationInterface {
  name = 'DropVideoProxyGrantTable1741100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS video_proxy_grant`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS video_proxy_grant (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        token_hash varchar(64) NOT NULL,
        target_url text NOT NULL,
        course_id varchar(255) NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_video_proxy_grant" PRIMARY KEY (id),
        CONSTRAINT "UQ_video_proxy_grant_token_hash" UNIQUE (token_hash)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_video_proxy_grant_expires_at" ON video_proxy_grant (expires_at)
    `);
  }
}
