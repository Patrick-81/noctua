@echo off
REM Noctua — Installeur Windows (option A, leger)
REM Cree .venv, installe les deps, copie config.example.yaml
REM Icone: windows/Noctua.ico

setlocal

echo === Noctua — Installation Windows ===

REM Verifie Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python 3.10+ non trouve. Installez Python depuis https://www.python.org/downloads/
    echo Cochez "Add python.exe to PATH" lors de l'installation.
    pause
    exit /b 1
)

for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Python detecte: %PYVER%

REM Cree venv .venv a la racine du projet
if not exist "..\.venv\Scripts\activate.bat" (
    echo Creation de .venv...
    python -m venv ..\.venv
    if errorlevel 1 (
        echo [ERREUR] Creation venv echouee. Installez python3-venv.
        pause
        exit /b 1
    )
) else (
    echo .venv existe deja — reutilise
)

echo Installation des dependances...
call ..\.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r ..\requirements.txt
if errorlevel 1 (
    echo [ERREUR] pip install echoue
    pause
    exit /b 1
)

REM Copie config
if not exist "..\config.yaml" (
    echo Copie config.example.yaml -> config.yaml
    copy /Y ..\config.example.yaml ..\config.yaml
    echo Editez ..\config.yaml (indigo.host, site, etc.)
) else (
    echo config.yaml existe deja — conserve
)

echo.
echo === Installation terminee ===
echo Lancez Noctua avec: launch-Noctua.bat
echo Raccourci Bureau: clic droit launch-Noctua.bat ^> Envoyer vers ^> Bureau (creer un raccourci) puis Proprietes ^> Changer d'icone ^> windows\Noctua.ico
pause
endlocal
