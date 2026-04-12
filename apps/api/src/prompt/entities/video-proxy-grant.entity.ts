import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('video_proxy_grant')
export class VideoProxyGrantEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** SHA-256 hex of the opaque proxy token (raw token is never stored). */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash!: string;

  @Column({ name: 'target_url', type: 'text' })
  targetUrl!: string;

  @Column({ name: 'course_id', type: 'varchar', length: 255 })
  courseId!: string;

  @Index('IDX_video_proxy_grant_expires_at')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
