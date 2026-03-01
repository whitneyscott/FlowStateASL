import {
  Entity,
  PrimaryColumn,
  Column,
} from 'typeorm';

@Entity('sync_metadata')
export class SyncMetadataEntity {
  @PrimaryColumn({ name: 'key', type: 'varchar', length: 64 })
  key: string;

  @Column({ name: 'value', type: 'varchar', length: 256 })
  value: string;
}
