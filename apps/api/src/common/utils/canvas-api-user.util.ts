import { resolveLtiContextValue } from './lti-context-value.util';

const NUMERIC_CANVAS_ID = /^\d+$/;

/**
 * Canvas REST API user id from LTI: prefer custom Canvas user id ($Canvas.user.id / custom_canvas_user_id).
 * Do not use an opaque LTI 1.3 `sub` in submission URLs.
 * When `userId` is already numeric (typical LTI 1.1 with only custom_canvas_user_id), use it.
 */
export function resolveCanvasApiUserId(ctx: {
  userId?: string;
  canvasUserId?: string;
}): string | undefined {
  const fromCustom = resolveLtiContextValue(ctx.canvasUserId);
  if (fromCustom) return fromCustom;
  const uid = resolveLtiContextValue(ctx.userId);
  if (uid && NUMERIC_CANVAS_ID.test(uid)) return uid;
  return undefined;
}

/** Canvas file ids in submission payloads must be integers. */
export function toCanvasFileIdInt(fileId: string): number {
  const n = Number.parseInt(String(fileId).trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid Canvas file id (expected integer): ${fileId}`);
  }
  return n;
}
