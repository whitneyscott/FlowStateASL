/**
 * Renders an HTML debug page (like PHP echo) for troubleshooting LTI and routing issues.
 * Shown in-browser instead of JSON so users see useful info.
 */
export function renderDebugPage(info: Record<string, unknown>): string {
  const rows = Object.entries(info)
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td><pre>${escapeHtml(String(v))}</pre></td></tr>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html>
<head><title>ASL Express Debug</title>
<style>body{font-family:sans-serif;margin:2em;background:#f5f5f5} table{border-collapse:collapse;background:white;box-shadow:0 1px 3px rgba(0,0,0,.1)} th,td{border:1px solid #ddd;padding:8px 12px;text-align:left;vertical-align:top} th{width:180px;background:#eee} pre{margin:0;white-space:pre-wrap;word-break:break-all} h1{color:#333} .error{color:#c00}</style>
</head>
<body>
<h1>ASL Express Debug</h1>
<p class="error"><strong>An error occurred. Debug info below:</strong></p>
<table>${rows}</table>
<p><em>This page is for troubleshooting. Remove or disable debug in production.</em></p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
