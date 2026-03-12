import {
  Entity,
  PrimaryColumn,
  Column,
} from 'typeorm';

@Entity('assignment_prompts')
export class AssignmentPromptEntity {
  @PrimaryColumn({ name: 'course_id' }) courseId: string;
  @PrimaryColumn({ name: 'assignment_id' }) assignmentId: string;
  @PrimaryColumn({ name: 'user_id' }) userId: string;
  @Column('text', { name: 'resource_link_id', default: '' }) resourceLinkId: string;
  @Column('text', { name: 'prompt_text' }) promptText: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
