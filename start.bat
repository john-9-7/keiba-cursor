@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================
echo  競馬予想ツールを起動します
echo ========================================
echo.

start "keiba-server" cmd /c "npm start"

set "APP_URL="
for /l %%P in (3000,1,3010) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:%%P' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if !errorlevel! equ 0 (
    set "APP_URL=http://localhost:%%P"
    goto :OPEN
  )
  timeout /t 1 /nobreak >nul
)

:OPEN
if defined APP_URL (
  echo 開くURL: %APP_URL%
  start "" "%APP_URL%"
) else (
  echo.
  echo サーバーの起動を確認できませんでした。
  echo 10秒ほど待ってから次を開いてください:
  echo   http://localhost:3000
  echo   http://localhost:3001
)

echo.
echo このウィンドウは閉じても問題ありません。
endlocal
