$ErrorActionPreference = "Stop"

$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendSource = Join-Path $PackageRoot "backend"
$FrontendSource = Join-Path $PackageRoot "frontend"

$BackendTarget = "C:\iau-deeds-backend-only"
$FrontendTarget = "C:\iau-deeds-lands-platform"

function Copy-WithBackup([string]$Source, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source file not found: $Source"
  }

  $TargetDirectory = Split-Path -Parent $Target
  New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null

  if (Test-Path -LiteralPath $Target) {
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $Target -Destination "$Target.backup-$Stamp" -Force
  }

  Copy-Item -LiteralPath $Source -Destination $Target -Force
  Write-Host "Copied: $Target"
}

& powershell -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $BackendSource "scripts\update-audit-schema.ps1")

$BackendFiles = @(
  "src\app.js",
  "src\middleware\audit.js",
  "src\services\audit.service.js",
  "src\routes\audit.routes.js",
  "src\routes\auth.routes.js"
)

foreach ($RelativePath in $BackendFiles) {
  Copy-WithBackup `
    (Join-Path $BackendSource $RelativePath) `
    (Join-Path $BackendTarget $RelativePath)
}

$FrontendFiles = @(
  "src\types\audit.ts",
  "src\app\pages\AuditLogPage.tsx"
)

foreach ($RelativePath in $FrontendFiles) {
  Copy-WithBackup `
    (Join-Path $FrontendSource $RelativePath) `
    (Join-Path $FrontendTarget $RelativePath)
}

& powershell -NoProfile -ExecutionPolicy Bypass `
  -File (Join-Path $FrontendSource "scripts\apply-audit-frontend-patches.ps1")

Write-Host ""
Write-Host "DONE: audit log system installed."
Write-Host "Read README-AR.txt for database, build, and Git commands."
