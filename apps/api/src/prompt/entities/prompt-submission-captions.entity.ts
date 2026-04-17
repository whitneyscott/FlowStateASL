import { Column, Entity, PrimaryColumn } from 'typeorm';

export type PromptCaptionsStatus = 'pending' | 'ready' | 'failed';

@Entity('prompt_submission_captions')
export class PromptSubmissionCaptionsEntity {
  @PrimaryColumn({ name: 'course_id', type: 'text' })
  courseId!: string;

  @PrimaryColumn({ name: 'assignment_id', type: 'text' })
  assignmentId!: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId!: string;

  @Column({ name: 'captions_status', type: 'varchar', length: 16 })
  captionsStatus!: PromptCaptionsStatus;

  @Column({ name: 'vtt_text', type: 'text', nullable: true })
  vttText!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
