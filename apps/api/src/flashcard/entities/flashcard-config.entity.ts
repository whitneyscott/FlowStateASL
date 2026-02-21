import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('flashcard_configs')
export class FlashcardConfigEntity {
  @PrimaryColumn({ name: 'course_id' }) courseId: string;
  @PrimaryColumn({ name: 'resource_link_id' }) resourceLinkId: string;
  @Column({ name: 'curriculum', type: 'varchar', length: 64 }) curriculum: string;
  @Column({ name: 'unit', type: 'varchar', length: 64 }) unit: string;
  @Column({ name: 'section', type: 'varchar', length: 64 }) section: string;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
