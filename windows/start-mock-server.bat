@echo off
REM Mock INDIGO pour test sans materiel (port 17624)

call ..\.venv\Scripts\activate.bat
python ..\tests\mock_indigo.py --port 17624
pause
