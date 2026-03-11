/**
 * Renders an HTML error page for LTI launch failures.
 * Used so the error page and debug link are not hardcoded in the controller.
 */
export function renderLtiLaunchErrorHtml(
  message: string,
  options?: { frontendUrl?: string; debugPath?: string }
): string {
  const frontendUrl = options?.frontendUrl ?? '';
  const debugPath = options?.debugPath ?? '?debug=1';
  const debugLink = `${frontendUrl}${debugPath}`;
  const escaped = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><title>LTI Launch Error</title>
<style>body{font-family:sans-serif;margin:2em;background:#1a1a1a;color:#00ff88;} a{color:#00ff88;} pre{background:#000;padding:12px;border:2px solid #00ff88;}</style></head>
<body><h1>LTI Launch Error</h1><pre>${escaped}</pre>
<p><a href="${debugLink}">View Bridge Debug Log</a> — Open this link to see the LTI launch log and errors.</p></body></html>`;
}
