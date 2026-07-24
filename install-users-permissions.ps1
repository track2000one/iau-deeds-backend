$ErrorActionPreference = "Stop"

$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendSource = Join-Path $PackageRoot "backend"
$FrontendSource = Join-Path $PackageRoot "frontend"

$BackendTarget = "C:\iau-deeds-backend-only"
$FrontendTarget = "C:\iau-deeds-lands-platform"

function Copy-WithBackup(
    [string]$Source,
    [string]$Target
) {
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

$BackendFiles = @(
    "package.json",
    "prisma\schema.prisma",
    "src\app.js",
    "src\server.js",
    "src\bootstrapAdmin.js",
    "src\security\auth.js",
    "src\middleware\auth.js",
    "src\middleware\errorHandler.js",
    "src\routes\auth.routes.js",
    "src\routes\users.routes.js"
)

foreach ($RelativePath in $BackendFiles) {
    Copy-WithBackup `
        (Join-Path $BackendSource $RelativePath) `
        (Join-Path $BackendTarget $RelativePath)
}

$FrontendFiles = @(
    "src\types\permissions.ts",
    "src\lib\authStorage.ts",
    "src\lib\http.ts",
    "src\lib\api.ts",
    "src\context\AuthContext.tsx",
    "src\app\App.tsx",
    "src\app\Root.tsx",
    "src\app\components\RequireAdmin.tsx",
    "src\app\pages\AdminDashboardPage.tsx",
    "src\app\routes.tsx"
)

foreach ($RelativePath in $FrontendFiles) {
    Copy-WithBackup `
        (Join-Path $FrontendSource $RelativePath) `
        (Join-Path $FrontendTarget $RelativePath)
}

& powershell -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $FrontendSource "apply-permission-ui-patches.ps1")

& powershell -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $FrontendSource "apply-archive-migration-guard.ps1")

Write-Host ""
Write-Host "DONE: users and permissions files installed."
Write-Host "Next steps are listed in README-AR.txt."
