$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$root = Split-Path $PSScriptRoot -Parent
try {
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $root '.cloud-setup/zoho-oauth.dpapi')), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { $credentials = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
    if (!$credentials.client_id -or !$credentials.client_secret -or !$credentials.refresh_token) { throw 'Missing credentials' }
    $json = @{ZOHO_CLIENT_ID=$credentials.client_id; ZOHO_CLIENT_SECRET=$credentials.client_secret; ZOHO_REFRESH_TOKEN=$credentials.refresh_token} | ConvertTo-Json -Compress
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command node.exe).Source
    $start.Arguments = 'node_modules/wrangler/bin/wrangler.js secret bulk --config wrangler.api.json'
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine($json)
    $process.StandardInput.Close()
    $process.WaitForExit()
    # Do not relay subprocess output when handling credentials.
    if ($process.ExitCode -ne 0) { throw 'Secret installation failed' }
    Write-Output 'Installed the three Zoho secrets on mooon-enquiries. Values hidden.'
} catch {
    Write-Output 'Zoho secret installation not confirmed. No secret values printed.'
    exit 1
} finally { $credentials=$null; $json=$null; $stdout=$null; $stderr=$null }
