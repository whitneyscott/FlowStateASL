import {
  Entity,
  PrimaryColumn,
  Column,
} from 'typeorm';

@Entity('blocked_attempts')
export class BlockedAttemptEntity {
  @PrimaryColumn({ name: 'course_id' }) courseId: string;
  @PrimaryColumn({ name: 'resource_link_id', default: '' }) resourceLinkId: string;
  @PrimaryColumn({ name: 'fingerprint_hash' }) fingerprintHash: string;
  @Column({ name: 'attempt_count', default: 0 }) attemptCount: number;
  @Column({ name: 'blocked_at', type: 'timestamptz', default: () => 'NOW()' }) blockedAt: Date;
}
