$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Read-PrivateValue([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

Write-Host 'Zoho .com connection setup - no email will be sent.'
Write-Host 'Input is hidden. Paste each value and press Enter.'
Write-Host 'Only enter values from your own Zoho Self Client.'
$stage = 'input'
try {
    $clientId = Read-PrivateValue 'Client ID'
    $clientSecret = Read-PrivateValue 'Client Secret'
    Write-Host 'Now generate a NEW code in Zoho with scopes:'
    Write-Host 'ZohoMail.messages.CREATE,ZohoMail.accounts.READ'
    $code = Read-PrivateValue 'Fresh authorization code (paste before it expires)'
    if (!$clientId -or !$clientSecret -or !$code) { throw 'Missing input' }
    $stage = 'token exchange'
    $token = Invoke-RestMethod -Method Post -Uri 'https://accounts.zoho.com/oauth/v2/token' -MaximumRedirection 0 -TimeoutSec 25 -Body @{
        grant_type = 'authorization_code'
        client_id = $clientId
        client_secret = $clientSecret
        code = $code
    }
    if (!$token.refresh_token -or !$token.access_token) { throw 'Token exchange not confirmed' }
    $stage = 'encrypted local save'
    $directory = Join-Path (Split-Path $PSScriptRoot -Parent) '.cloud-setup'
    [void][IO.Directory]::CreateDirectory($directory)
    $destination = Join-Path $directory 'zoho-oauth.dpapi'
    if (Test-Path -LiteralPath $destination) { throw 'An existing credential file is present; preserve it for review' }
    $payload = @{
        region = 'com'
        client_id = $clientId
        client_secret = $clientSecret
        refresh_token = $token.refresh_token
        created_at = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress
    $plain = [Text.Encoding]::UTF8.GetBytes($payload)
    try {
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $file = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($encrypted, 0, $encrypted.Length) } finally { $file.Dispose() }
    } finally { [Array]::Clear($plain, 0, $plain.Length) }
    Write-Host 'SUCCESS: authorization saved encrypted for this Windows user.' -ForegroundColor Green
    Write-Host 'No email sent. No production setting changed. Tell Codex: Zoho local setup succeeded.'
} catch {
    Write-Host ('Setup did not complete at: ' + $stage) -ForegroundColor Yellow
    Write-Host 'Provider response and secrets are hidden. Tell Codex the stage shown above.'
    Write-Host 'If token exchange failed, check the client values and generate a fresh code before retrying.'
} finally {
    $clientId = $null; $clientSecret = $null; $code = $null; $token = $null; $payload = $null
}
[void](Read-Host 'Press Enter to close')
