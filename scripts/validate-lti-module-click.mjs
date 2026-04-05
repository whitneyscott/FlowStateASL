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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaults = {
  apiBase: 'http://localhost:3000',
  canvasBase: 'http://localhost',
  frontendBase: 'http://localhost:4200',
  courseId: '1',
  settingsAssignmentTitle: 'Prompt Manager Settings',
  settingsAnnouncementTitle: 'ASL Express Prompt Manager Settings',
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
  const result = spawnSync('curl.exe', ['--no-fail', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 25 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (result.status !== 0 && !stdout.trim()) {
    throw new Error(`curl failed (status=${result.status ?? 'unknown'}): ${stderr.trim() || '(no stderr)'}`);
  }
  return stdout || stderr;
}

function buildSafeFormBody(matches) {
  const params = [];
  for (const m of matches) {
    const name = String(m[1] ?? '').trim();
    const value = String(m[2] ?? '');
    if (!name) continue;
    params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return params.join('&');
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
  console.log(`[clickAndReplay] Step 1: GET module item URL ${clickUrl}`);
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
  const firstEffectiveUrl = extractMetric(firstPage, 'EFFECTIVE_URL');
  const firstHttpCode = extractMetric(firstPage, 'HTTP_CODE');
  console.log(`[clickAndReplay] Step 1 result: http=${firstHttpCode || '(none)'} effectiveUrl=${firstEffectiveUrl || '(none)'} title="${extractTitle(firstPage) || 'unknown'}"`);

  const formActionMatch = firstPage.match(/<form[^>]*action="([^"]+)"/i);
  if (!formActionMatch) {
    console.log('[clickAndReplay] Step 2: no launch form detected on first page');
    const err = extractError(firstPage);
    return {
      opened: false,
      finalUrl: extractMetric(firstPage, 'EFFECTIVE_URL'),
      message: err || `No launch form found on module item page (title="${extractTitle(firstPage)}").`,
    };
  }

  const formAction = formActionMatch[1];
  const hiddenInputs = [...firstPage.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)];
  console.log(`[clickAndReplay] Step 2: found launch form action=${formAction} hiddenInputs=${hiddenInputs.length}`);
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
    '--data-raw',
    buildSafeFormBody(hiddenInputs),
  ];

  console.log('[clickAndReplay] Step 3: POST launch form');
  let launchPage = runCurl(postArgs);
  console.log(`[clickAndReplay] Step 3 result: http=${extractMetric(launchPage, 'HTTP_CODE') || '(none)'} effectiveUrl=${extractMetric(launchPage, 'EFFECTIVE_URL') || '(none)'}`);
  console.log('[clickAndReplay] Step 4: follow auto-submit forms');
  launchPage = followAutoSubmitForms(launchPage, cookieFile, frontendBase);
  const finalUrl = extractMetric(launchPage, 'EFFECTIVE_URL');
  const opened = finalUrl.startsWith(`${frontendBase}/prompter`) || finalUrl.startsWith(`${frontendBase}/config`);
  console.log(`[clickAndReplay] Step 4 result: opened=${opened} http=${extractMetric(launchPage, 'HTTP_CODE') || '(none)'} effectiveUrl=${finalUrl || '(none)'}`);
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
    console.log(`[followAutoSubmitForms] iteration=${i + 1} begin effectiveUrl=${extractMetric(current, 'EFFECTIVE_URL') || '(none)'} http=${extractMetric(current, 'HTTP_CODE') || '(none)'}`);
    const actionMatch = current.match(/<form[^>]*action="([^"]+)"/i);
    if (!actionMatch) {
      console.log(`[followAutoSubmitForms] iteration=${i + 1} stop: no form found`);
      return current;
    }
    const methodMatch = current.match(/<form[^>]*method="([^"]+)"/i);
    const method = (methodMatch ? methodMatch[1] : 'get').toLowerCase();
    let action = actionMatch[1];
    const baseUrl = extractMetric(current, 'EFFECTIVE_URL');
    if (!baseUrl) {
      console.log(`[followAutoSubmitForms] iteration=${i + 1} stop: no EFFECTIVE_URL metric`);
      return current;
    }
    const base = new URL(baseUrl);
    if (!/^https?:\/\//i.test(action)) {
      action = action.startsWith('/') ? `${base.protocol}//${base.host}${action}` : `${base.protocol}//${base.host}/${action}`;
    }

    const inputs = [...current.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)];
    if (inputs.length === 0) {
      console.log(`[followAutoSubmitForms] iteration=${i + 1} stop: form had no hidden inputs`);
      return current;
    }
    console.log(`[followAutoSubmitForms] iteration=${i + 1} posting form method=${method} action=${action} hiddenInputs=${inputs.length}`);

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
        '--data-raw',
        buildSafeFormBody(inputs),
      ];
      current = runCurl(args);
    }

    const moved = extractMetric(current, 'EFFECTIVE_URL');
    console.log(`[followAutoSubmitForms] iteration=${i + 1} result effectiveUrl=${moved || '(none)'} http=${extractMetric(current, 'HTTP_CODE') || '(none)'}`);
    if (moved.startsWith(`${frontendBase}/prompter`) || moved.startsWith(`${frontendBase}/config`)) {
      console.log(`[followAutoSubmitForms] iteration=${i + 1} stop: reached frontend URL`);
      return current;
    }
  }
  console.log('[followAutoSubmitForms] stop: reached max iterations (4)');
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

