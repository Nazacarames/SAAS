$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
Write-Host "[verify] root: $root"

function Invoke-IfPackage {
  param(
    [string]$Dir,
    [string]$Label
  )

  $pkg = Join-Path $Dir "package.json"
  if (Test-Path $pkg) {
    Write-Host "[verify] $Label: npm ci"
    Push-Location $Dir
    try {
      npm ci
      $scripts = npm run 2>$null | Out-String

      if ($scripts -match "\stypecheck") { Write-Host "[verify] $Label: npm run typecheck"; npm run typecheck } else { Write-Host "[verify] $Label: typecheck missing (skip)" }
      if ($scripts -match "\slint") { Write-Host "[verify] $Label: npm run lint"; npm run lint } else { Write-Host "[verify] $Label: lint missing (skip)" }
      if ($scripts -match "\stest") { Write-Host "[verify] $Label: npm test"; npm test } else { Write-Host "[verify] $Label: test missing (skip)" }
      if ($scripts -match "\sbuild") { Write-Host "[verify] $Label: npm run build"; npm run build } else { Write-Host "[verify] $Label: build missing (skip)" }
    }
    finally {
      Pop-Location
    }
  }
  else {
    Write-Host "[verify] $Label: package.json missing (skip)"
  }
}

Invoke-IfPackage "backend" "backend"
Invoke-IfPackage "frontend" "frontend"
Write-Host "[verify] done"
