#!/bin/bash
set -e

echo "Building MyGames..."

echo "1. Building Lobby Backend (Rust)..."
cd Lobby/backend
cargo build --release
cd ../..

echo "2. Building Lobby Frontend (React)..."
cd Lobby/frontend
pnpm build
cd ../..

echo "Build complete!"
