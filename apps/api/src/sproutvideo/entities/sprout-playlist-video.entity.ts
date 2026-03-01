import {
  Entity,
  PrimaryColumn,
  Column,
} from 'typeorm';

@Entity('sprout_playlist_videos')
export class SproutPlaylistVideoEntity {
  @PrimaryColumn({ name: 'playlist_id', type: 'varchar', length: 64 })
  playlistId: string;

  @PrimaryColumn({ name: 'video_id', type: 'varchar', length: 64 })
  videoId: string;

  @Column({ name: 'position', type: 'int', default: 0 })
  position: number;

  @Column({ name: 'title', type: 'varchar', length: 512, default: 'Vocabulary Item' })
  title: string;

  @Column({ name: 'embed_code', type: 'text', nullable: true })
  embedCode: string | null;
}
