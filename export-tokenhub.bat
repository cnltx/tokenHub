@echo off
rem tokenHub: 导出 New API 配置为文本 tokenhub-export.sql
cd /d %~dp0
python scripts\export-tokenhub.py new-api-data\one-api.db tokenhub-export.sql
pause
