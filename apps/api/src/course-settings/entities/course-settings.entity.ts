import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('course_settings')
export class CourseSettingsEntity {
  @PrimaryColumn({ name: 'course_id' }) courseId: string;
  @Column({ name: 'selected_curriculums', type: 'jsonb', default: '[]' })
  selectedCurriculums: string[];
  @Column({ name: 'selected_units', type: 'jsonb', default: '[]' })
  selectedUnits: string[];
  @Column({ name: 'progress_assignment_id', type: 'varchar', length: 64, nullable: true })
  progressAssignmentId: string | null;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
