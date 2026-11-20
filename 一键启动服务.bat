@echo off
chcp 65001 >nul
title LAN File Share Launcher
cd /d "%~dp0"

set "FIREWALL_ONLY=0"
if /I "%~1"=="/FIREWALLONLY" set "FIREWALL_ONLY=1"
if "%FIREWALL_ONLY%"=="1" goto FIREWALL_RULES

echo Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

netstat -ano | findstr ":9988" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Service is already running.
  goto SERVICE_READY
)

echo Starting service on port 9988...
start "LAN File Share - 9988" /min cmd /k node server.js
ping -n 3 127.0.0.1 >nul

netstat -ano | findstr ":9988" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo Failed to start service. Check the minimized window: LAN File Share - 9988
  pause
  exit /b 1
)

:SERVICE_READY
echo Service is running.

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting admin rights for firewall check...
  start "" /min powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '/FIREWALLONLY' -Verb RunAs" >nul 2>&1
  goto OPEN_BROWSER
)

:FIREWALL_RULES
set "RULE_IN=LAN File Share 9988 In"
set "RULE_OUT=LAN File Share 9988 Out"

echo Checking firewall rules...

netsh advfirewall firewall show rule name="%RULE_IN%" >nul 2>&1
if errorlevel 1 (
  echo Adding firewall inbound rule: %RULE_IN%
  netsh advfirewall firewall add rule name="%RULE_IN%" dir=in action=allow protocol=TCP localport=9988 profile=any >nul
  if errorlevel 1 (
    echo Failed to add inbound rule.
    if "%FIREWALL_ONLY%"=="1" exit /b 1
    goto OPEN_BROWSER
  )
) else (
  echo Inbound rule already exists and enabled: %RULE_IN%
  netsh advfirewall firewall set rule name="%RULE_IN%" new enable=Yes action=allow >nul
)

netsh advfirewall firewall show rule name="%RULE_OUT%" >nul 2>&1
if errorlevel 1 (
  echo Adding firewall outbound rule: %RULE_OUT%
  netsh advfirewall firewall add rule name="%RULE_OUT%" dir=out action=allow protocol=TCP localport=9988 profile=any >nul
  if errorlevel 1 (
    echo Failed to add outbound rule.
    if "%FIREWALL_ONLY%"=="1" exit /b 1
    goto OPEN_BROWSER
  )
) else (
  echo Outbound rule already exists and enabled: %RULE_OUT%
  netsh advfirewall firewall set rule name="%RULE_OUT%" new enable=Yes action=allow >nul
)

if "%FIREWALL_ONLY%"=="1" exit /b 0

:OPEN_BROWSER
echo Local URL: http://localhost:9988
echo LAN URL: http://192.168.1.5:9988
start "" http://localhost:9988
exit /b 0
