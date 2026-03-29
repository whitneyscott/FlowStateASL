/**
 * Canvas OAuth2 `scope` query param (space-separated). Required when the Developer Key
 * has "Enforce Scopes" enabled; otherwise the token may lack permission for REST calls
 * (403 "user not authorized" on assignment_groups, announcements, etc.).
 *
 * Override with env `CANVAS_OAUTH_SCOPES` (space-separated). Disable with `CANVAS_OAUTH_SCOPE_MODE=off`.
 *
 * Add more scopes in Canvas Admin → Developer Keys → your key, then mirror them in
 * `CANVAS_OAUTH_SCOPES` if you use features beyond flashcards / course settings / prompter basics.
 *
 * @see https://canvas.instructure.com/doc/api/api_token_scopes.html
 */
export const DEFAULT_CANVAS_OAUTH_SCOPES = [
  'url:GET|/api/v1/users/self',
  'url:GET|/api/v1/courses/:course_id/assignment_groups',
  'url:POST|/api/v1/courses/:course_id/assignment_groups',
  'url:GET|/api/v1/courses/:course_id/assignments',
  'url:GET|/api/v1/courses/:course_id/assignments/:id',
  'url:POST|/api/v1/courses/:course_id/assignments',
  'url:PUT|/api/v1/courses/:course_id/assignments/:id',
  'url:GET|/api/v1/courses/:course_id/discussion_topics',
  'url:POST|/api/v1/courses/:course_id/discussion_topics',
  'url:PUT|/api/v1/courses/:course_id/discussion_topics/:topic_id',
  'url:POST|/api/v1/users/self/files',
  'url:GET|/api/v1/courses/:course_id/assignments/:assignment_id/submissions',
  'url:POST|/api/v1/courses/:course_id/assignments/:assignment_id/submissions',
  'url:PUT|/api/v1/courses/:course_id/assignments/:assignment_id/submissions/:user_id',
  'url:GET|/api/v1/courses/:course_id/rubrics',
  'url:PUT|/api/v1/courses/:course_id/rubrics/:id',
  'url:POST|/api/v1/courses/:course_id/rubric_associations',
  'url:GET|/api/v1/courses/:course_id/modules',
  'url:POST|/api/v1/courses/:course_id/modules',
  'url:PUT|/api/v1/courses/:course_id/modules/:id',
  'url:GET|/api/v1/courses/:course_id/modules/:module_id/items',
  'url:POST|/api/v1/courses/:course_id/modules/:module_id/items',
  'url:GET|/api/v1/courses/:course_id/quizzes',
  'url:POST|/api/v1/courses/:course_id/quizzes',
].join(' ');
