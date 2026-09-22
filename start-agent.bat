@echo off
rem GROQ_API_KEY must be set as an environment variable
set GROQ_MODEL=qwen/qwen3.8-27b
cd /d "C:\Users\USER\Documents\Default Project\autodial-ai"
node src\management\agent\agent.js --open
