@echo off
rem Deploys the ERP Hub to AWS Lambda (Serverless Framework), like deploy-erp-gateway-lambda.bat.
rem
rem   deploy-erp-hub-lambda.bat            -> stage "staging" (QuickBooks sandbox)
rem   deploy-erp-hub-lambda.bat prod       -> stage "prod"
rem
rem Needs a file "deploy.env" next to this script (git-ignored; copy deploy.env.example):
rem   FRONTEND_RETURN_URL, APP_BASE_URL, ALERT_EMAIL
rem and the stage's secret in AWS Secrets Manager (once per stage: npm run secrets -- --stage staging).

setlocal
cd /d "%~dp0"

set "STAGE=staging"
if /i "%~1"=="prod" set "STAGE=prod"

rem The system default Node can be too old; prefer the Node 22 install if it exists.
if exist "%LOCALAPPDATA%\nvm\v22.17.1\node.exe" set "PATH=%LOCALAPPDATA%\nvm\v22.17.1;%PATH%"

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODEMAJOR=%%v"
set "NODEMAJOR=%NODEMAJOR:v=%"
if %NODEMAJOR% LSS 20 (
  echo ERROR: Node 20 or newer is required, found v%NODEMAJOR%. Run "nvm use 22" and try again.
  exit /b 1
)

if not exist deploy.env (
  echo ERROR: deploy.env not found. Copy deploy.env.example to deploy.env and fill it in.
  exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("deploy.env") do set "%%a=%%b"

if "%FRONTEND_RETURN_URL%"=="" ( echo ERROR: FRONTEND_RETURN_URL is not set in deploy.env & exit /b 1 )
if "%APP_BASE_URL%"=="" ( echo ERROR: APP_BASE_URL is not set in deploy.env & exit /b 1 )
if "%ALERT_EMAIL%"=="" ( echo ERROR: ALERT_EMAIL is not set in deploy.env & exit /b 1 )

echo.
echo === ERP Hub: stage %STAGE%  ===
echo Return URL : %FRONTEND_RETURN_URL%
echo App URL    : %APP_BASE_URL%
echo.

echo [1/4] Checking the stage secret exists in AWS Secrets Manager...
call aws secretsmanager describe-secret --secret-id biziship-erp-hub/%STAGE% --region us-east-1 >nul 2>&1
if errorlevel 1 (
  echo ERROR: secret biziship-erp-hub/%STAGE% not found, or AWS access failed.
  echo        Create it once with:  npm run secrets -- --stage %STAGE%
  exit /b 1
)

echo [2/4] Type check...
call npm run typecheck
if errorlevel 1 exit /b 1

echo [3/4] Tests...
call npm test
if errorlevel 1 exit /b 1

echo [4/4] Deploying...
if /i "%STAGE%"=="prod" (
  call npm run deploy:prod
) else (
  call npm run deploy
)
if errorlevel 1 exit /b 1

echo.
echo Deployed. Note the HubUrl and IntuitRedirectUri printed above:
echo   - register IntuitRedirectUri exactly in the Intuit app's Redirect URIs
echo   - set the web app's PRIVATE_ERP_HUB_URL to HubUrl
endlocal
