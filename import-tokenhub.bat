@echo off
rem tokenHub: 一键导入 tokenhub-export.sql 到 New API
cd /d %~dp0
docker compose down
python scripts\import-tokenhub.py tokenhub-export.sql
docker compose up -d
pause
