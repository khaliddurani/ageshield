# Manual Idura Age Verification test (Windows PowerShell 5.1 compatible). Dev tool only: never deployed (wrangler ships worker/ + web/dist only).
#
# 1. New login (prints the authorize URL and the PKCE code_verifier, saves verifier/state/nonce to .idura-test.json):
#      .\scripts\dev\idura-test.ps1 -New                          # DK, is_over_18
#      .\scripts\dev\idura-test.ps1 -New -Country SE -MinAge 18
# 2. Open the URL, log in. The browser lands on http://localhost:8787/oidc/callback?code=...&state=...
#    (an error page is fine if nothing runs locally). Copy the full address bar URL, then within a minute or two:
#      .\scripts\dev\idura-test.ps1 -CallbackUrl 'http://localhost:8787/oidc/callback?code=...&state=...'
#    It exchanges the code (client secret read from .dev.vars, never printed) and prints the id_token header and claims.
#    Tokens themselves are never printed. The id_token signature is NOT verified here (the Worker does that with JWKS).
[CmdletBinding(DefaultParameterSetName = 'New')]
param(
  [Parameter(ParameterSetName = 'New')][switch]$New,
  [Parameter(ParameterSetName = 'New')][ValidateSet('DK', 'SE', 'NO', 'FI')][string]$Country = 'DK',
  [Parameter(ParameterSetName = 'New')][ValidateSet(15, 16, 18, 21)][int]$MinAge = 18,
  [Parameter(ParameterSetName = 'Exchange', Mandatory = $true)][string]$CallbackUrl
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$stateFile = Join-Path $root '.idura-test.json'
$redirectUri = 'http://localhost:8787/oidc/callback'

function Read-DevVars {
  $path = Join-Path $root '.dev.vars'
  $vars = @{}
  if (Test-Path $path) {
    foreach ($line in [IO.File]::ReadAllLines($path)) {
      if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
      $i = $line.IndexOf('=')
      $vars[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim().Trim('"')
    }
  }
  return $vars
}

function ConvertTo-Base64Url([byte[]]$bytes) {
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-Base64Url([string]$value) {
  $s = $value.Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}

function New-RandomBase64Url([int]$byteCount) {
  $bytes = New-Object byte[] $byteCount
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($bytes)
  return ConvertTo-Base64Url $bytes
}

$vars = Read-DevVars
$domain = if ($vars['IDURA_DOMAIN']) { $vars['IDURA_DOMAIN'] } else { 'merchantkits.test.idura.broker' }
$clientId = if ($vars['IDURA_CLIENT_ID']) { $vars['IDURA_CLIENT_ID'] } else { 'urn:merchantkits:ageshield' }

if ($PSCmdlet.ParameterSetName -eq 'New') {
  $verifier = New-RandomBase64Url 32          # 43 chars (RFC 7636: 43-128)
  $sha = [Security.Cryptography.SHA256]::Create()
  $challenge = ConvertTo-Base64Url ($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier)))
  $state = New-RandomBase64Url 32
  $nonce = New-RandomBase64Url 32
  $scope = "openid is_over_$MinAge"

  $query = [ordered]@{
    response_type         = 'code'
    response_mode         = 'query'
    client_id             = $clientId
    redirect_uri          = $redirectUri
    scope                 = $scope
    acr_values            = 'urn:age-verification'
    login_hint            = "country:$Country"
    state                 = $state
    nonce                 = $nonce
    code_challenge        = $challenge
    code_challenge_method = 'S256'
  }
  $qs = ($query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([Uri]::EscapeDataString($_.Value))" }) -join '&'
  $url = "https://$domain/oauth2/authorize?$qs"

  $saved = @{ verifier = $verifier; state = $state; nonce = $nonce; country = $Country; minAge = $MinAge; createdAt = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText($stateFile, ($saved | ConvertTo-Json))

  Write-Host ''
  Write-Host "Authorize URL ($Country, $scope):" -ForegroundColor Cyan
  Write-Host $url
  Write-Host ''
  Write-Host "code_verifier: $verifier"
  Write-Host "state:         $state"
  Write-Host "nonce:         $nonce"
  Write-Host ''
  Write-Host "Saved to $stateFile (git-ignored). After logging in, run:" -ForegroundColor Cyan
  Write-Host "  .\scripts\dev\idura-test.ps1 -CallbackUrl '<full callback URL from the address bar>'"
  return
}

# --- Exchange -------------------------------------------------------------------------------------------------------
if (-not (Test-Path $stateFile)) { throw 'No .idura-test.json: run with -New first.' }
$saved = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json

$params = @{}
$queryPart = ([Uri]$CallbackUrl).Query.TrimStart('?')
foreach ($pair in $queryPart.Split('&')) {
  if (-not $pair) { continue }
  $kv = $pair.Split('=', 2)
  $params[[Uri]::UnescapeDataString($kv[0])] = if ($kv.Length -gt 1) { [Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) } else { '' }
}

if ($params['error']) {
  Write-Host "Idura returned an error (no code): error=$($params['error'])" -ForegroundColor Yellow
  if ($params['error_description']) { Write-Host "error_description=$($params['error_description'])" }
  return
}
if (-not $params['code']) { throw 'The callback URL has no code parameter.' }
if ($params['state'] -ne $saved.state) { throw 'state does not match the saved login (stale URL or another -New run).' }

$secret = $vars['IDURA_CLIENT_SECRET']
if (-not $secret) { throw 'IDURA_CLIENT_SECRET is missing in .dev.vars.' }

# Idura PKCE docs: confidential client = Basic base64(urlencode(client_id):urlencode(client_secret)) + code_verifier.
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
    "$([Uri]::EscapeDataString($clientId)):$([Uri]::EscapeDataString($secret))"))
$body = @(
  'grant_type=authorization_code',
  "code=$([Uri]::EscapeDataString($params['code']))",
  "client_id=$([Uri]::EscapeDataString($clientId))",
  "redirect_uri=$([Uri]::EscapeDataString($redirectUri))",
  "code_verifier=$([Uri]::EscapeDataString($saved.verifier))"
) -join '&'

try {
  $res = Invoke-RestMethod -Method Post -Uri "https://$domain/oauth2/token" `
    -Headers @{ Authorization = "Basic $basic"; Accept = 'application/json' } `
    -ContentType 'application/x-www-form-urlencoded' -Body $body
} catch {
  $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  Write-Host "Token request failed: $detail" -ForegroundColor Red
  return
} finally {
  $secret = $null; $basic = $null
}

if (-not $res.id_token) { throw 'Token response has no id_token.' }
$parts = $res.id_token.Split('.')
$header = ConvertFrom-Base64Url $parts[0] | ConvertFrom-Json
$claims = ConvertFrom-Base64Url $parts[1] | ConvertFrom-Json

Write-Host ''
Write-Host "Token response fields: $(($res.PSObject.Properties.Name) -join ', ') (values not printed)" -ForegroundColor Cyan
Write-Host 'id_token header:' -ForegroundColor Cyan
$header | ConvertTo-Json
Write-Host 'id_token claims:' -ForegroundColor Cyan
$claims | ConvertTo-Json -Depth 10
Write-Host ''
Write-Host "nonce matches: $($claims.nonce -eq $saved.nonce)   aud: $($claims.aud)   iss: $($claims.iss)"
$expires = [DateTimeOffset]::FromUnixTimeSeconds([int64]$claims.exp).ToLocalTime()
Write-Host "exp: $expires"
Remove-Item $stateFile   # single use, like the Worker's oidc_states row
