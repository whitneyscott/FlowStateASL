import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('auth_sessions')
export class AuthSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 128, unique: true })
  tokenHash: string;

  @Column({ name: 'nonce_hash', type: 'varchar', length: 128, nullable: true, unique: true })
  nonceHash: string | null;

  @Column({ name: 'nonce_expires_at', type: 'timestamptz', nullable: true })
  nonceExpiresAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'course_id', type: 'varchar', length: 128 })
  courseId: string;

  @Column({ name: 'canvas_user_id', type: 'varchar', length: 128 })
  canvasUserId: string;

  @Column({ name: 'resource_link_id', type: 'varchar', length: 255, default: '' })
  resourceLinkId: string;

  @Column({ name: 'canonical_key', type: 'varchar', length: 512 })
  canonicalKey: string;

  @Column({ name: 'lti_launch_type', type: 'varchar', length: 8, default: '1.1' })
  ltiLaunchType: '1.1' | '1.3';

  @Column({ name: 'canvas_access_token', type: 'text', nullable: true })
  canvasAccessToken: string | null;

  @Column({ name: 'lti_context', type: 'jsonb' })
  ltiContext: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
