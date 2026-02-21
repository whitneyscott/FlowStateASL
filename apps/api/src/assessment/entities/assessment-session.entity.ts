import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('assessment_sessions')
export class AssessmentSessionEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'course_id' }) courseId: string;
  @Column({ name: 'assignment_id' }) assignmentId: string;
  @Column({ name: 'user_id' }) userId: string;
  @Column({ name: 'resource_link_id', default: '' }) resourceLinkId: string;
  @Column('text', { name: 'prompt_snapshot_html', nullable: true }) promptSnapshotHtml: string | null;
  @Column('text', { name: 'selected_cards_html', nullable: true }) selectedCardsHtml: string | null;
  @Column('simple-array', { name: 'deck_ids' }) deckIds: string[];
  @Column({ name: 'word_count', default: 0 }) wordCount: number;
  @Column({ default: 0 }) score: number;
  @Column({ name: 'score_total', default: 0 }) scoreTotal: number;
  @Column({ name: 'canvas_file_id', type: 'varchar', nullable: true }) canvasFileId: string | null;
  @Column({ name: 'upload_progress_offset', type: 'int', default: 0 }) uploadProgressOffset: number;
  @Column({
    name: 'sync_status',
    type: 'text',
    default: 'pending',
  }) syncStatus: 'pending' | 'uploading' | 'failed';
  @Column({ name: 'sync_error_message', type: 'text', nullable: true }) syncErrorMessage: string | null;
  @CreateDateColumn({ name: 'started_at' }) startedAt: Date;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date | null;
}
