import {
  Entity,
  PrimaryColumn,
  Column,
} from 'typeorm';

@Entity('sprout_playlists')
export class SproutPlaylistEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 64 })
  id: string;

  @Column({ name: 'title', type: 'varchar', length: 512 })
  title: string;

  @Column({ name: 'sprout_updated_at', type: 'timestamptz', nullable: true })
  sproutUpdatedAt: Date | null;

  @Column({ name: 'synced_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  syncedAt: Date;
}
