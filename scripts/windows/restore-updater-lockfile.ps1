param(
  [string[]]$ProjectRoots = @(
    "C:\Apps\escarlet-local-ai-ui",
    "C:\Apps\local-ai-remote"
  )
)

$ErrorActionPreference = "Stop"
$root = $ProjectRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ ".git") } | Select-Object -First 1
if (-not $root) {
  throw "No Git checkout was found in $($ProjectRoots -join ', ')."
}

Set-Location -LiteralPath $root
Write-Host "Checkout: $root"
git status --short --untracked-files=no
git restore --worktree --source=HEAD -- package-lock.json
if ($LASTEXITCODE -ne 0) { throw "git restore --worktree failed" }
git restore --staged -- package-lock.json
if ($LASTEXITCODE -ne 0) { throw "git restore --staged failed" }
Write-Host "Remaining tracked changes:"
git status --short --untracked-files=no
Write-Host "package-lock.json restored to HEAD. Retry Install and restart in the System page."