function deriveCanvasBase(args) {
  const raw =
    String(args.domainOverride ?? '').trim() ||
    String(args.canvasApiBase ?? '').trim() ||
    String(args.canvasBase ?? '').trim() ||
    String(process.env.CANVAS_API_BASE_URL ?? '').trim() ||
    defaults.canvasBase;
  const canvasApiBase = raw.replace(/\/+$/, '');
  const canvasBase = canvasApiBase.replace(/\/api\/v1\/?$/i, '').replace(/\/+$/, '');
  return { canvasApiBase, canvasBase };
}

function extractJsonBlob(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const candidates = [text];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function getLtiLogLines(apiBase) {
  const raw = runCurl(['-s', `${apiBase}/api/debug/lti-log`]);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.lines) ? parsed.lines.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function clearLtiLog(apiBase) {
  runCurl(['-s', `${apiBase}/api/debug/lti-log?clear=1`]);
}

function listTeacherCourses(canvasBase, token) {
  const raw = runCurl([
    '-s',
    '-H',
    `Authorization: Bearer ${token}`,
    `${canvasBase}/api/v1/courses?enrollment_type=teacher&state[]=available&per_page=100`,
  ]);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function findSettingsAnnouncement(courseId, canvasBase, token, title) {
  const raw = runCurl([
    '-s',
    '-H',
    `Authorization: Bearer ${token}`,
    `${canvasBase}/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`,
  ]);
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r?.title ?? '').trim() === title) ?? null;
}

