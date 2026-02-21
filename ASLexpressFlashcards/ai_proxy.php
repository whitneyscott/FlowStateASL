<?php
header('Content-Type: application/json');

$apiKey = "e8hg6L0detVqNwU6MHqF91FDzAHm2O3g3wo9oL21";

$inputRaw = file_get_contents('php://input');
$input = json_decode($inputRaw, true);

$ch = curl_init("https://api.cohere.ai/v1/rerank");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
    "model" => "rerank-v3.5",
    "query" => $input['query'],
    "documents" => $input['documents'],
    "top_n" => 1
]));
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Authorization: Bearer $apiKey",
    "Content-Type: application/json"
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

http_response_code($httpCode);
echo $response;