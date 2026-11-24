@echo off
title Martin Social Hub - Local Preview
cd /d "%~dp0"
echo Starting local Social Hub preview at http://localhost:8085 ...
echo Close this window when finished previewing.
start "" http://localhost:8085
python -m http.server 8085
