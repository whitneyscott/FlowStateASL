<?php
// Load .env file manually
if (file_exists(__DIR__ . '/.env')) {
    $lines = file(__DIR__ . '/.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        // Skip comments and empty lines
        if (strpos(trim($line), '#') === 0 || empty(trim($line))) {
            continue;
        }
        if (strpos($line, '=') !== false) {
            list($key, $value) = explode('=', $line, 2);
            // Remove quotes if present
            $value = trim($value);
            $value = trim($value, '"\'');
            putenv(trim($key) . '=' . $value);
        }
    }
}

error_reporting(E_ALL);
ini_set('display_errors', 1);
header('Content-Type: application/json');

$inputRaw = file_get_contents('php://input');
$input = json_decode($inputRaw, true);

// Get token from environment variable
$hfToken = getenv('HUGGINGFACE_TOKEN');

if (!$hfToken) {
    echo json_encode(['error' => 'Server Configuration Error: HUGGINGFACE_TOKEN not found in environment.']);
    exit;
}

if (!$input) {
    echo json_encode(['error' => 'No input received by proxy.']);
    exit;
}

if (!function_exists('curl_init')) {
    echo json_encode(['error' => 'PHP cURL extension is not installed on this server.']);
    exit;
}

// Use the new hf-inference provider endpoint format
$ch = curl_init("https://router.huggingface.co/hf-inference/models/cross-encoder/ms-marco-MiniLM-L-6-v2");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($input));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: Bearer $hfToken",
    "Content-Type: application/json"
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

// Log the HTTP status code and response
error_log("HF API HTTP Code: " . $httpCode);
error_log("HF API Response: " . $response);

if ($err) {
    echo json_encode(['error' => 'cURL Error: ' . $err]);
} elseif ($httpCode !== 200) {
    echo json_encode(['error' => 'HTTP ' . $httpCode . ': ' . $response]);
} else {
    echo $response;
}
?>