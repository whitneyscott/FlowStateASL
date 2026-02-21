<?php
// Demo-Safe Patch: Prevent JSON dumps and ensure UI redirect
$moduleId = $_POST['custom_module_id'] ?? '';
$courseId = $_POST['custom_course_id'] ?? '';

// Validate required parameters
if (empty($moduleId) || empty($courseId)) {
    // Redirect to timer.php instead of showing error JSON
    header("Location: timer.php");
    exit;
}

$params = http_build_query([
    'course_id' => $courseId,
    'module_id' => $moduleId,
    'lti' => '1'
]);

header("Location: flashcards.php?$params");
exit;
?>
