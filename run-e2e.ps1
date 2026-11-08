# Single-command Windows browser E2E runner. Use from the project folder:
# powershell -ExecutionPolicy Bypass -File .\run-e2e.ps1
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $project
try {
  Write-Host '[1/4] Validate isolated main and test database configuration...' -ForegroundColor Cyan
  node --env-file=.env scripts/check-env.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Environment validation failed. Fix .env; never share your DB password.' }

  Write-Host '[2/4] Install browser test dependency (only if missing)...' -ForegroundColor Cyan
  if (-not (Test-Path '.\node_modules\@playwright\test\cli.js')) {
    npm install --no-save --no-package-lock '@playwright/test'
    if ($LASTEXITCODE -ne 0) { throw 'Could not install @playwright/test' }
  }
  Write-Host 'Ensure Chromium is available for Playwright...' -ForegroundColor Cyan
  node .\node_modules\@playwright\test\cli.js install chromium
  if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed' }

  Write-Host '[3/4] Fresh backend and frontend production build...' -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build/typecheck failed' }

  Write-Host '[4/4] Run browser UAT against slotbook_ts_test on port 3101...' -ForegroundColor Cyan
  node --env-file=.env .\node_modules\@playwright\test\cli.js test -c playwright.config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'One or more browser E2E tests failed; see playwright-report and test-results' }
  Write-Host 'PASS: all automated Slotbook browser UAT tests passed.' -ForegroundColor Green
}
finally {
  Pop-Location
}
