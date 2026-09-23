@echo off
rem Run Lyric Studio from this folder without installing it
rem (the packages it needs must already be in your Python).
set PYTHONPATH=%~dp0;%PYTHONPATH%
start "" pythonw -m lyricstudio
