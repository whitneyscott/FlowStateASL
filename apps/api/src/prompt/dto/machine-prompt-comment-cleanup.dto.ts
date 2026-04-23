export class DeleteMachinePromptCommentsDto {
  userId!: string;
  teacherConfirmed!: boolean;
  /** When omitted, all machine-prompt JSON comments on the submission are removed. */
  commentIds?: number[];
}
