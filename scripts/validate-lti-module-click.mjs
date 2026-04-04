#!/usr/bin/env node
/**
 * Standard local Canvas click validator for an LTI module item.
 *
 * What it does:
 * 1) Creates a deterministic local Canvas user password + fresh API token.
 * 2) Creates/updates a module ExternalTool item via debug endpoint (optional).
 * 3) Logs into local Canvas as that user.
 * 4) Opens the module item URL and replays the hidden OIDC form post.
 * 5) Prints one clear outcome:
 *    - PROMPTER_OPENED (final frontend URL), or
 *    - CLICK_ERROR with exact user-visible text snippet.
 *
 * Run:
 *   node scripts/validate-lti-module-click.mjs
 *   node scripts/validate-lti-module-click.mjs --moduleItemId=785
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaults = {
  apiBase: 'http://localhost:3000',
  canvasBase: 'http://localhost',
  frontendBase: 'http://localhost:4200',
  courseId: '1',
  moduleName: 'ASL Click Validation Lab',
  assignmentName: `Click Validation ${new Date().toISOString().slice(0, 19)}`,
  canvasEmail: 'whitneyscottasl@gmail.com',
  canvasPassword: 'LocalDevPass!123',
};

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split('=');
    if (k) out[k] = (v ?? 'true').trim();
  }
  return out;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 25 * 1024 * 1024,
    ...options,
  });
}

function runCurl(args) {
  return run('curl.exe', args);
}

function ensureLocalCanvasToken(email, password) {
  const ruby = [
    'u = User.find(1)',
    'p = u.pseudonyms.active.first || u.pseudonyms.first',
    'raise "No pseudonym for user 1" unless p',
    `p.unique_id = "${email}"`,
    `p.password = "${password}"`,
    `p.password_confirmation = "${password}"`,
    'p.workflow_state = "active" if p.respond_to?(:workflow_state) && p.workflow_state != "active"',
    'p.save!',
    't = u.access_tokens.create!(purpose: "LtiClickValidator", workflow_state: "active")',
    'puts({ user_id: u.id, login: p.unique_id, token: t.full_token }.to_json)',
  ].join('\n');
  const b64 = Buffer.from(ruby, 'utf8').toString('base64');
  const output = run('wsl', [
    'docker',
    'exec',
    'canvas-web-1',
    'bash',
    '-lc',
    `echo ${b64} | base64 -d > /tmp/lti_click_token.rb && cd /usr/src/app && bundle exec rails runner /tmp/lti_click_token.rb`,
  ]);
  const jsonLine = output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.startsWith('{') && s.endsWith('}'));
  if (!jsonLine) throw new Error(`Unable to parse token creation output: ${output.slice(0, 300)}`);
  return JSON.parse(jsonLine);
}

function ensureApiUp(apiBase) {
  const ping = runCurl(['-s', '-o', 'NUL', '-w', '%{http_code}', `${apiBase}/api/debug/ping`]).trim();
  if (ping !== '200') {
    throw new Error(`API not reachable at ${apiBase} (status=${ping}). Start dev server first.`);
  }
}

function createModuleItemViaExperiment(apiBase, token, courseId, moduleName, assignmentName) {
  const payload = JSON.stringify({
    courseId,
    moduleName,
    assignmentName,
    domainOverride: 'http://localhost',
    canvasToken: token,
    clearLogFirst: true,
    variants: ['content_id_only'],
  });
  const response = runCurl([
    '-s',
    '-X',
    'POST',
    `${apiBase}/api/debug/lti-link-experiment`,
    '-H',
    'Content-Type: application/json',
    '--data-raw',
    payload,
  ]);
  const data = JSON.parse(response);
  const result = data?.results?.[0];
  if (!result?.moduleItemId) {
    throw new Error(`Experiment did not return moduleItemId: ${response.slice(0, 300)}`);
  }
  return {
    moduleItemId: String(result.moduleItemId),
    assignmentId: String(data.assignmentId ?? ''),
    moduleId: String(data.moduleId ?? ''),
  };
}

function canvasLogin(canvasBase, email, password, cookieFile) {
  const loginHtml = runCurl(['-s', '-c', cookieFile, `${canvasBase}/login/canvas`]);
  const tokenMatch = loginHtml.match(/name="authenticity_token" value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Unable to parse Canvas authenticity_token');
  const authToken = tokenMatch[1];
  const loginResp = runCurl([
    '-s',
    '-i',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-X',
    'POST',
    `${canvasBase}/login/canvas`,
    '--data-urlencode',
    'utf8=✓',
    '--data-urlencode',
    `authenticity_token=${authToken}`,
    '--data-urlencode',
    `pseudonym_session[unique_id]=${email}`,
    '--data-urlencode',
    `pseudonym_session[password]=${password}`,
    '--data-urlencode',
    'pseudonym_session[remember_me]=1',
    '--data-urlencode',
    'commit=Log In',
  ]);
  const ok = /HTTP\/1\.1 302/.test(loginResp) && /login_success=1|Location:\s+\/\s*$/im.test(loginResp);
  if (!ok) {
    throw new Error(`Canvas login failed. Response head:\n${loginResp.split(/\r?\n/).slice(0, 25).join('\n')}`);
  }
}

function clickAndReplay(canvasBase, courseId, moduleItemId, cookieFile, frontendBase) {
  const clickUrl = `${canvasBase}/courses/${courseId}/modules/items/${moduleItemId}`;
  const firstPage = runCurl([
    '-s',
    '-L',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-w',
    '\nEFFECTIVE_URL=%{url_effective}\nHTTP_CODE=%{http_code}\n',
    clickUrl,
  ]);

  const formActionMatch = firstPage.match(/<form[^>]*action="([^"]+)"/i);
  if (!formActionMatch) {
    const err = extractError(firstPage);
    return {
      opened: false,
      finalUrl: extractMetric(firstPage, 'EFFECTIVE_URL'),
      message: err || `No launch form found on module item page (title="${extractTitle(firstPage)}").`,
    };
  }

  const formAction = formActionMatch[1];
  const hiddenInputs = [...firstPage.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)];
  const postArgs = [
    '-s',
    '-L',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-w',
    '\nEFFECTIVE_URL=%{url_effective}\nHTTP_CODE=%{http_code}\n',
    formAction,
  ];
  for (const m of hiddenInputs) {
    postArgs.push('--data-urlencode', `${m[1]}=${m[2]}`);
  }

  let launchPage = runCurl(postArgs);
  launchPage = followAutoSubmitForms(launchPage, cookieFile, frontendBase);
  const finalUrl = extractMetric(launchPage, 'EFFECTIVE_URL');
  const opened = finalUrl.startsWith(`${frontendBase}/prompter`) || finalUrl.startsWith(`${frontendBase}/config`);
  const err = extractError(launchPage);
  const title = extractTitle(launchPage);
  if (!opened && /\/api\/lti\/authorize/i.test(finalUrl)) {
    let detail = '';
    try {
      const raw = runCurl(['-s', '-L', finalUrl]).trim();
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.message === 'string') {
        detail = parsed.message.trim();
      }
    } catch {
      // no-op; keep generic fallback below
    }
    return {
      opened: false,
      finalUrl,
      message: detail
        ? `Launch stopped at Canvas authorize endpoint: ${detail}`
        : `Launch stopped at Canvas authorize endpoint (title="${title || 'unknown'}").`,
    };
  }
  return {
    opened,
    finalUrl,
    message: opened ? '' : err || `No explicit error text found (title="${title || 'unknown'}").`,
  };
}

function followAutoSubmitForms(page, cookieFile, frontendBase) {
  let current = page;
  for (let i = 0; i < 4; i += 1) {
    const actionMatch = current.match(/<form[^>]*action="([^"]+)"/i);
    if (!actionMatch) return current;
    const methodMatch = current.match(/<form[^>]*method="([^"]+)"/i);
    const method = (methodMatch ? methodMatch[1] : 'get').toLowerCase();
    let action = actionMatch[1];
    const baseUrl = extractMetric(current, 'EFFECTIVE_URL');
    if (!baseUrl) return current;
    const base = new URL(baseUrl);
    if (!/^https?:\/\//i.test(action)) {
      action = action.startsWith('/') ? `${base.protocol}//${base.host}${action}` : `${base.protocol}//${base.host}/${action}`;
    }

    const inputs = [...current.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)];
    if (inputs.length === 0) return current;

    if (method === 'get') {
      const u = new URL(action);
      for (const m of inputs) u.searchParams.set(m[1], m[2]);
      current = runCurl([
        '-s',
        '-L',
        '-b',
        cookieFile,
        '-c',
        cookieFile,
        '-w',
        '\nEFFECTIVE_URL=%{url_effective}\nHTTP_CODE=%{http_code}\n',
        u.toString(),
      ]);
    } else {
      const args = [
        '-s',
        '-L',
        '-b',
        cookieFile,
        '-c',
        cookieFile,
        '-w',
        '\nEFFECTIVE_URL=%{url_effective}\nHTTP_CODE=%{http_code}\n',
        action,
      ];
      for (const m of inputs) {
        args.push('--data-urlencode', `${m[1]}=${m[2]}`);
      }
      current = runCurl(args);
    }

    const moved = extractMetric(current, 'EFFECTIVE_URL');
    if (moved.startsWith(`${frontendBase}/prompter`) || moved.startsWith(`${frontendBase}/config`)) {
      return current;
    }
  }
  return current;
}

function extractMetric(text, key) {
  const match = text.match(new RegExp(`${key}=([^\\r\\n]+)`));
  return match ? match[1].trim() : '';
}

function extractError(html) {
  const patterns = [
    /could not find a valid link[^<]*/i,
    /valid setting[^<]*/i,
    /there was a problem[^<]*/i,
    /this tool was successfully loaded[^<]*/i,
    /launch[^<]*failed[^<]*/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function main() {
  const args = parseArgs();
  const cfg = {
    ...defaults,
    ...args,
  };

  console.log('LTI_CLICK_VALIDATOR start');
  ensureApiUp(cfg.apiBase);

  const tokenInfo = ensureLocalCanvasToken(cfg.canvasEmail, cfg.canvasPassword);
  const masked = `${tokenInfo.token.slice(0, 6)}...${tokenInfo.token.slice(-6)}`;
  console.log(`TOKEN_CREATED user=${tokenInfo.login} token=${masked}`);

  let moduleItemId = args.moduleItemId ? String(args.moduleItemId) : '';
  if (!moduleItemId) {
    const created = createModuleItemViaExperiment(
      cfg.apiBase,
      tokenInfo.token,
      String(cfg.courseId),
      cfg.moduleName,
      cfg.assignmentName,
    );
    moduleItemId = created.moduleItemId;
    console.log(`MODULE_ITEM_READY courseId=${cfg.courseId} moduleId=${created.moduleId} assignmentId=${created.assignmentId} moduleItemId=${moduleItemId}`);
  } else {
    console.log(`MODULE_ITEM_TARGET moduleItemId=${moduleItemId}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'lti-click-'));
  const cookieFile = join(tmp, 'canvas.cookies.txt');
  writeFileSync(cookieFile, '', 'utf8');

  canvasLogin(cfg.canvasBase, tokenInfo.login, cfg.canvasPassword, cookieFile);
  console.log('CANVAS_LOGIN_OK');

  const result = clickAndReplay(
    cfg.canvasBase,
    String(cfg.courseId),
    moduleItemId,
    cookieFile,
    cfg.frontendBase,
  );

  if (result.opened) {
    console.log(`PROMPTER_OPENED finalUrl=${result.finalUrl}`);
    process.exit(0);
  }

  console.log(`CLICK_ERROR finalUrl=${result.finalUrl}`);
  console.log(`CLICK_ERROR_MESSAGE ${result.message}`);
  process.exit(2);
}

try {
  main();
} catch (err) {
  console.error(`VALIDATOR_FAILED ${(err && err.message) ? err.message : String(err)}`);
  process.exit(1);
}
