$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent
$receipt = Join-Path $root '.cloud-setup/zoho-test-receipt.json'
$attempt = Join-Path $root '.cloud-setup/zoho-test-attempt.json'
$stage = 'prepare'
try {
    if ((Test-Path $receipt) -or (Test-Path $attempt)) { throw 'Existing test attempt requires review; do not resend' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $root '.cloud-setup/zoho-oauth.dpapi')), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { $credentials = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
    $stage = 'refresh token'
    $token = Invoke-RestMethod -Method Post -Uri 'https://accounts.zoho.com/oauth/v2/token' -MaximumRedirection 0 -TimeoutSec 25 -Body @{
        grant_type='refresh_token'; client_id=$credentials.client_id; client_secret=$credentials.client_secret; refresh_token=$credentials.refresh_token
    }
    if (!$token.access_token) { throw 'Token unavailable' }
    $id = 'MSC-NOTIFY-TEST-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $payload = @{
        fromAddress='hello@mooonstoreclinic.top'; toAddress='hello@mooonstoreclinic.top'
        subject=('[MooonStoreClinic] Notification connection test - ' + $id)
        content=('This is the single authorized notification connection test. Reference: ' + $id + '. No customer data is included. No customer has been contacted, selected or charged.')
        mailFormat='plaintext'; encoding='UTF-8'; askReceipt='no'
    } | ConvertTo-Json
    @{reference=$id;attemptedAt=[DateTime]::UtcNow.ToString('o');recipient='hello@mooonstoreclinic.top'} | ConvertTo-Json | Set-Content $attempt -Encoding UTF8
    $stage = 'send test - reconcile before any retry'
    $response = Invoke-RestMethod -Method Post -Uri 'https://mail.zoho.com/api/accounts/8336391000000008002/messages' -MaximumRedirection 0 -TimeoutSec 25 -ContentType 'application/json; charset=utf-8' -Headers @{Authorization=('Zoho-oauthtoken '+$token.access_token)} -Body ([Text.Encoding]::UTF8.GetBytes($payload))
    if ($response.status.code -ne 200 -or !$response.data.messageId) { throw 'Acceptance not confirmed' }
    $result = @{accepted=$true;messageId=[string]$response.data.messageId;reference=$id;recipient='hello@mooonstoreclinic.top';acceptedAt=[DateTime]::UtcNow.ToString('o');inboxDeliveryVerified=$false}
    $result | ConvertTo-Json | Set-Content $receipt -Encoding UTF8
    $result | ConvertTo-Json
} catch {
    @{accepted=$false;stage=$stage;automaticRetry=$false} | ConvertTo-Json
    exit 1
} finally { $credentials=$null; $token=$null; $response=$null }
