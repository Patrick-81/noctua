# Noctua — Installation Windows

Icône : `windows/Noctua.ico` (copie de `web/static/favicon.ico`).

## Prérequis
- Windows 10/11, Python 3.10+ (https://www.python.org/downloads/ — cocher *Add python.exe to PATH*)

## Installation (1-clic)
1. Double-clic `windows/install.bat` — crée `.venv`, installe `requirements.txt`, copie `config.example.yaml → config.yaml`
2. Éditez `config.yaml` : `indigo.host` (ex. `192.168.1.10:7624`), `site` (lat/lon), `web.port`
3. Double-clic `windows/launch-Noctua.bat` → ouvre http://localhost:8080
   - Argument optionnel : `windows/launch-Noctua.bat 192.168.1.50:7624`
4. (Sans matériel) `windows/start-mock-server.bat` dans une 2e fenêtre, puis `windows/launch-Noctua.bat 127.0.0.1:17624`

## Raccourci Bureau avec icône
- Clic droit `windows/launch-Noctua.bat` → *Envoyer vers → Bureau (créer un raccourci)*
- Clic droit raccourci → *Propriétés → Changer d'icône* → `windows/Noctua.ico`
