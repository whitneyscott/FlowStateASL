<?php
header("Content-Type: application/json");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");

function loadEnv($path) {
    if (!file_exists($path)) return false;
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), '#') === 0 || !strpos($line, '=')) continue;
        list($name, $value) = explode('=', $line, 2);
        $_ENV[trim($name)] = trim($value);
    }
    return true;
}

$envPath = __DIR__ . '/.env';
loadEnv($envPath);

$canvasToken = $_ENV['CANVAS_API_TOKEN'] ?? '';
$canvasDomain = $_ENV['CANVAS_DOMAIN'] ?? 'tjc.instructure.com';

// Demo-Safe Patch: Hard-wire default prefix to 'TWA'
$prefix = 'TWA'; // Always use TWA, ignore .env CURRICULUM_PREFIX

$courseId = $_GET['course_id'] ?? '';
$moduleId = $_GET['module_id'] ?? '';

// Demo-Safe Patch: Validate parameters and redirect to timer.php on error
if (!$courseId || !$moduleId || !$canvasToken) {
    header("Location: timer.php");
    exit;
}

// Demo-Safe Patch: Use dynamic domain from LTI parameters if provided
$canvasDomain = $_GET['canvas_domain'] ?? $canvasDomain;

$url = "https://$canvasDomain/api/v1/courses/$courseId/modules/$moduleId";
$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Authorization: Bearer $canvasToken"]);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$data = json_decode($response, true);
$moduleName = $data['name'] ?? 'Not Found';

// Extract the numeric pattern following "Unit" (case-insensitive)
// Matches: Unit 5.1, Unit 5.1.2, Unit 5.1.2.3, etc.
// Captures all numbers separated by dots
if (preg_match('/\bunit\s+([\d.]+)/i', $moduleName, $matches)) {
    $numericPart = $matches[1];
    
    // Split by dots to get all components
    $parts = explode('.', $numericPart);
    
    // Pad each part with leading zeros
    $paddedParts = array_map(function($part) {
        return str_pad($part, 2, '0', STR_PAD_LEFT);
    }, $parts);
    
    // Construct filter: PREFIX.XX.YY or PREFIX.XX.YY.ZZ etc.
    $filter = $prefix . '.' . implode('.', $paddedParts);
    
    // Store individual components for debugging
    $unit = $parts[0] ?? '';
    $section = $parts[1] ?? '';
    $subsection = isset($parts[2]) ? implode('.', array_slice($parts, 2)) : '';
} else {
    $filter = "";
    $unit = "";
    $section = "";
    $subsection = "";
}

$output = [
    'module_name' => $moduleName,
    'unit' => $unit,
    'section' => $section,
    'filter' => $filter,
    'http_code' => $httpCode,
    'prefix_used' => $prefix
];

echo json_encode($output);
?>