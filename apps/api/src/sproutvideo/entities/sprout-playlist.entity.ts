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

  @Column({ name: 'curriculum', type: 'varchar', length: 64 })
  curriculum: string;

  @Column({ name: 'unit', type: 'varchar', length: 64 })
  unit: string;

  @Column({ name: 'section', type: 'varchar', length: 64 })
  section: string;

  @Column({ name: 'deck_title', type: 'varchar', length: 512 })
  deckTitle: string;

  @Column({ name: 'sprout_updated_at', type: 'timestamptz', nullable: true })
  sproutUpdatedAt: Date | null;

  @Column({ name: 'synced_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  syncedAt: Date;
}
