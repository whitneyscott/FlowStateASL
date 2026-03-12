/**
 * SPA paths by tool type for LTI launch redirects.
 * Keeps redirect targets in one place instead of inline in the controller.
 * Prompter: teachers land on /config (settings); students on /prompter (timer).
 */
export const TOOL_TYPE_SPA_PATHS: Record<'flashcards' | 'prompter', string> = {
  flashcards: '/flashcards',
  prompter: '/prompter',
};

export function getRedirectPathForToolType(
  toolType: 'flashcards' | 'prompter',
  isTeacher?: boolean
): string {
  const base = TOOL_TYPE_SPA_PATHS[toolType];
  if (toolType === 'prompter' && isTeacher) return '/config';
  return base;
}
