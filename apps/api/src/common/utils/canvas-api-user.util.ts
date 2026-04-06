import { resolveLtiContextValue } from './lti-context-value.util';

const NUMERIC_CANVAS_ID = /^\d+$/;

const LTI_NUMERIC_USER_PARAM_KEYS = [
  'custom_canvas_user_id',
  /** Canvas UI "Custom Field" named `user_id` → POST param `custom_user_id` (LTI 1.1). */
  'custom_user_id',
  'canvas_user_id',
] as const;

/**
 * Reads a numeric Canvas user id from common LTI 1.1 POST keys ($Canvas.user.id substitutions).
 */
export function resolveCanvasNumericUserIdFromLtiParams(
  body: Record<string, string | undefined>,
): string | undefined {
  for (const k of LTI_NUMERIC_USER_PARAM_KEYS) {
    const v = resolveLtiContextValue(body[k]);
    if (v && NUMERIC_CANVAS_ID.test(v)) return v;
  }
  return undefined;
}

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
