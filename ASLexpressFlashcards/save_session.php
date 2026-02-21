<?php
header("Content-Type: application/json");

$inputRaw = file_get_contents('php://input');
$input = json_decode($inputRaw, true);

if (!$input) {
    echo json_encode(['success' => false, 'error' => 'No data received']);
    exit;
}

$score = $input['score'] ?? 0;
$total = $input['total'] ?? 0;
$mode = $input['mode'] ?? 'tutorial';
$playlist = $input['playlist_title'] ?? 'Unknown Deck';

$percentage = ($total > 0) ? ($score / $total) * 100 : 0;

if ($mode === 'tutorial') {
    $points = 0;
    $comment = "Tutorial completed: $playlist. (Tutorials are non-graded practice)";
} else {
    $points = $percentage; 
    $comment = "Completed $mode: $playlist. Score: $score/$total (" . round($percentage, 1) . "%)";
}

$payload = [
    'submission' => [
        'submission_type' => 'external_tool',
        'body' => $comment,
        'posted_grade' => $points . "%"
    ]
];

echo json_encode([
    'success' => true,
    'canvas_payload' => $payload,
    'is_graded' => ($mode !== 'tutorial')
]);