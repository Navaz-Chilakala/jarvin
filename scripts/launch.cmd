@echo off
rem Builds Jarvin and starts it. Output goes to launch.log in the project folder.
cd /d "%~dp0.."
echo [%date% %time%] launch start > launch.log
echo folder: %cd% >> launch.log
where node >> launch.log 2>&1
if errorlevel 1 (
  echo ERROR: node was not found on PATH >> launch.log
  goto :end
)
echo --- build >> launch.log
call node build.mjs >> launch.log 2>&1
echo build exit code: %errorlevel% >> launch.log
if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: electron.exe is missing. Run npm install in this folder. >> launch.log
  goto :end
)
echo --- electron >> launch.log
"node_modules\electron\dist\electron.exe" . >> launch.log 2>&1
echo electron exit code: %errorlevel% >> launch.log
:end
