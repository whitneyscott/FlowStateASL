<?php
// LTI launch handler for timed practice tool
$moduleId = $_POST['custom_module_id'] ?? '';
$courseId = $_POST['custom_course_id'] ?? '';
$roles = $_POST['custom_roles'] ?? '';
$assignmentId = $_POST['custom_assignment_id'] ?? '';

// Validate required parameters
if (empty($moduleId) || empty($courseId)) {
    // Redirect to timer.php without parameters if validation fails
    header("Location: timer.php");
    exit;
}

// Build parameters for timer.php including roles
$params = http_build_query([
    'course_id' => $courseId,
    'module_id' => $moduleId,
    'assignment_id' => $assignmentId,
    'roles' => $roles,
    'lti' => '1'
]);

header("Location: timer.php?$params");
exit;
?>