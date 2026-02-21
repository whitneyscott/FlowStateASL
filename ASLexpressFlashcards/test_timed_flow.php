<?php
// Test script to verify the timed practice flow
echo "<h1>Testing Timed Practice Flow</h1>";

// Test 1: Check if lti_timed_launch.php exists
if (file_exists('lti_timed_launch.php')) {
    echo "<p style='color:green;'>✓ lti_timed_launch.php exists</p>";
} else {
    echo "<p style='color:red;'>✗ lti_timed_launch.php missing</p>";
}

// Test 2: Check if timer.php can be loaded
if (file_exists('timer.php')) {
    echo "<p style='color:green;'>✓ timer.php exists</p>";
} else {
    echo "<p style='color:red;'>✗ timer.php missing</p>";
}

// Test 3: Test sprout_bridge.php with a sample filter
$testFilter = 'TWA.05.01';
$cb = time();
$sproutResponse = file_get_contents("sprout_bridge.php?filter=" . urlencode($testFilter) . "&cb=" . $cb);
$playlists = json_decode($sproutResponse, true);

if ($playlists && is_array($playlists)) {
    echo "<p style='color:green;'>✓ sprout_bridge.php responding with " . count($playlists) . " playlists for filter '$testFilter'</p>";
    echo "<ul>";
    foreach ($playlists as $playlist) {
        echo "<li>" . htmlspecialchars($playlist['title']) . "</li>";
    }
    echo "</ul>";
} else {
    echo "<p style='color:red;'>✗ sprout_bridge.php not responding properly</p>";
}

// Test 4: Test canvas_bridge.php with sample parameters
$testCourseId = '123';
$testModuleId = '456';
$canvasResponse = file_get_contents("canvas_bridge.php?course_id=" . urlencode($testCourseId) . "&module_id=" . urlencode($testModuleId) . "&cb=" . $cb);
$canvasData = json_decode($canvasResponse, true);

if ($canvasData) {
    echo "<p style='color:green;'>✓ canvas_bridge.php responding</p>";
    echo "<p>Module name: " . htmlspecialchars($canvasData['module_name'] ?? 'Unknown') . "</p>";
    echo "<p>Filter: " . htmlspecialchars($canvasData['filter'] ?? 'None') . "</p>";
} else {
    echo "<p style='color:red;'>✗ canvas_bridge.php not responding properly</p>";
}

echo "<h2>Test Summary</h2>";
echo "<p>The timed practice tool should now work as follows:</p>";
echo "<ol>";
echo "<li>User launches 'Timed Practice' LTI tool in Canvas</li>";
echo "<li>LTI parameters (course_id, module_id) are passed to lti_timed_launch.php</li>";
echo "<li>lti_timed_launch.php redirects to timer.php with the parameters</li>";
echo "<li>timer.php extracts the module name and generates filter (e.g., TWA.05.01)</li>";
echo "<li>timer.php calls sprout_bridge.php with the filter to get relevant prompts</li>";
echo "<li>User sees timed practice with prompts from their specific unit</li>";
echo "</ol>";

echo "<h2>Configuration Required</h2>";
echo "<p>In Canvas, configure a new external tool with:</p>";
echo "<ul>";
echo "<li>URL: " . htmlspecialchars($_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI']) . "lti_timed_launch.php</li>";
echo "<li>Set as LTI 1.3 or LTI Advantage tool</li>";
echo "<li>Configure in the desired course/module</li>";
echo "</ul>";
?>