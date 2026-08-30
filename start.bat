@echo off
cd /d "%~dp0"
start "" http://localhost:8642/
python -m http.server 8642
