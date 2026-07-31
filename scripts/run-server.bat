@echo off
REM %~dp0 is this script's own folder (scripts\), with a trailing backslash,
REM so %~dp0.. resolves to the repo root regardless of where it's cloned or
REM what the caller's working directory is.
cd /d "%~dp0.."
call npm start
