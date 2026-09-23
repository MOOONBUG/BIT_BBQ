$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$stage = 'decrypt local credentials'
try {
    $root = Split-Path $PSScriptRoot -Parent
    $encrypted = [IO.File]::ReadAllBytes((Join-Path $root '.cloud-setup/zoho-oauth.dpapi'))
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { $credentials = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
    $stage = 'refresh access token'
    $token = Invoke-RestMethod -Method Post -Uri 'https://accounts.zoho.com/oauth/v2/token' -MaximumRedirection 0 -TimeoutSec 25 -Body @{
        grant_type = 'refresh_token'
        client_id = $credentials.client_id
        client_secret = $credentials.client_secret
        refresh_token = $credentials.refresh_token
    }
    if (!$token.access_token) { throw 'Token unavailable' }
    $stage = 'read account metadata'
    $accounts = Invoke-RestMethod -Method Get -Uri 'https://mail.zoho.com/api/accounts' -MaximumRedirection 0 -TimeoutSec 25 -Headers @{
        Authorization = ('Zoho-oauthtoken ' + $token.access_token)
    }
    if ($accounts.status.code -ne 200 -or !$accounts.data) { throw 'Account metadata unavailable' }
    $safe = @($accounts.data | ForEach-Object {
        [pscustomobject]@{
            accountId = [string]$_.accountId
            primaryEmailAddress = $_.primaryEmailAddress
            mailboxAddress = $_.mailboxAddress
            accountType = $_.accountType
            sendMailDetails = @($_.sendMailDetails | ForEach-Object {
                [pscustomobject]@{ fromAddress = $_.fromAddress; status = $_.status }
            })
        }
    })
    $safe | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root '.cloud-setup/zoho-account-verification.json') -Encoding UTF8
    [pscustomobject]@{ verified = $true; accounts = $safe; emailSent = $false } | ConvertTo-Json -Depth 6
} catch {
    # Never print exceptions: provider bodies and request metadata may contain secrets.
    [pscustomobject]@{ verified = $false; stage = $stage; emailSent = $false } | ConvertTo-Json
    exit 1
} finally {
    $credentials = $null; $token = $null; $accounts = $null
}
