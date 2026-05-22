#!/bin/bash
# WatsUp Streamer - launch.sh
# Multi-purpose self-installing launcher for background Node.js engine and Python Tkinter GUI.
# Designed to be run inside the default LinuxServer Webtop container.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "=========================================================="
echo " 🚀 WatsUp Desktop Streamer - Smart Installer & Launcher"
echo "=========================================================="
echo ""

# 1. Self-Installer: Detect and install Node.js and system libraries if missing
if ! command -v node &> /dev/null; then
    echo "🔧 First-time run: Node.js was not detected."
    echo "📦 Installing Node.js and required libraries (requires sudo)..."
    
    # Update packages and install dependencies
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends curl gnupg lsof python3 python3-tk python3-pip
    
    # Install Node.js v20 LTS from NodeSource
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y --no-install-recommends nodejs
    
    echo "✅ System dependencies installed successfully!"
    echo "----------------------------------------------------------"
fi

# Double check python3-tk installation
if ! python3 -c "import tkinter" &> /dev/null; then
    echo "🔧 Installing Python Tkinter library..."
    sudo apt-get update && sudo apt-get install -y python3-tk
fi

# 2. Self-Installer: Install Node dependencies if missing
if [ ! -d "node_modules" ]; then
    echo "📦 Installing Node.js application packages..."
    npm install --production
    echo "✅ Application packages installed successfully!"
    echo "----------------------------------------------------------"
fi

# 3. Premium Assets: Download green WhatsApp icon if missing
if [ ! -f "watsup.png" ]; then
    echo "🎨 Downloading official premium WhatsApp icon..."
    curl -fsSL -o watsup.png https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/512px-WhatsApp.svg.png
fi

# 4. Desktop Integration: Create dynamic shortcuts pointing to current path
DESKTOP_PATH="$HOME/Desktop"
MENU_PATH="$HOME/.local/share/applications"

mkdir -p "$DESKTOP_PATH"
mkdir -p "$MENU_PATH"

# Write desktop entry configuration
write_desktop_file() {
    cat <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=WatsUp Streamer
Comment=Zero-Browser WhatsApp Streamer for Heavy Files
Exec=bash $APP_DIR/launch.sh
Icon=$APP_DIR/watsup.png
Path=$APP_DIR
Terminal=true
StartupNotify=false
Categories=Network;Utility;
EOF
}

# Save desktop shortcuts
write_desktop_file > "$DESKTOP_PATH/watsup.desktop"
write_desktop_file > "$MENU_PATH/watsup.desktop"
chmod +x "$DESKTOP_PATH/watsup.desktop"
chmod +x "$MENU_PATH/watsup.desktop"

# 5. Core Execution
if lsof -Pi :5001 -sTCP:LISTEN -t >/dev/null ; then
    echo "ℹ️ Node.js Engine is already running in the background."
    ENGINE_PID=""
else
    echo "⚡ Starting background Node.js WhatsApp Engine..."
    node engine.js > engine.log 2>&1 &
    ENGINE_PID=$!
    
    echo "⏳ Initializing engine socket layers (3 seconds)..."
    sleep 3
fi

echo ""
echo "----------------------------------------------------------"
echo "💡 PAIRING INSTRUCTIONS:"
echo "If this is your first run, check below for the WhatsApp QR code."
echo "Scan it with your phone under Linked Devices."
echo "If already paired, the GUI will connect automatically."
echo "----------------------------------------------------------"
echo ""

if [ -n "$ENGINE_PID" ]; then
    tail -n 30 -f engine.log &
    TAIL_PID=$!
fi

echo "🎨 Starting dark-themed UI dashboard..."
python3 ui.py

echo ""
echo "🧹 Shutting down WatsUp Streamer..."

if [ -n "$TAIL_PID" ]; then
    kill $TAIL_PID 2>/dev/null
fi

if [ -n "$ENGINE_PID" ]; then
    echo "🛑 Stopping background Node.js WhatsApp Engine (PID: $ENGINE_PID)..."
    kill $ENGINE_PID 2>/dev/null
fi

echo "✨ Goodbye!"
sleep 1
