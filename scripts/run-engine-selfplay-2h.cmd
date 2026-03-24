@echo off
cd /d C:\Progetti\personal\forgetfullfish
"C:\Program Files\nodejs\node.exe" scripts\train-self-play.mjs --hours 2 --population 10 --games-per-seat 12 --concurrency 6 --hall-of-fame 4 --output engine-selfplay-2h-report.json >> training-output\engine-selfplay-2h.out.log 2>> training-output\engine-selfplay-2h.err.log
