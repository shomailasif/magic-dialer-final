@echo off
set GROQ_API_KEY=%GROQ_API_KEY%
set GROQ_MODEL=qwen/qwen3.8-27b
cd /d "C:\Users\USER\Documents\Default Project\autodial-ai"
node src\management\agent\agent.js --open
