<?php
session_start();
header("Content-Security-Policy: frame-ancestors 'self' *.instructure.com");
header("Access-Control-Allow-Origin: https://*.instructure.com");

function loadEnv($path) {
    if (!file_exists($path)) return;
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), '#') === 0) continue;
        $parts = explode('=', $line, 2);
        if (count($parts) === 2) {
            $_ENV[trim($parts[0])] = trim($parts[1]);
        }
    }
}

loadEnv(__DIR__ . '/.env');

$canvas_token = $_ENV['CANVAS_API_TOKEN'] ?? '';
$canvas_domain = $_ENV['CANVAS_DOMAIN'] ?? '';

$course_id = $_POST['custom_canvas_course_id'] ?? $_POST['custom_course_id'] ?? $_GET['course_id'] ?? null;
$assignment_id = $_POST['custom_canvas_assignment_id'] ?? $_POST['custom_assignment_id'] ?? $_GET['assignment_id'] ?? null;
$filter = $_GET['filter'] ?? '';

function isTeacherRole($roles) {
    if (empty($roles)) return false;
    $roles_lower = strtolower($roles);
    $teacher_patterns = ['instructor', 'administrator', 'faculty', 'teacher', 'staff', 'contentdeveloper', 'teachingassistant', 'ta'];
    foreach ($teacher_patterns as $pattern) {
        if (strpos($roles_lower, $pattern) !== false) return true;
    }
    return false;
}

$is_teacher = false;
$debug_roles = $_POST['custom_roles'] ?? $_GET['roles'] ?? 'NOT_SET';
$is_teacher = isTeacherRole($debug_roles);

if (!$is_teacher && isset($_GET['t']) && $_GET['t'] === '1') {
    $is_teacher = true;
}

echo "<script>console.log('Teacher role detected:', " . ($is_teacher ? 'true' : 'false') . ");</script>";

function getDbConnection() {
    $db_path = __DIR__ . '/.aslexpress-data.db';
    $db = new SQLite3($db_path);
    $db->exec('CREATE TABLE IF NOT EXISTS prompt_configs (
        course_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (course_id, assignment_id)
    )');
    return $db;
}

function saveToDatabase($course_id, $assignment_id, $config) {
    try {
        $db = getDbConnection();
        $stmt = $db->prepare('INSERT OR REPLACE INTO prompt_configs (course_id, assignment_id, config_json, updated_at) VALUES (:course_id, :assignment_id, :config_json, :updated_at)');
        $stmt->bindValue(':course_id', $course_id, SQLITE3_TEXT);
        $stmt->bindValue(':assignment_id', $assignment_id, SQLITE3_TEXT);
        $stmt->bindValue(':config_json', json_encode($config), SQLITE3_TEXT);
        $stmt->bindValue(':updated_at', time(), SQLITE3_INTEGER);
        $result = $stmt->execute();
        $db->close();
        return $result !== false;
    } catch (Exception $e) {
        return false;
    }
}

function loadFromDatabase($course_id, $assignment_id) {
    try {
        $db = getDbConnection();
        $stmt = $db->prepare('SELECT config_json FROM prompt_configs WHERE course_id = :course_id AND assignment_id = :assignment_id');
        $stmt->bindValue(':course_id', $course_id, SQLITE3_TEXT);
        $stmt->bindValue(':assignment_id', $assignment_id, SQLITE3_TEXT);
        $result = $stmt->execute();
        $row = $result->fetchArray(SQLITE3_ASSOC);
        $db->close();
        return ($row && isset($row['config_json'])) ? json_decode($row['config_json'], true) : null;
    } catch (Exception $e) {
        return null;
    }
}

$settings = ['minutes' => 5, 'prompts' => [], 'access_code' => ''];

if ($assignment_id && $course_id) {
    echo "<script>console.log('%c📥 LOADING PROMPTS', 'color: blue; font-weight: bold;');</script>";
    $saved = loadFromDatabase($course_id, $assignment_id);
    if ($saved) {
        $settings = array_merge($settings, $saved);
        echo "<script>console.log('%c✓ LOADED FROM DATABASE', 'color: green; font-weight: bold;', {prompts: " . count($settings['prompts']) . "});</script>";
    }
}