function listAssignments(courseId, canvasBase, token) {
  const raw = runCurl([
    '-s',
    '-H',
    `Authorization: Bearer ${token}`,
    `${canvasBase}/api/v1/courses/${courseId}/assignments?per_page=100`,
  ]);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function findAssignmentByTitle(courseId, canvasBase, token, title) {
  const rows = listAssignments(courseId, canvasBase, token);
  return rows.find((r) => String(r?.name ?? '').trim() === title) ?? null;
}

function readSettingsBlobFromAssignmentDescription(courseId, canvasBase, token) {
  const settings = findAssignmentByTitle(courseId, canvasBase, token, defaults.settingsAssignmentTitle);
  if (!settings) return null;
  const description = String(settings?.description ?? '').trim();
  if (!description) return null;
  return extractJsonBlob(description);
}

function readSettingsBlobFromAnnouncement(courseId, canvasBase, token) {
  const ann = findSettingsAnnouncement(
    courseId,
    canvasBase,
    token,
    defaults.settingsAnnouncementTitle,
  );
  return extractJsonBlob(ann?.message ?? '');
}

function selectDeckConfigFromBlob(blob) {
  const configs = blob?.configs && typeof blob.configs === 'object' ? blob.configs : {};
  const entries = Object.entries(configs);
  const deck = entries.find(([, cfg]) => String(cfg?.promptMode ?? 'text') === 'decks');
  if (!deck) return null;
  const [assignmentId, cfg] = deck;
  return {
    assignmentId: String(assignmentId).trim(),
    config: cfg ?? {},
  };
}

function discoverDeckAssignmentTarget(canvasBase, token, args) {
  const preferredCourseId = String(args.courseId ?? '').trim();
  if (preferredCourseId) {
    const blob =
      readSettingsBlobFromAssignmentDescription(preferredCourseId, canvasBase, token) ??
      readSettingsBlobFromAnnouncement(preferredCourseId, canvasBase, token);
    const picked = blob ? selectDeckConfigFromBlob(blob) : null;
    if (!picked?.assignmentId) {
      throw new Error(`No deck assignment found in settings announcement for course ${preferredCourseId}.`);
    }
    return {
      courseId: preferredCourseId,
      assignmentId: picked.assignmentId,
      moduleId: String(picked.config?.moduleId ?? '').trim(),
      config: picked.config,
    };
  }

  const courses = listTeacherCourses(canvasBase, token);
  const orderedCourses = preferredCourseId
    ? [
        ...courses.filter((c) => String(c?.id ?? '').trim() === preferredCourseId),
        ...courses.filter((c) => String(c?.id ?? '').trim() !== preferredCourseId),
      ]
    : courses;
  for (const c of orderedCourses) {
    const courseId = String(c?.id ?? '').trim();
    if (!courseId) continue;
    let blob = null;
    try {
      blob =
        readSettingsBlobFromAssignmentDescription(courseId, canvasBase, token) ??
        readSettingsBlobFromAnnouncement(courseId, canvasBase, token);
    } catch {
      continue;
    }
    if (!blob) continue;
    const picked = selectDeckConfigFromBlob(blob);
    if (!picked?.assignmentId) continue;
    return {
      courseId,
      assignmentId: picked.assignmentId,
      moduleId: String(picked.config?.moduleId ?? '').trim(),
      config: picked.config,
    };
  }
  throw new Error('Could not discover a deck assignment from Prompt Manager settings announcements.');
}

function bootstrapTeacherApiSession(apiBase, canvasApiBase, token, target, cookieFile) {
  const assignmentId = String(target?.assignmentId ?? '').trim();
  const moduleId = String(target?.moduleId ?? '').trim();
  runCurl([
    '-s',
    '-i',
    '-c',
    cookieFile,
    '-b',
    cookieFile,
    '-X',
    'POST',
    `${apiBase}/api/lti/launch/prompter`,
    '--data-urlencode',
    `custom_canvas_course_id=${target.courseId}`,
    '--data-urlencode',
    `custom_canvas_assignment_id=${assignmentId}`,
    '--data-urlencode',
    `custom_canvas_module_id=${moduleId}`,
    '--data-urlencode',
    'custom_canvas_user_id=1',
    '--data-urlencode',
    'resource_link_id=validator-programmatic-launch',
    '--data-urlencode',
    'roles=Instructor',
    '--data-urlencode',
    `custom_canvas_api_base_url=${canvasApiBase}`,
  ]);
  const oauthRaw = runCurl([
    '-s',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-X',
    'POST',
    `${apiBase}/api/oauth/canvas/token`,
    '-H',
    'Content-Type: application/json',
    '--data-raw',
    JSON.stringify({ token }),
    '-w',
    '\nHTTP_CODE=%{http_code}\n',
  ]);
  const code = extractMetric(oauthRaw, 'HTTP_CODE');
  if (code !== '200' && code !== '201') {
    throw new Error(`Failed to store API token in session (oauth/token status=${code || 'unknown'})`);
  }
}

function createAutocheckModule(apiBase, cookieFile) {
  const raw = runCurl([
    '-s',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-X',
    'POST',
    `${apiBase}/api/prompt/modules`,
    '-H',
    'Content-Type: application/json',
    '--data-raw',
    JSON.stringify({ name: `Autocheck Module ${new Date().toISOString().slice(0, 19)}` }),
    '-w',
    '\nHTTP_CODE=%{http_code}\n',
  ]);
  const code = extractMetric(raw, 'HTTP_CODE');
  if (code !== '201') {
    throw new Error(`create module failed (status=${code || 'unknown'}): ${raw.slice(0, 400)}`);
  }
  const body = raw.split(/\r?\nHTTP_CODE=/)[0];
  const parsed = JSON.parse(body);
  const id = String(parsed?.id ?? '').trim();
  if (!id) throw new Error(`create module missing id: ${body.slice(0, 200)}`);
  return id;
}

function createAutocheckAssignment(apiBase, cookieFile) {
  const raw = runCurl([
    '-s',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-X',
    'POST',
    `${apiBase}/api/prompt/create-assignment`,
    '-H',
    'Content-Type: application/json',
    '--data-raw',
    JSON.stringify({ name: `Autocheck Assignment ${new Date().toISOString().slice(0, 19)}` }),
    '-w',
    '\nHTTP_CODE=%{http_code}\n',
  ]);
  const code = extractMetric(raw, 'HTTP_CODE');
  if (code !== '201') {
    throw new Error(`create assignment failed (status=${code || 'unknown'}): ${raw.slice(0, 400)}`);
  }
  const body = raw.split(/\r?\nHTTP_CODE=/)[0];
  const parsed = JSON.parse(body);
  const id = String(parsed?.assignmentId ?? '').trim();
  if (!id) throw new Error(`create assignment missing assignmentId: ${body.slice(0, 200)}`);
  return id;
}

function bootstrapAutocheckTarget(apiBase, courseId, cookieFile) {
  const moduleId = createAutocheckModule(apiBase, cookieFile);
  const assignmentId = createAutocheckAssignment(apiBase, cookieFile);
  const config = {
    assignmentName: `Autocheck Assignment`,
    minutes: 5,
    prompts: [],
    promptMode: 'text',
    moduleId,
  };
  return { courseId, assignmentId, moduleId, config };
}

function ensureTargetModuleForSave(apiBase, target, cookieFile) {
  const current = String(target?.moduleId ?? '').trim();
  if (current) return current;
  const created = createAutocheckModule(apiBase, cookieFile);
  target.moduleId = created;
  target.config = {
    ...(target.config ?? {}),
    moduleId: created,
  };
  console.log(`TARGET_MODULE_CREATED moduleId=${created}`);
  return created;
}

function buildPutConfigBody(config) {
  const out = {};
  const copy = [
    'minutes',
    'prompts',
    'accessCode',
    'assignmentName',
    'assignmentGroupId',
    'promptMode',
    'pointsPossible',
    'allowedAttempts',
    'moduleId',
    'videoPromptConfig',
    'instructions',
    'dueAt',
    'unlockAt',
    'lockAt',
    'rubricId',
  ];
  for (const k of copy) {
    if (config?.[k] !== undefined) out[k] = config[k];
  }
  const attemptsRaw = Number(out.allowedAttempts);
  out.allowedAttempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 1
    ? Math.floor(attemptsRaw)
    : 1;
  const pointsRaw = Number(out.pointsPossible);
  out.pointsPossible = Number.isFinite(pointsRaw) && pointsRaw >= 0
    ? Math.floor(pointsRaw)
    : 100;
  return out;
}

function runTeacherSave(apiBase, target, cookieFile) {
  const body = JSON.stringify(buildPutConfigBody(target.config));
  const putRaw = runCurl([
    '-s',
    '-b',
    cookieFile,
    '-c',
    cookieFile,
    '-X',
    'PUT',
    `${apiBase}/api/prompt/config?assignmentId=${encodeURIComponent(target.assignmentId)}`,
    '-H',
    'Content-Type: application/json',
    '--data-raw',
    body,
    '-w',
    '\nHTTP_CODE=%{http_code}\n',
  ]);
  const code = extractMetric(putRaw, 'HTTP_CODE');
  if (code !== '204') {
    throw new Error(`Teacher save failed (status=${code || 'unknown'}): ${putRaw.slice(0, 400)}`);
  }
}

function resolveMappingOutcome(apiBase) {
  const lines = getLtiLogLines(apiBase);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('[prompt-decks]')) continue;
    if (line.includes('resourceLink mapping saved via programmatic launch')) {
      return { outcome: 'MAPPING_SAVED', line };
    }
    if (line.includes('resourceLink mapping skipped: no resourceLinkId from programmatic launch')) {
      return { outcome: 'MAPPING_SKIPPED', line };
    }
  }
  return { outcome: 'MAPPING_ERROR', line: '' };
}

