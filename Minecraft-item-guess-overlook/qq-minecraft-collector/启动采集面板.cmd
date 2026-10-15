@echo off
cd /d "%~dp0"
start "" "%~dp0runtime\venv\Scripts\pythonw.exe" "%~dp0control_panel.py"
