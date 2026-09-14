@echo off
cd "C:\Users\USER\Documents\Default Project\autodial-ai"
echo Starting Magic Dialer Portal...
echo.
echo Making sure SIP credentials are loaded from rc-credentials.json...
node src\management\portal\server.js
echo.
echo Portal started. Press Ctrl+C to stop.
timeout /t 1 /nobreak >NUL