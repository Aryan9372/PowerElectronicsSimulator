@echo off
echo ========================================================
echo Compiling PowerSim PRO Native C++ Simulation Engine
echo ========================================================

where g++ >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] MinGW GCC g++ compiler not found in PATH!
    exit /b 1
)

echo Compiling powersim_engine.dll with g++ -O3 -mavx2 -shared -fPIC -static ...
g++ -O3 -mavx2 -shared -fPIC -static -o powersim_engine.dll cpp_core/engine.cpp -Wl,--out-implib,powersim_engine.a

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Compilation failed with exit code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)

echo [SUCCESS] powersim_engine.dll compiled successfully!
exit /b 0
