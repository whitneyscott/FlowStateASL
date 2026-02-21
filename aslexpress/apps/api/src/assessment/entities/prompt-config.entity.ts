import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('prompt_configs')
export class PromptConfigEntity {
  @PrimaryColumn({ name: 'course_id' }) courseId: string;
  @PrimaryColumn({ name: 'resource_link_id' }) resourceLinkId: string;
  @Column('text', { name: 'config_json' }) configJson: string;
  @Column('text', { name: 'resource_link_title', nullable: true }) resourceLinkTitle: string | null;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