function runClickMode(cfg, args) {
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

function runFullAutocheck(cfg, args) {
  const { canvasApiBase, canvasBase } = deriveCanvasBase(args);
  console.log(`CANVAS_BASE_RESOLVED canvasApiBase=${canvasApiBase} canvasBase=${canvasBase}`);
  const tokenInfo = ensureLocalCanvasToken(cfg.canvasEmail, cfg.canvasPassword);
  const masked = `${tokenInfo.token.slice(0, 6)}...${tokenInfo.token.slice(-6)}`;
  console.log(`TOKEN_CREATED user=${tokenInfo.login} token=${masked}`);

  const tmp = mkdtempSync(join(tmpdir(), 'lti-autocheck-'));
  const canvasCookieFile = join(tmp, 'canvas.cookies.txt');
  const cookieFile = join(tmp, 'api.cookies.txt');
  writeFileSync(canvasCookieFile, '', 'utf8');
  writeFileSync(cookieFile, '', 'utf8');

  canvasLogin(canvasBase, tokenInfo.login, cfg.canvasPassword, canvasCookieFile);
  console.log('CANVAS_LOGIN_OK');

  clearLtiLog(cfg.apiBase);
  let target;
  try {
    target = discoverDeckAssignmentTarget(canvasBase, tokenInfo.token, args);
    console.log(`TARGET_DISCOVERED courseId=${target.courseId} assignmentId=${target.assignmentId} moduleId=${target.moduleId || '(none)'}`);
  } catch (discoverErr) {
    const fallbackCourseId = String(args.courseId ?? '').trim() || String(cfg.courseId ?? '').trim();
    if (!fallbackCourseId) throw discoverErr;
    console.log(`TARGET_DISCOVERY_FAILED ${String(discoverErr)}`);
    console.log(`TARGET_BOOTSTRAP_START courseId=${fallbackCourseId}`);
    bootstrapTeacherApiSession(
      cfg.apiBase,
      canvasApiBase,
      tokenInfo.token,
      { courseId: fallbackCourseId, assignmentId: '', moduleId: '' },
      cookieFile,
    );
    target = bootstrapAutocheckTarget(cfg.apiBase, fallbackCourseId, cookieFile);
    console.log(`TARGET_BOOTSTRAPPED courseId=${target.courseId} assignmentId=${target.assignmentId} moduleId=${target.moduleId}`);
  }

  bootstrapTeacherApiSession(cfg.apiBase, canvasApiBase, tokenInfo.token, target, cookieFile);
  console.log('API_TEACHER_SESSION_OK');

  ensureTargetModuleForSave(cfg.apiBase, target, cookieFile);

  runTeacherSave(cfg.apiBase, target, cookieFile);
  console.log('TEACHER_SAVE_OK');

  const mapping = resolveMappingOutcome(cfg.apiBase);
  if (mapping.line) {
    console.log(`MAPPING_LOG ${mapping.line}`);
  }
  console.log(mapping.outcome);
  process.exit(mapping.outcome === 'MAPPING_ERROR' ? 1 : 0);
}

function main() {
  const args = parseArgs();
  const derived = deriveCanvasBase(args);
  const cfg = {
    ...defaults,
    ...args,
    canvasBase: derived.canvasBase || defaults.canvasBase,
  };

  console.log('LTI_CLICK_VALIDATOR start');
  ensureApiUp(cfg.apiBase);
  const hasExplicitModuleTarget = String(args.moduleItemId ?? '').trim().length > 0;
  if (hasExplicitModuleTarget) {
    runClickMode(cfg, args);
    return;
  }
  runFullAutocheck(cfg, args);
}

try {
  main();
} catch (err) {
  console.error(`VALIDATOR_FAILED ${(err && err.message) ? err.message : String(err)}`);
  console.log('MAPPING_ERROR');
  process.exit(1);
}
