import {
  Entity,
  PrimaryColumn,
  Column,
} from 'typeorm';

@Entity('student_resets')
export class StudentResetEntity {
  @PrimaryColumn({ name: 'course_id' }) courseId: string;
  @PrimaryColumn({ name: 'assignment_id' }) assignmentId: string;
  @PrimaryColumn({ name: 'user_id' }) userId: string;
  @Column({ name: 'reset_at', type: 'timestamptz' }) resetAt: Date;
}
