@echo off
rem Run Bookly backend + frontend from the project root.
cd /d "%~dp0"
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
