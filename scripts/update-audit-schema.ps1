$ErrorActionPreference = "Stop"

$Path = "C:\iau-deeds-backend-only\prisma\schema.prisma"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$OldText = [System.Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String("bW9kZWwgQXVkaXRMb2cgewogIGlkICAgICAgICBTdHJpbmcgICBAaWQgQGRlZmF1bHQoY3VpZCgpKQogIGFjdGlvbiAgICBTdHJpbmcKICBlbnRpdHkgICAgU3RyaW5nCiAgZW50aXR5SWQgIFN0cmluZz8KICB1c2VySWQgICAgU3RyaW5nPwogIGRldGFpbHMgICBKc29uPwogIGNyZWF0ZWRBdCBEYXRlVGltZSBAZGVmYXVsdChub3coKSkKfQ==")
)
$NewText = [System.Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String("bW9kZWwgQXVkaXRMb2cgewogIGlkICAgICAgICAgICAgU3RyaW5nICAgQGlkIEBkZWZhdWx0KGN1aWQoKSkKICB1c2VySWQgICAgICAgIFN0cmluZz8KICB1c2VybmFtZSAgICAgIFN0cmluZz8KICB1c2VyRW1haWwgICAgIFN0cmluZz8KICB1c2VyUm9sZSAgICAgIFN0cmluZz8KICBhY3Rpb24gICAgICAgIFN0cmluZwogIG1vZHVsZSAgICAgICAgU3RyaW5nCiAgZW50aXR5ICAgICAgICBTdHJpbmc/CiAgZW50aXR5SWQgICAgICBTdHJpbmc/CiAgZW50aXR5TGFiZWwgICBTdHJpbmc/CiAgc3RhdHVzICAgICAgICBTdHJpbmcgICBAZGVmYXVsdCgic3VjY2VzcyIpCiAgZGVzY3JpcHRpb24gICBTdHJpbmc/CiAgZGV0YWlscyAgICAgICBKc29uPwogIHByZXZpb3VzRGF0YSAgSnNvbj8KICBuZXdEYXRhICAgICAgIEpzb24/CiAgbWV0YWRhdGEgICAgICBKc29uPwogIGlwQWRkcmVzcyAgICAgU3RyaW5nPwogIHVzZXJBZ2VudCAgICAgU3RyaW5nPwogIGVycm9yTWVzc2FnZSAgU3RyaW5nPwogIGNyZWF0ZWRBdCAgICAgRGF0ZVRpbWUgQGRlZmF1bHQobm93KCkpCgogIEBAaW5kZXgoW3VzZXJJZF0pCiAgQEBpbmRleChbYWN0aW9uXSkKICBAQGluZGV4KFttb2R1bGVdKQogIEBAaW5kZXgoW3N0YXR1c10pCiAgQEBpbmRleChbY3JlYXRlZEF0XSkKfQ==")
)

if (-not (Test-Path -LiteralPath $Path)) {
  throw "schema.prisma not found."
}

$Content = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)

if ($Content.Contains($NewText)) {
  Write-Host "AuditLog schema already updated."
  exit 0
}

if (-not $Content.Contains($OldText)) {
  throw "Current AuditLog model does not match the expected model."
}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $Path "$Path.backup-$Stamp" -Force

$Content = $Content.Replace($OldText, $NewText)
[IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)

Write-Host "AuditLog schema updated."
