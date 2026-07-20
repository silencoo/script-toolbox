<?php

declare(strict_types=1);

function generateRandomPassword(int $length = 20): string
{
    $safeCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+';
    $charSetLength = strlen($safeCharacters);
    $password = '';

    for ($i = 0; $i < $length; $i++) {
        $password .= $safeCharacters[random_int(0, $charSetLength - 1)];
    }

    return $password;
}

$plain = generateRandomPassword();
$hash = password_hash($plain, PASSWORD_BCRYPT);

echo 'ADMIN_PASSWORD_PLAIN=' . escapeshellarg($plain) . PHP_EOL;
echo 'ADMIN_PASSWORD_HASH=' . escapeshellarg($hash) . PHP_EOL;
