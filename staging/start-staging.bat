@echo off
REM ==============================================================================
REM SakkuPay Staging Server Launcher (Windows)
REM Runs isolated staging server on port 3001 using environment file staging\.env.staging
REM ==============================================================================

if not exist "%~dp0.env.staging" (
  echo Error: staging\.env.staging not found.
  echo Please create staging\.env.staging with required staging secrets before running.
  exit /b 1
)

echo Starting SakkuPay Staging using staging\.env.staging...
node --env-file="%~dp0.env.staging" server.js
