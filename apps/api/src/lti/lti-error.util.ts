/**
 * Renders an HTML error page for LTI launch failures.
 * Used so the error page and app link are not hardcoded in the controller.
 */
export function renderLtiLaunchErrorHtml(
  message: string,
  options?: { frontendUrl?: string }
): string {
  const frontendUrl = (options?.frontendUrl ?? '').replace(/\/$/, '');
  const appLink = frontendUrl || '/';
  const escaped = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><title>LTI Launch Error</title>
<style>body{font-family:sans-serif;margin:2em;background:#1a1a1a;color:#00ff88;} a{color:#00ff88;} pre{background:#000;padding:12px;border:2px solid #00ff88;}</style></head>
<body><h1>LTI Launch Error</h1><pre>${escaped}</pre>
<p><a href="${appLink}">Open the application</a> — The Bridge debug log is only available in the app after <strong>Mode → Developer</strong> (password), not from this error page.</p></body></html>`;
}
