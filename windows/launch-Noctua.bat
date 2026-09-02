@echo off
REM Noctua — Lanceur Windows
REM Ouvre http://localhost:8080 apres demarrage

setlocal

if not exist "..\.venv\Scripts\activate.bat" (
    echo [ERREUR] .venv introuvable. Lancez d'abord windows\install.bat
    pause
    exit /b 1
)

call ..\.venv\Scripts\activate.bat

REM Config par defaut: indigo sur 127.0.0.1:7624 (ou utilisez le mock: start-mock-server.bat)
set INDIGO_HOST=127.0.0.1:7624
if not "%1"=="" set INDIGO_HOST=%1

echo Lancement Noctua — INDIGO %INDIGO_HOST% — Web http://localhost:8080
echo Ctrl+C pour arreter

REM Ouvre le navigateur apres 2s
start "" cmd /c timeout /t 2 /nobreak ^>nul ^& start http://localhost:8080

python ..\run.py %INDIGO_HOST% --port 8080

pause
endlocal
