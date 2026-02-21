export interface BlockedAttempt {
  courseId: string;
  resourceLinkId: string;
  fingerprintHash: string;
  attemptCount: number;
  blockedAt: Date;
}

export interface IAssessmentRepository {
  getBlockedAttempt(
    courseId: string,
    resourceLinkId: string,
    fingerprintHash: string
  ): Promise<BlockedAttempt | null>;
  recordAttempt(
    courseId: string,
    resourceLinkId: string,
    fingerprintHash: string
  ): Promise<BlockedAttempt>;
  clearAttempts(courseId: string, resourceLinkId: string): Promise<void>;
  isBlocked(
    courseId: string,
    resourceLinkId: string,
    fingerprintHash: string,
    maxAttempts: number
  ): Promise<boolean>;
}
