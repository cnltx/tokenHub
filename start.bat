@echo off
rem 启动 AI 网关: new-api + 赚取Token计划影子代理
cd /d %~dp0
docker compose up -d --build
pause
