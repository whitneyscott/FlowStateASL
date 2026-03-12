export class GradeDto {
  userId: string;
  score: number;
  scoreMaximum?: number;
  resultContent?: string;
  rubricAssessment?: Record<string, unknown>;
}
