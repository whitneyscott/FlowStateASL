<?php
if (function_exists('opcache_reset')) {
    opcache_reset();
}

$debugMode = isset($_GET['debug']);

function loadEnv($path) {
    if (!file_exists($path)) return false;
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), '#') === 0 || !strpos($line, '=')) continue;
        list($name, $value) = explode('=', $line, 2);
        $_ENV[trim($name)] = trim($value);
    }
}

// Demo-Safe Patch: Handle POST requests (LTI launches) by redirecting to timer.php
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    header("Location: timer.php");
    exit;
}

function isBlacklisted($title) {
    $blacklist = ['exam', 'test', 'sentence'];
    
    foreach ($blacklist as $term) {
        if (stripos($title, $term) !== false) {
            return true;
        }
    }
    return false;
}

function getSmartVersions($input) {
    error_log("=== getSmartVersions DEBUG ===");
    error_log("Input: " . $input);
    
    // Match patterns like: TWA.05.01, TWA.05.01.02, etc.
    // Extracts the prefix and all numeric components
    if (preg_match('/^([A-Z]+)[.\s]+([\d.]+)$/i', $input, $matches)) {
        error_log("Regex matched!");
        error_log("Matches: " . print_r($matches, true));
        
        $prefix = strtoupper($matches[1]);  // TWA
        $numericPart = $matches[2];          // 05.01 or 05.01.02
        
        error_log("Prefix: " . $prefix);
        error_log("Numeric part: " . $numericPart);
        
        // Split into parts
        $parts = explode('.', $numericPart);
        error_log("Parts: " . print_r($parts, true));
        
        // Generate variations:
        // TWA.05.01 (dots)
        // TWA 05.01 (space then dots)
        // TWA 05 01 (all spaces)
        
        $dotVersion = $prefix . '.' . implode('.', $parts);
        $spaceVersion = $prefix . ' ' . implode(' ', $parts);
        $mixedVersion = $prefix . ' ' . implode('.', $parts);
        
        $result = array_unique([
            $dotVersion,
            $spaceVersion,
            $mixedVersion
        ]);
        
        error_log("Generated search terms: " . print_r($result, true));
        return $result;
    }
    
    error_log("First regex didn't match, trying fallback...");
    
    // Fallback: if it starts with a known prefix, just use it as-is
    if (preg_match('/^[A-Z]{2,}/i', $input)) {
        error_log("Fallback matched, returning input as-is");
        return [$input];
    }
    
    error_log("No match at all, returning empty array");
    return [];
}

function fetchAllPlaylists($apiKey) {
    $allPlaylists = [];
    $page = 1;
    $perPage = 100;
    
    do {
        $ch = curl_init();
        $url = "https://api.sproutvideo.com/v1/playlists?per_page=$perPage&page=$page";
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['SproutVideo-Api-Key: ' . $apiKey]);
        $response = curl_exec($ch);
        $data = json_decode($response, true);
        curl_close($ch);
        
        $playlists = $data['playlists'] ?? [];
        $allPlaylists = array_merge($allPlaylists, $playlists);
        
        $hasMore = (count($playlists) == $perPage);
        $page++;
    } while ($hasMore && count($allPlaylists) < 500);
    
    return $allPlaylists;
}

loadEnv(__DIR__ . '/.env');
$apiKey = $_ENV['SPROUT_KEY'] ?? '';
$playlistId = $_GET['playlist_id'] ?? '';
$filter = $_GET['filter'] ?? '';

if (!$apiKey) die(json_encode(["error" => "API Key missing"]));

$output = [];

if ($playlistId) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, "https://api.sproutvideo.com/v1/playlists/$playlistId");
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['SproutVideo-Api-Key: ' . $apiKey]);
    $response = curl_exec($ch);
    $data = json_decode($response, true);
    curl_close($ch);
    
    if (isset($data['videos']) && is_array($data['videos'])) {
        foreach ($data['videos'] as $videoId) {
            $vch = curl_init();
            curl_setopt($vch, CURLOPT_URL, "https://api.sproutvideo.com/v1/videos/" . $videoId);
            curl_setopt($vch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($vch, CURLOPT_HTTPHEADER, ['SproutVideo-Api-Key: ' . $apiKey]);
            $vRes = curl_exec($vch);
            $vData = json_decode($vRes, true);
            curl_close($vch);
            $output[] = [
                'title' => (string)($vData['title'] ?? 'Vocabulary Item'),
                'embed' => (string)($vData['embed_code'] ?? '')
            ];
        }
    }
} else {
    $playlists = fetchAllPlaylists($apiKey);
    $searchTerms = getSmartVersions($filter);
    
    if (!empty($searchTerms)) {
        foreach ($playlists as $p) {
            $title = (string)$p['title'];
            
            if (isBlacklisted($title)) {
                continue;
            }
            
            foreach ($searchTerms as $term) {
                if (stripos($title, $term) === 0) {
                    $output[] = [
                        'title' => $title,
                        'id'    => (string)$p['id']
                    ];
                    break;
                }
            }
        }
    }
}

header('Content-Type: application/json');
echo json_encode($output);
?>