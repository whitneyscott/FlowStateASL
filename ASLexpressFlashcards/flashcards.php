<?php
if (function_exists('opcache_reset')) {
    opcache_reset();
}
$filter = $_GET['filter'] ?? '';
$playlistId = $_GET['playlist_id'] ?? '';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TWA Flashcards</title>
    <style>
        body { font-family: sans-serif; background: #1a1a1a; color: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        #app-container { width: 95%; max-width: 800px; text-align: center; padding: 20px; }
        
        #bridge-log { 
            background: #000; 
            color: #00ff88; 
            font-family: monospace; 
            padding: 15px; 
            border: 2px solid #00ff88; 
            margin: 10px auto 20px auto; 
            text-align: left; 
            white-space: pre-wrap; 
            font-size: 13px;
            line-height: 1.4;
        }
        
        .playlist-button { display: block; width: 100%; padding: 15px; margin: 10px 0; background: #333; border: 1px solid #555; color: white; cursor: pointer; border-radius: 8px; font-size: 1.1em; }
        .playlist-button:hover { background: #444; border-color: #00ff88; }
        
        #flashcard-card { background: #2a2a2a; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); min-height: 400px; display: flex; flex-direction: column; justify-content: center; align-items: center; position: relative; overflow: hidden; }
        #vocab-display { font-size: 3.5em; margin-bottom: 20px; color: #00ff88; }
        #timer-track { position: absolute; top: 0; left: 0; width: 100%; height: 8px; background: #444; display: none; }
        #timer-fill { width: 100%; height: 100%; background: #00ff88; }
        .video-container { width: 100%; aspect-ratio: 16/9; background: #000; display: none; margin-bottom: 20px; }
        .video-container iframe { width: 100%; height: 100%; border: none; pointer-events: none; }
        .controls { margin-top: 30px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
        .secondary-controls { margin-top: 20px; display: flex; gap: 15px; justify-content: center; }
        .btn { padding: 15px 25px; font-size: 1em; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-transform: uppercase; }
        .btn-flip { background: #007bff; color: white; }
        .btn-correct { background: #28a745; color: white; }
        .btn-incorrect { background: #dc3545; color: white; }
        .btn-utility { background: #007bff; color: white; }
        .btn-nav { background: #444; color: #00ff88; border: 1px solid #555; padding: 8px 15px; font-size: 0.9em; cursor: pointer; border-radius: 4px; font-weight: bold; text-transform: uppercase; }
        .btn-nav:hover { background: #555; border-color: #00ff88; }
        
        #results-screen { display: none; }
        #status-bar { margin-bottom: 10px; color: #888; display: flex; justify-content: space-between; align-items: flex-start; flex-direction: column; }
        .persistent-options { background: #333; padding: 10px; border-radius: 8px; margin-bottom: 15px; font-size: 0.85em; display: flex; gap: 15px; justify-content: center; align-items: center; flex-wrap: wrap; }
        .persistent-options input[type="number"] { width: 40px; background: #1a1a1a; color: #00ff88; border: 1px solid #555; padding: 3px; border-radius: 4px; text-align: center; }
        .benchmark-note { margin-top: 10px; color: #aaa; font-style: italic; font-size: 0.9em; }
        select { background: #1a1a1a; color: #00ff88; border: 1px solid #555; border-radius: 4px; padding: 2px; }
        
        #type-zone { margin-top: 10px; display: none; gap: 10px; }
        #type-input { padding: 10px; font-size: 1.2em; border-radius: 5px; border: 1px solid #555; background: #1a1a1a; color: white; }

        .spinner { border: 4px solid #444; border-top: 4px solid #00ff88; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .loading-container { display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .streak-info { color: #00ff88; font-weight: bold; margin-left: 10px; }

        #screening-overlay {
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.95);
            display: none;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 100;
            padding: 20px;
            box-sizing: border-box;
        }
        .overlay-title { font-size: 2em; margin-bottom: 15px; }
        .mastery-text { color: #00ff88; }
        .frustration-text { color: #ff5555; }
    </style>
</head>
<body>

<div id="app-container">
    <div id="setup-view">
        <div id="bridge-log"><strong>BRIDGE DEBUG LOG:</strong> Initializing...</div>
        <h1>TWA Vocabulary</h1>
        <div id="list-area"><p>Loading...</p></div>
    </div>

    <div id="study-view" style="display: none;">
        <div class="persistent-options">
            <span>Sec: <input type="number" id="sec-input" value="3" min="1" max="10"></span>
            <label><input type="checkbox" id="show-timer-toggle" checked> Timer</label>
            <label><input type="checkbox" id="shuffle-toggle"> Shuffle</label>
            <span id="type-option-container" style="display: none;"><label><input type="checkbox" id="type-toggle"> Type answers</label></span>
            <span>
                Mode: 
                <select id="mode-select" onchange="handleModeChange()">
                    <option value="rehearsal">Rehearsal</option>
                    <option value="tutorial">Tutorial</option>
                    <option value="screening">Screening</option>
                </select>
            </span>
            <span id="criteria-container" style="display:none;">
                Crit: 
                <select id="threshold-select">
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5" selected>5</option>
                </select>
            </span>
            <span>
                1st: 
                <select id="first-select" onchange="updateOptionsVisibility()">
                    <option value="english">Eng</option>
                    <option value="asl">ASL</option>
                </select>
            </span>
            <button class="btn-utility" id="timed-practice-btn" style="display:none;" onclick="startTimedPractice()">Start Timed Practice</button>
        </div>

        <div id="status-bar">
            <div>Progress: <span id="progress-correct">0</span> / <span id="progress-total">0</span> <span id="streak-display" class="streak-info"></span></div>
            <div>Item <span id="current-num">0</span> of <span id="iteration-total">0</span></div>
        </div>

        <div id="flashcard-card">
            <div id="timer-track"><div id="timer-fill"></div></div>
            
            <div id="screening-overlay">
                <div id="overlay-content">
                    <h2 id="overlay-title" class="overlay-title"></h2>
                    <p id="overlay-msg" style="margin-bottom: 25px;"></p>
                    <div class="controls" id="overlay-btns"></div>
                </div>
            </div>

            <h1 id="vocab-display">READY?</h1>
            <div id="loading-spinner" class="loading-container" style="display: none;">
                <div class="spinner"></div>
                <p>Loading...</p>
            </div>
            <div id="video-area" class="video-container"></div>
            
            <div id="type-zone">
                <input type="text" id="type-input" placeholder="Type answer..." autocomplete="off">
                <button class="btn btn-utility" onclick="checkTypedAnswer()">Submit</button>
            </div>

            <div id="action-zone" class="controls">
                <button id="start-btn" class="btn btn-flip" onclick="startSession()" disabled>Loading Items...</button>
                <button id="flip-btn" class="btn btn-flip" style="display:none;" onclick="revealAnswer()">Show Answer</button>
                <button id="correct-btn" class="btn btn-correct" style="display:none;" onclick="recordScore(true)">Correct</button>
                <button id="incorrect-btn" class="btn btn-incorrect" style="display:none;" onclick="recordScore(false)">Incorrect</button>
            </div>
        </div>

        <div class="secondary-controls">
            <button class="btn-nav" onclick="resetCurrentDeck()">Reset Deck</button>
            <button class="btn-nav" onclick="returnToMenu()">Change Deck</button>
        </div>
    </div>

    <div id="results-screen">
        <div id="flashcard-card">
            <h1>Results</h1>
            <h2 id="score-display">0/0 (0%)</h2>
            <div class="benchmark-note">Suggested minimum score: 85%</div>
            <div class="controls">
                <button class="btn btn-utility" onclick="repeatAll()">Repeat All</button>
                <button id="retry-missed-btn" class="btn btn-utility" onclick="retryMissed()" style="display:none;">Retry Missed Only</button>
                <button class="btn btn-utility" onclick="loadNextUnit()">Next</button>
                <button class="btn btn-utility" onclick="saveResults()">Save List</button>
                <button class="btn btn-utility" onclick="returnToMenu()">Back to Menu</button>
                <button class="btn btn-utility" onclick="window.close()">Exit</button>
            </div>
        </div>
    </div>
</div>

<script>
const directId = "<?php echo $playlistId; ?>";
let playlistItems = [];
let originalPlaylistItems = [];
let currentIndex = -1;
let score = { correct: 0, total: 0, details: [] };
let autoTimer;
let currentFilter = '';
let originalDeckSize = 0;
let availablePlaylists = [];
let currentPlaylistIndex = -1;
let currentStreak = 0;
let currentPlaylistId = "";
let benchmarkNagDismissed = false;

async function init() {
    const params = new URLSearchParams(window.location.search);
    const courseId = params.get('course_id');
    const moduleId = params.get('module_id');
    const isLTI = params.get('lti');
    const logBox = document.getElementById('bridge-log');

    if (isLTI && courseId && moduleId) {
        logBox.innerHTML = `<strong>BRIDGE DEBUG LOG:</strong>\n` +
                           `• LTI Launch Detected ✓\n` +
                           `• Course ID: ${courseId}\n` +
                           `• Module ID: ${moduleId}\n` +
                           `• Fetching module name from Canvas API...`;
        
        try {
            const res = await fetch(`canvas_bridge.php?course_id=${courseId}&module_id=${moduleId}&cb=${Date.now()}`);
            const data = await res.json();
            
            logBox.innerHTML = `<strong>BRIDGE DEBUG LOG:</strong>\n` +
                               `• LTI Launch Detected ✓\n` +
                               `• Canvas Module: ${data.module_name || 'Unknown'}\n` +
                               `• Course ID: ${courseId}\n` +
                               `• Module ID: ${moduleId}\n` +
                               `• Filter: <span style="color:#fff; background:#222; padding:2px 5px; border-radius:3px;">${data.filter || 'NONE'}</span>`;
            
            if (data.module_name && data.module_name !== 'Not Found') {
                document.querySelector('#setup-view h1').innerText = data.module_name;
            }
            
            currentFilter = data.filter || "";
            await loadMenu(currentFilter);
        } catch (e) {
            logBox.innerHTML = `<strong>BRIDGE DEBUG LOG:</strong>\n<span style="color:#ff5555;">Error fetching module info: ${e.message}</span>`;
            // Demo-Safe: Always load menu even on error
            await loadMenu("");
        }
    } else if (directId) {
        logBox.style.display = 'none';
        await prepareStudySession(directId, "Loading...");
    } else {
        logBox.innerHTML = `<strong>BRIDGE DEBUG LOG:</strong>\n<span style="color:#ffff00;">No LTI launch detected. Loading full menu.</span>`;
        await loadMenu("");
    }
}

async function loadMenu(filterValue = '') {
    currentFilter = filterValue;
    const listArea = document.getElementById('list-area');
    listArea.innerHTML = '<div class="loading-container"><div class="spinner"></div><p>Loading playlists...</p></div>';
    
    const cb = Date.now();
    const response = await fetch(`sprout_bridge.php?filter=${encodeURIComponent(filterValue)}&cb=${cb}`);
    const playlists = await response.json();
    
    availablePlaylists = playlists.filter(pl => pl.id !== 'DEBUG');
    currentPlaylistIndex = -1;
    
    listArea.innerHTML = '';
    playlists.forEach(pl => {
        const btn = document.createElement('button');
        btn.className = 'playlist-button';
        btn.innerText = pl.title;
        btn.onclick = () => prepareStudySession(pl.id, pl.title);
        listArea.appendChild(btn);
    });
}

async function prepareStudySession(id, title) {
    currentPlaylistId = id;
    currentPlaylistIndex = availablePlaylists.findIndex(pl => pl.id === id);
    currentIndex = -1;
    score = { correct: 0, total: 0, details: [] };
    currentStreak = 0;
    benchmarkNagDismissed = false;
    updateStreakDisplay();
    hideScreeningOverlay();
    
    document.getElementById('setup-view').style.display = 'none';
    document.getElementById('results-screen').style.display = 'none';
    document.getElementById('study-view').style.display = 'block';
    
    document.getElementById('vocab-display').style.display = 'none';
    document.getElementById('loading-spinner').style.display = 'flex';
    document.getElementById('video-area').style.display = 'none';
    document.getElementById('start-btn').style.display = 'none';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('correct-btn').style.display = 'none';
    document.getElementById('incorrect-btn').style.display = 'none';
    document.getElementById('type-zone').style.display = 'none';
    document.getElementById('progress-correct').innerText = "0";
    document.getElementById('progress-total').innerText = "0";
    document.getElementById('current-num').innerText = "0";
    document.getElementById('iteration-total').innerText = "0";
    
    const cb = Date.now();
    const response = await fetch(`sprout_bridge.php?playlist_id=${id}&cb=${cb}`);
    originalPlaylistItems = await response.json();
    playlistItems = [...originalPlaylistItems];
    
    if (playlistItems.length > 0) {
        originalDeckSize = playlistItems.length;
        score.total = originalDeckSize;
        document.getElementById('progress-total').innerText = originalDeckSize;
        document.getElementById('iteration-total').innerText = originalDeckSize;
        
        document.getElementById('loading-spinner').style.display = 'none';
        document.getElementById('vocab-display').style.display = 'block';
        document.getElementById('vocab-display').innerText = "READY?";
        document.getElementById('start-btn').style.display = 'inline-block';
        document.getElementById('start-btn').disabled = false;
        document.getElementById('start-btn').innerText = "Start";
        updateOptionsVisibility();
    }
}

function updateOptionsVisibility() {
    const firstSide = document.getElementById('first-select').value;
    const typeContainer = document.getElementById('type-option-container');
    
    if (firstSide === 'asl') {
        typeContainer.style.display = 'inline';
    } else {
        typeContainer.style.display = 'none';
        document.getElementById('type-toggle').checked = false;
    }
}

function resetCurrentDeck() {
    clearTimeout(autoTimer);
    playlistItems = [...originalPlaylistItems];
    if (document.getElementById('shuffle-toggle').checked) {
        playlistItems.sort(() => Math.random() - 0.5);
    }
    currentIndex = -1;
    score = { correct: 0, total: originalDeckSize, details: [] };
    currentStreak = 0;
    benchmarkNagDismissed = false;
    updateStreakDisplay();
    hideScreeningOverlay();

    document.getElementById('progress-correct').innerText = "0";
    document.getElementById('iteration-total').innerText = originalDeckSize;
    document.getElementById('current-num').innerText = "0";

    document.getElementById('video-area').style.display = 'none';
    document.getElementById('video-area').innerHTML = '';
    document.getElementById('type-zone').style.display = 'none';
    document.getElementById('vocab-display').style.display = 'block';
    document.getElementById('vocab-display').innerText = "READY?";
    
    document.getElementById('start-btn').style.display = 'inline-block';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('correct-btn').style.display = 'none';
    document.getElementById('incorrect-btn').style.display = 'none';
    document.getElementById('timer-track').style.display = 'none';
}

function handleModeChange() {
    const mode = document.getElementById('mode-select').value;
    document.getElementById('criteria-container').style.display = (mode === 'screening') ? 'inline' : 'none';
    currentStreak = 0;
    updateStreakDisplay();
}

function updateStreakDisplay() {
    const display = document.getElementById('streak-display');
    const mode = document.getElementById('mode-select').value;
    if (mode === 'screening' && currentStreak !== 0) {
        display.innerText = (currentStreak > 0) ? `Streak: ${currentStreak}` : `Misses: ${Math.abs(currentStreak)}`;
        display.style.color = (currentStreak > 0) ? '#00ff88' : '#ff5555';
    } else {
        display.innerText = '';
    }
}

function showScreeningOverlay(type, title, message) {
    const overlay = document.getElementById('screening-overlay');
    const h2 = document.getElementById('overlay-title');
    const p = document.getElementById('overlay-msg');
    const btnContainer = document.getElementById('overlay-btns');
    
    h2.innerText = title;
    h2.className = `overlay-title ${type === 'mastery' ? 'mastery-text' : 'frustration-text'}`;
    p.innerText = message;
    btnContainer.innerHTML = '';

    if (type === 'mastery') {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-correct';
        nextBtn.innerText = 'Next Deck';
        nextBtn.onclick = () => { hideScreeningOverlay(); loadNextUnit(); };
        
        const contBtn = document.createElement('button');
        contBtn.className = 'btn btn-utility';
        contBtn.innerText = 'Continue Current Deck';
        contBtn.onclick = () => { hideScreeningOverlay(); nextCard(); };
        
        btnContainer.appendChild(nextBtn);
        btnContainer.appendChild(contBtn);
    } else {
        const tutBtn = document.createElement('button');
        tutBtn.className = 'btn btn-incorrect';
        tutBtn.innerText = 'Switch to Tutorial Mode';
        tutBtn.onclick = () => { 
            document.getElementById('mode-select').value = 'tutorial';
            handleModeChange();
            hideScreeningOverlay(); 
            nextCard(); 
        };
        
        const contBtn = document.createElement('button');
        contBtn.className = 'btn btn-utility';
        contBtn.innerText = 'Keep Trying';
        contBtn.onclick = () => { 
            if (title === 'Benchmark Unattainable') {
                benchmarkNagDismissed = true;
            }
            hideScreeningOverlay(); 
            nextCard(); 
        };
        
        btnContainer.appendChild(tutBtn);
        btnContainer.appendChild(contBtn);
    }

    overlay.style.display = 'flex';
}

function hideScreeningOverlay() {
    document.getElementById('screening-overlay').style.display = 'none';
}

function returnToMenu() {
    clearTimeout(autoTimer);
    document.getElementById('study-view').style.display = 'none';
    document.getElementById('results-screen').style.display = 'none';
    document.getElementById('setup-view').style.display = 'block';
    document.getElementById('bridge-log').style.display = 'block';
    loadMenu(currentFilter);
}

function startSession() {
    if (document.getElementById('shuffle-toggle').checked) {
        playlistItems.sort(() => Math.random() - 0.5);
    }
    nextCard();
}

function repeatAll() {
    playlistItems = [...originalPlaylistItems];
    if (document.getElementById('shuffle-toggle').checked) {
        playlistItems.sort(() => Math.random() - 0.5);
    }
    currentIndex = -1;
    score = { correct: 0, total: originalDeckSize, details: [] };
    currentStreak = 0;
    benchmarkNagDismissed = false;
    updateStreakDisplay();
    
    document.getElementById('results-screen').style.display = 'none';
    document.getElementById('study-view').style.display = 'block';
    document.getElementById('progress-correct').innerText = "0";
    document.getElementById('iteration-total').innerText = originalDeckSize;
    
    document.getElementById('start-btn').style.display = 'none';
    document.getElementById('correct-btn').style.display = 'none';
    document.getElementById('incorrect-btn').style.display = 'none';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('type-zone').style.display = 'none';

    nextCard();
}

function retryMissed() {
    const missed = score.details.filter(item => item.result === "Incorrect").map(item => item.originalData);
    if (missed.length === 0) return;
    
    playlistItems = missed;
    if (document.getElementById('shuffle-toggle').checked) {
        playlistItems.sort(() => Math.random() - 0.5);
    }
    currentIndex = -1;
    currentStreak = 0;
    benchmarkNagDismissed = false;
    updateStreakDisplay();
    
    const previouslyCorrect = originalDeckSize - missed.length;
    score = { correct: previouslyCorrect, total: originalDeckSize, details: [] };
    
    document.getElementById('results-screen').style.display = 'none';
    document.getElementById('study-view').style.display = 'block';
    
    document.getElementById('progress-correct').innerText = previouslyCorrect;
    document.getElementById('iteration-total').innerText = missed.length;
    
    document.getElementById('start-btn').style.display = 'none';
    document.getElementById('correct-btn').style.display = 'none';
    document.getElementById('incorrect-btn').style.display = 'none';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('type-zone').style.display = 'none';

    nextCard();
}

function nextCard() {
    clearTimeout(autoTimer);
    currentIndex++;
    if (currentIndex >= playlistItems.length) {
        showResults();
        return;
    }
    const displayTime = parseInt(document.getElementById('sec-input').value) * 1000;
    const firstSide = document.getElementById('first-select').value;
    const isTyping = document.getElementById('type-toggle').checked;

    document.getElementById('start-btn').style.display = 'none';
    document.getElementById('correct-btn').style.display = 'none';
    document.getElementById('incorrect-btn').style.display = 'none';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('type-zone').style.display = 'none';
    document.getElementById('video-area').style.display = 'none';
    document.getElementById('video-area').innerHTML = '';
    
    document.getElementById('progress-correct').innerText = score.correct;
    document.getElementById('current-num').innerText = currentIndex + 1;

    if (firstSide === 'english') {
        document.getElementById('vocab-display').innerText = playlistItems[currentIndex].title;
        document.getElementById('vocab-display').style.display = 'block';
        
        const timerTrack = document.getElementById('timer-track');
        const fill = document.getElementById('timer-fill');
        if (document.getElementById('show-timer-toggle').checked) {
            timerTrack.style.display = 'block';
            fill.style.transition = 'none';
            fill.style.width = '100%';
            setTimeout(() => {
                fill.style.transition = `width ${displayTime}ms linear`;
                fill.style.width = '0%';
            }, 50);
        }
        autoTimer = setTimeout(revealAnswer, displayTime);
    } else {
        document.getElementById('vocab-display').style.display = 'none';
        document.getElementById('timer-track').style.display = 'none';
        injectVideo();
        document.getElementById('video-area').style.display = 'block';
        
        if (isTyping) {
            const tInput = document.getElementById('type-input');
            tInput.value = '';
            document.getElementById('type-zone').style.display = 'flex';
            tInput.focus();
        } else {
            document.getElementById('flip-btn').style.display = 'inline-block';
        }
    }
}

function checkTypedAnswer() {
    const typedInput = document.getElementById('type-input');
    const typed = typedInput.value.trim().toLowerCase();
    const actual = playlistItems[currentIndex].title.toLowerCase();
    
    if (typed === actual) {
        document.getElementById('type-zone').style.display = 'none';
        document.getElementById('vocab-display').innerText = "CORRECT!";
        document.getElementById('vocab-display').style.display = 'block';
        setTimeout(() => {
            recordScore(true);
        }, 800);
    } else {
        revealAnswer();
    }
}

function revealAnswer() {
    clearTimeout(autoTimer);
    const mode = document.getElementById('mode-select').value;
    const firstSide = document.getElementById('first-select').value;
    const isTyping = document.getElementById('type-toggle').checked;
    const displayTime = parseInt(document.getElementById('sec-input').value) * 1000;

    document.getElementById('timer-track').style.display = 'none';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('type-zone').style.display = 'none';

    if (firstSide === 'english') {
        document.getElementById('vocab-display').style.display = 'none';
        injectVideo();
        document.getElementById('video-area').style.display = 'block';
    } else {
        document.getElementById('video-area').style.display = 'none';
        
        if (isTyping) {
            const typedVal = document.getElementById('type-input').value || "(nothing typed)";
            document.getElementById('vocab-display').innerHTML = 
                `<div style="font-size: 0.4em; color: #ff5555; margin-bottom: 10px;">You typed: ${typedVal}</div>` +
                `<div style="font-size: 0.6em; color: #888;">Correct answer:</div>` + 
                playlistItems[currentIndex].title;
        } else {
            document.getElementById('vocab-display').innerText = playlistItems[currentIndex].title;
        }
        
        document.getElementById('vocab-display').style.display = 'block';
        
        if (mode === 'tutorial') {
             const timerTrack = document.getElementById('timer-track');
             const fill = document.getElementById('timer-fill');
             if (document.getElementById('show-timer-toggle').checked) {
                timerTrack.style.display = 'block';
                fill.style.transition = 'none';
                fill.style.width = '100%';
                setTimeout(() => {
                    fill.style.transition = `width ${displayTime}ms linear`;
                    fill.style.width = '0%';
                }, 50);
            }
        }
    }

    if (mode === 'tutorial' && !isTyping) {
        autoTimer = setTimeout(() => {
            recordScore(true);
        }, displayTime);
    } else {
        if (isTyping && firstSide === 'asl') {
            const overrideBtn = document.getElementById('correct-btn');
            overrideBtn.innerText = "Override: I was right";
            overrideBtn.style.display = 'inline-block';
            
            const incorrectBtn = document.getElementById('incorrect-btn');
            incorrectBtn.innerText = "Incorrect";
            incorrectBtn.style.display = 'inline-block';
        } else {
            const correctBtn = document.getElementById('correct-btn');
            correctBtn.innerText = "Correct";
            correctBtn.style.display = 'inline-block';
            
            const incorrectBtn = document.getElementById('incorrect-btn');
            incorrectBtn.innerText = "Incorrect";
            incorrectBtn.style.display = 'inline-block';
        }
    }
}

document.getElementById('type-input').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        checkTypedAnswer();
    }
});

function injectVideo() {
    let embedCode = playlistItems[currentIndex].embed;
    const srcMatch = embedCode.match(/src=['"]([^'"]+)['"]/);
    if (srcMatch && srcMatch[1]) {
        let originalSrc = srcMatch[1];
        let newSrc = originalSrc + (originalSrc.includes('?') ? '&' : '?') + 'autoPlay=true&showControls=false';
        embedCode = embedCode.replace(originalSrc, newSrc);
    }
    document.getElementById('video-area').innerHTML = embedCode;
}

function revealAnswer() {
    clearTimeout(autoTimer);
    const mode = document.getElementById('mode-select').value;
    const firstSide = document.getElementById('first-select').value;
    const displayTime = parseInt(document.getElementById('sec-input').value) * 1000;

    document.getElementById('timer-track').style.display = 'none';
    document.getElementById('flip-btn').style.display = 'none';
    document.getElementById('type-zone').style.display = 'none';

    if (firstSide === 'english') {
        document.getElementById('vocab-display').style.display = 'none';
        injectVideo();
        document.getElementById('video-area').style.display = 'block';
    } else {
        document.getElementById('video-area').style.display = 'none';
        document.getElementById('vocab-display').innerText = playlistItems[currentIndex].title;
        document.getElementById('vocab-display').style.display = 'block';
        
        if (mode === 'tutorial') {
             const timerTrack = document.getElementById('timer-track');
             const fill = document.getElementById('timer-fill');
             if (document.getElementById('show-timer-toggle').checked) {
                timerTrack.style.display = 'block';
                fill.style.transition = 'none';
                fill.style.width = '100%';
                setTimeout(() => {
                    fill.style.transition = `width ${displayTime}ms linear`;
                    fill.style.width = '0%';
                }, 50);
            }
        }
    }

    if (mode === 'tutorial') {
        autoTimer = setTimeout(() => {
            recordScore(true);
        }, displayTime);
    } else {
        document.getElementById('correct-btn').style.display = 'inline-block';
        document.getElementById('incorrect-btn').style.display = 'inline-block';
    }
}

function recordScore(isCorrect) {
    const mode = document.getElementById('mode-select').value;
    const criteria = parseInt(document.getElementById('threshold-select').value);

    if (isCorrect) {
        score.correct++;
        currentStreak = (currentStreak < 0) ? 1 : currentStreak + 1;
    } else {
        currentStreak = (currentStreak > 0) ? -1 : currentStreak - 1;
    }

    score.details.push({ 
        term: playlistItems[currentIndex].title, 
        result: isCorrect ? "Correct" : "Incorrect",
        originalData: playlistItems[currentIndex]
    });

    updateStreakDisplay();

    if (mode !== 'tutorial') {
        if (!benchmarkNagDismissed) {
            const remainingCards = playlistItems.length - (currentIndex + 1);
            const maxPossibleCorrect = score.correct + remainingCards;
            const maxPossiblePercent = (maxPossibleCorrect / playlistItems.length) * 100;

            if (maxPossiblePercent < 85) {
                showScreeningOverlay('frustration', 'Benchmark Unattainable', `Even with perfect scores on remaining cards, the 85% benchmark is no longer possible for this run. Ready to switch to Tutorial mode?`);
                currentStreak = 0;
                updateStreakDisplay();
                return;
            }
        }

        if (mode === 'screening') {
            if (currentStreak >= criteria) {
                showScreeningOverlay('mastery', 'Mastery Achieved!', `You've gotten ${criteria} in a row. What would you like to do?`);
                currentStreak = 0;
                updateStreakDisplay();
                return;
            } else if (currentStreak <= (criteria * -1)) {
                showScreeningOverlay('frustration', 'Frustration Detected', `You've missed ${criteria} in a row. Ready to try Tutorial mode?`);
                currentStreak = 0;
                updateStreakDisplay();
                return;
            }
        }
    }

    nextCard();
}

function showResults() {
    document.getElementById('study-view').style.display = 'none';
    document.getElementById('results-screen').style.display = 'block';
    const percentage = score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
    document.getElementById('score-display').innerText = `${score.correct}/${score.total} (${percentage}%)`;
    const hasMissed = score.details.some(item => item.result === "Incorrect");
    document.getElementById('retry-missed-btn').style.display = hasMissed ? 'inline-block' : 'none';
}

function saveResults() {
    let content = "Results\n\n";
    score.details.forEach(i => { if (i.result === "Incorrect") content += `${i.term}\n`; });
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Results.txt';
    a.click();
}

function loadNextUnit() {
    if (currentPlaylistIndex >= 0 && currentPlaylistIndex < availablePlaylists.length - 1) {
        const nextPlaylist = availablePlaylists[currentPlaylistIndex + 1];
        document.getElementById('results-screen').style.display = 'none';
        prepareStudySession(nextPlaylist.id, nextPlaylist.title);
    } else {
        alert('No more playlists in this unit!');
    }
}

function startTimedPractice() {
    if (!currentFilter) {
        alert('Please select a unit first to start timed practice.');
        return;
    }
    
    // Construct URL for timer.php with filter parameter
    const url = `timer.php?filter=${encodeURIComponent(currentFilter)}`;
    
    // Open in new tab/window
    window.open(url, '_blank');
}

// Show the timed practice button when we have a filter
function updateTimedPracticeButton() {
    const btn = document.getElementById('timed-practice-btn');
    if (currentFilter && currentFilter !== '') {
        btn.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
    }
}

init();
</script>
</body>
</html>