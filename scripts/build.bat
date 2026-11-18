@echo off
echo Building DeepGames...

echo 1. Building Lobby Backend (Rust)...
cd Lobby\backend
cargo build --release
cd ..\..

echo 2. Building Lobby Frontend (React)...
cd Lobby\frontend
call pnpm install
call pnpm build
cd ..\..

echo Build complete!
pause
