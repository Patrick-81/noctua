@echo off
REM ===========================================================================
REM  Noctua - Script d'installation (Windows)
REM  Usage : install.bat
REM
REM  Ce script est concu pour evoluer au fil des ameliorations du projet.
REM  Il cree l'environnement Python, installe les dependances et prepare la config.
REM ===========================================================================
setlocal
cd /d "%~dp0"

set "PYTHON=python"
set "VENV_DIR=.venv"

REM --- 1. Verification de Python -------------------------------------------
where %PYTHON% >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Python introuvable ^(%PYTHON%^). Installez Python 3.10+ depuis python.org
    exit /b 1
)

%PYTHON% -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Python 3.10 ou plus recent est requis.
    %PYTHON% --version
    exit /b 1
)
echo [OK] Python %PYTHON%

REM --- 2. Environnement virtuel -------------------------------------------
if exist "%VENV_DIR%\Scripts\activate.bat" (
    echo [INFO] Environnement virtuel %VENV_DIR% deja present.
) else (
    echo [INFO] Creation de l'environnement virtuel %VENV_DIR%...
    %PYTHON% -m venv "%VENV_DIR%"
    if errorlevel 1 exit /b 1
)

call "%VENV_DIR%\Scripts\activate.bat"

echo [INFO] Mise a jour de pip...
python -m pip install --upgrade pip --quiet

REM --- 3. Dependances ---------------------------------------------------------
echo [INFO] Installation des dependances ^(requirements.txt^)...
python -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

REM --- 4. Configuration ---------------------------------------------------------
if not exist "config.yaml" (
    if exist "config.example.yaml" (
        echo [INFO] Copie de config.example.yaml vers config.yaml...
        copy config.example.yaml config.yaml >nul
    )
)

echo.
echo [OK] Installation terminee.
echo      Lancement   :  start.bat [indigo_host:port]
echo      Serveur web :  http://localhost:8080
echo.
endlocal