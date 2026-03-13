$ErrorActionPreference = 'Stop'

$baseApi = if ($env:BASE_API) { $env:BASE_API } else { 'https://login.charlott.ai/api' }
$hardeningToken = if ($env:HARDENING_TOKEN) { $env:HARDENING_TOKEN } elseif ($env:WA_HARDENING_TOKEN) { $env:WA_HARDENING_TOKEN } else { '' }
$failOnAlert = if ($env:FAIL_ON_ALERT) { $env:FAIL_ON_ALERT } else { '0' }

function Pass($msg) { Write-Host "[OK] $msg" }
function Warn($msg) { Write-Host "[WARN] $msg" }
function Fail($msg) { throw "[FAIL] $msg" }

$healthUrl = "$($baseApi.TrimEnd('/'))/../health"
$healthResp = Invoke-WebRequest -Uri $healthUrl -Method GET -UseBasicParsing
if ($healthResp.StatusCode -ne 200) { Fail "Backend health code=$($healthResp.StatusCode)" }
Pass "Backend health responde 200"

if ([string]::IsNullOrWhiteSpace($hardeningToken)) {
  Warn "HARDENING_TOKEN/WA_HARDENING_TOKEN no configurado. Salteando consulta protegida /whatsapp-cloud/webhook/hardening"
  Write-Host "HARDENING_SMOKE_PARTIAL"
  exit 0
}

$hardeningUrl = "$($baseApi.TrimEnd('/'))/whatsapp-cloud/webhook/hardening?failOnAlert=$failOnAlert"
$headers = @{ 'x-hardening-token' = $hardeningToken }

try {
  $raw = Invoke-RestMethod -Uri $hardeningUrl -Method GET -Headers $headers
  $statusCode = 200
} catch {
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__) {
    $statusCode = [int]$_.Exception.Response.StatusCode.value__
  } else {
    throw
  }

  if ($statusCode -ne 503) {
    throw
  }

  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  $json = $reader.ReadToEnd()
  $raw = $json | ConvertFrom-Json
}

$required = @(
  'health',
  'summary',
  'inbound',
  'outbound',
  'alerts',
  'signatureHardening',
  'webhookPayloadReplayHardening',
  'outboundRetryHardening'
)

foreach ($k in $required) {
  if (-not $raw.PSObject.Properties.Name.Contains($k)) {
    Fail "Falta campo esperado en hardening: $k"
  }
}

if (-not $raw.inbound.counters.PSObject.Properties.Name.Contains('inbound.replay_blocked')) {
  Fail "Falta métrica inbound.replay_blocked"
}
if (-not $raw.outbound.counters.PSObject.Properties.Name.Contains('outbound.duplicate_blocked')) {
  Fail "Falta métrica outbound.duplicate_blocked"
}

Write-Host ("health_status=" + $raw.health.status)
if ($statusCode -eq 503) {
  Warn "Hardening endpoint respondió 503 (failOnAlert activo y hay alertas)."
} else {
  Pass "Hardening endpoint respondió OK"
}

Write-Host "HARDENING_SMOKE_OK"