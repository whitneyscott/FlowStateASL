export class AddCommentDto {
  userId: string;
  time: number;
  text: string;
  attempt?: number;
}

export class EditCommentDto {
  commentId: string;
  userId: string;
  time: number;
  text: string;
}

export class DeleteCommentDto {
  commentId: string;
  userId: string;
}