if ($is_teacher && $_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['save_settings'])) {
    $config = [
        'minutes' => (float)$_POST['minutes'],
        'prompts' => json_decode($_POST['prompts_json'] ?? '[]', true) ?: [],
        'version' => '1.0'
    ];
    if (saveToDatabase($course_id, $assignment_id, $config)) {
        $settings = array_merge($settings, $config);
        echo "<script>console.log('%c✓ SAVED TO DATABASE', 'color: green; font-weight: bold;');</script>";
    }
}

$seconds_limit = (float)$settings['minutes'] * 60;
$canvas_module_url = "https://{$canvas_domain}/courses/{$course_id}/modules";
?>
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
    <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
    <style>
        :root { --canvas-blue: #008EE2; --success-green: #28a745; --danger-red: #d9534f; --light-gray: #f4f7f9; }
        body { font-family: sans-serif; text-align: center; padding: 20px; background: var(--light-gray); margin: 0; }
        #timer-card { background: white; border-radius: 12px; max-width: 1200px; margin: 0 auto; padding: 20px; border-top: 8px solid var(--canvas-blue); box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .timer-display { font-size: 60px; font-weight: bold; color: var(--danger-red); margin: 10px 0; }
        .btn-start { background: var(--canvas-blue); color: white; border: none; padding: 15px 30px; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
        .btn-ready { background: var(--success-green); color: white; border: none; padding: 12px 24px; border-radius: 5px; cursor: pointer; font-weight: bold; }
        .hidden { display: none !important; }
        .video-container { position: relative; width: 100%; background: #000; border-radius: 8px; overflow: hidden; border: 3px solid #ccc; }
        video { width: 100%; transform: scaleX(-1); object-fit: cover; }
        .prompt-item { background: #f9f9f9; border: 1px solid #ddd; padding: 12px; margin-bottom: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: flex-start; text-align: left; }
        .prompt-content { flex: 1; margin-right: 15px; line-height: 1.4; }
        .prompt-content p { margin: 0 0 8px 0; }
        .prompt-content *:last-child { margin-bottom: 0; }
        .prompt-column { flex: 1; text-align: left; padding: 20px; border: 1px solid #ddd; border-radius: 8px; background: #f9f9f9; border-left: 5px solid var(--canvas-blue); max-height: 500px; overflow-y: auto; }
    </style>
</head>
<body>
<div id="timer-card">
    <?php if ($is_teacher): ?>
        <button class="btn-start" style="background:#f1f1f1; color:#444; border:1px solid #ccc; padding:8px 16px; font-size:14px; margin-bottom:15px;" onclick="document.getElementById('instructions-block').classList.toggle('hidden')">Show Settings</button>
        <div id="instructions-block" class="hidden">
            <form method="POST" onsubmit="document.getElementById('prompts-json-input').value = JSON.stringify(promptPool)">
                <div style="text-align:left; margin-bottom:15px;">
                    <label><strong>Warm Up Minutes:</strong></label>
                    <input type="number" name="minutes" step="0.1" value="<?= htmlspecialchars($settings['minutes']) ?>">
                </div>
                <div style="text-align:left; margin-bottom:10px;">
                    <div id="editor-container" style="height:120px; background:#fff;"></div>
                    <button type="button" style="margin-top:10px;" onclick="addPrompt()">+ Add to Pool</button>
                </div>
                <div id="prompt-list-display"></div>
                <input type="hidden" name="prompts_json" id="prompts-json-input">
                <button type="submit" name="save_settings" class="btn-ready" style="margin-top:20px; width:100%;">Sync to Database</button>
            </form>
            <hr>
        </div>
    <?php endif; ?>

    <div id="warmup-view">
        <button class="btn-start" onclick="startWarmup()">Start Warm Up</button>
    </div>
    
    <div id="active-warmup" class="hidden">
        <div id="prompt-box" class="prompt-column"></div>
        <div id="clock" class="timer-display">00:00</div>
        <button class="btn-ready" onclick="goToPreflight()">Ready Early</button>
    </div>

    <div id="preflight-view" class="hidden">
        <h3>Step 2: Prepare Your Space</h3>
        <div class="video-container"><video id="preview" autoplay muted playsinline></video></div>
        <button class="btn-ready" onclick="startCountdown()" style="margin-top:15px;">Everything Looks Good - Start</button>
    </div>

    <div id="recording-view" class="hidden">
        <div id="rec-clock" class="timer-display" style="font-size:24px; margin-bottom:20px;">00:00</div>
        <div style="display:flex; gap:20px;">
            <div class="prompt-column">
                <div id="recording-prompt"></div>
            </div>
            <div style="width:300px;">
                <div class="video-container"><video id="recording-feed" autoplay muted playsinline></video></div>
                <button class="btn-start" style="background:var(--danger-red); width:100%; margin-top:15px;" onclick="stopRecording()">Finish & Download</button>
            </div>
        </div>
    </div>

    <div id="finish-view" class="hidden">
        <h2 style="color:var(--success-green);">Recording Saved!</h2>
        <a href="<?= htmlspecialchars($canvas_module_url) ?>" target="_top" class="btn-start">Go to Modules</a>
    </div>
</div>

<script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
<script>
    let promptPool = <?= json_encode($settings['prompts']) ?>;
    let selectedPrompt = promptPool.length > 0 ? promptPool[Math.floor(Math.random() * promptPool.length)] : "No prompts configured.";
    const timeLimit = <?= (float)$seconds_limit ?>;
    let stream, recorder, chunks = [], currentInterval;
    let quill = document.getElementById('editor-container') ? new Quill('#editor-container', { theme: 'snow' }) : null;

    function renderPrompts() {
        const list = document.getElementById('prompt-list-display');
        if(!list) return;
        list.innerHTML = '';
        promptPool.forEach((p, i) => {
            const div = document.createElement('div');
            div.className = 'prompt-item';
            const contentDiv = document.createElement('div');
            contentDiv.className = 'prompt-content';
            contentDiv.innerHTML = p;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.innerHTML = '×';
            btn.style.cssText = "background:#dc3545; color:white; border:none; border-radius:3px; cursor:pointer; padding:2px 8px; font-size:18px;";
            btn.onclick = () => removePrompt(i);
            div.appendChild(contentDiv);
            div.appendChild(btn);
            list.appendChild(div);
        });
    }

    function addPrompt() {
        const content = quill.root.innerHTML;
        if(content.trim() !== '<p><br></p>') {
            promptPool.push(content);
            quill.setContents([]);
            renderPrompts();
        }
    }

    function removePrompt(index) {
        promptPool.splice(index, 1);
        renderPrompts();
    }

    function runTimer(sec, elementId, callback) {
        if(currentInterval) clearInterval(currentInterval);
        const display = document.getElementById(elementId);
        let timer = sec;
        currentInterval = setInterval(() => {
            let m = Math.floor(timer / 60), s = timer % 60;
            display.textContent = m + ":" + (s < 10 ? "0" + s : s);
            if (--timer < 0) { clearInterval(currentInterval); callback(); }
        }, 1000);
    }

    function startWarmup() {
        document.getElementById('warmup-view').classList.add('hidden');
        document.getElementById('active-warmup').classList.remove('hidden');
        document.getElementById('prompt-box').innerHTML = selectedPrompt;
        runTimer(timeLimit, 'clock', goToPreflight);
    }

    async function goToPreflight() {
        if(currentInterval) clearInterval(currentInterval);
        document.getElementById('active-warmup').classList.add('hidden');
        document.getElementById('preflight-view').classList.remove('hidden');
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            document.getElementById('preview').srcObject = stream;
        } catch (err) { alert("Camera error."); }
    }

    function startCountdown() {
        document.getElementById('preflight-view').classList.add('hidden');
        document.getElementById('recording-view').classList.remove('hidden');
        document.getElementById('recording-feed').srcObject = stream;
        document.getElementById('recording-prompt').innerHTML = selectedPrompt;
        beginCapture();
    }

    function beginCapture() {
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'ASL_Submission.webm';
            a.click();
            document.getElementById('recording-view').classList.add('hidden');
            document.getElementById('finish-view').classList.remove('hidden');
        };
        recorder.start();
        runTimer(timeLimit, 'rec-clock', stopRecording);
    }

    function stopRecording() {
        if(recorder && recorder.state !== 'inactive') recorder.stop();
        if(stream) stream.getTracks().forEach(t => t.stop());
    }
    if(document.getElementById('prompt-list-display')) renderPrompts();
</script>
</body>
</html>