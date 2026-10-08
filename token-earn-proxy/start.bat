@echo off
rem 赚取Token计划 - 影子代理 启动脚本
title 赚取Token计划 - 影子请求代理
cd /d %~dp0
echo ============================================
echo   赚取Token计划 - 影子请求代理
echo   控制界面: http://127.0.0.1:8788/
echo   关闭本窗口即停止服务
echo ============================================
node server.js
pause