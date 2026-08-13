@echo off
REM ===========================================================================
REM  Noctua - Lancement (Windows)
REM  Usage : start.bat [indigo_host:port]
REM ===========================================================================
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
    echo [ERREUR] Environnement non initialise. Lancez d'abord install.bat
    exit /b 1
)

call ".venv\Scripts\activate.bat"
python run.py %*
endlocal