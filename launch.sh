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

# 0. Fix permissions if the app directory is owned by root or not writable by current user
SUDO=""
if command -v sudo &> /dev/null; then
    SUDO="sudo"
fi

if [ ! -w "$APP_DIR" ]; then
    echo "🔧 App directory is not writable by the current user ($(whoami))."
    echo "🔑 Attempting to change ownership using chown..."
    if [ -n "$SUDO" ]; then
        $SUDO chown -R "$(id -u):$(id -g)" "$APP_DIR" 2>/dev/null
    fi
    if [ ! -w "$APP_DIR" ]; then
        echo "❌ Error: App directory is still not writable and ownership could not be updated."
        echo "Please verify permissions manually."
        exit 1
    fi
    echo "✅ Permissions fixed successfully!"
    echo "----------------------------------------------------------"
fi

# 1. Self-Installer: Detect and install Node.js and system libraries if missing
if ! command -v node &> /dev/null; then
    echo "🔧 First-time run: Node.js was not detected."
    echo "📦 Installing Node.js and required libraries..."

    # Update packages and install dependencies
    $SUDO apt-get update
    $SUDO apt-get install -y --no-install-recommends curl gnupg lsof python3 python3-tk python3-pip

    # Install Node.js v20 LTS from NodeSource
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y --no-install-recommends nodejs

    echo "✅ System dependencies installed successfully!"
    echo "----------------------------------------------------------"
fi

# Double check python3-tk and tkinterdnd2 installations
if ! python3 -c "import tkinter" &> /dev/null; then
    echo "🔧 Installing Python Tkinter library..."
    $SUDO apt-get update && $SUDO apt-get install -y python3-tk
fi

if ! python3 -c "import tkinterdnd2" &> /dev/null; then
    echo "🔧 Installing Python tkinterdnd2 library for drag-and-drop support..."
    pip3 install --no-cache-dir tkinterdnd2 2>/dev/null || pip3 install --no-cache-dir tkinterdnd2 --break-system-packages 2>/dev/null || $SUDO pip3 install --no-cache-dir tkinterdnd2 --break-system-packages 2>/dev/null
fi

# Install rar CLI utility for authentic split RAR volumes
if ! command -v rar &> /dev/null; then
    echo "🔧 Installing RAR utility for authentic split RAR volumes..."
    $SUDO apt-get update && $SUDO apt-get install -y rar
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
    curl -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -fsSL -o watsup.png https://cdn-icons-png.flaticon.com/512/124/124034.png
fi

# 4. Desktop Integration: Create dynamic shortcuts pointing to current path
DESKTOP_PATH="$HOME/Desktop"
MENU_PATH="$HOME/.local/share/applications"

mkdir -p "$DESKTOP_PATH"
mkdir -p "$MENU_PATH"

# Write desktop entry configuration
write_desktop_file() {
    echo "[Desktop Entry]"
    echo "Version=1.0"
    echo "Type=Application"
    echo "Name=WatsUp Streamer"
    echo "Comment=Zero-Browser WhatsApp Streamer for Heavy Files"
    echo "Exec=bash $APP_DIR/launch.sh"
    echo "Icon=$APP_DIR/watsup.png"
    echo "Path=$APP_DIR"
    echo "Terminal=true"
    echo "StartupNotify=false"
    echo "Categories=Network;Utility;"
}

# Save desktop shortcuts
write_desktop_file > "$DESKTOP_PATH/watsup.desktop"
write_desktop_file > "$MENU_PATH/watsup.desktop"
chmod +x "$DESKTOP_PATH/watsup.desktop"
chmod +x "$MENU_PATH/watsup.desktop"

# 5. Core Execution
PORT=5001
PID_FILE=".watsup_engine.pid"
REUSE_ENGINE=false

if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    BUSY_PID=$(lsof -t -i:$PORT)
    # Check if we have token and can reach WatsUp status
    if [ -f ".watsup_ipc_token" ]; then
        TOKEN=$(cat .watsup_ipc_token)
        RESPONSE=$(curl -s -H "X-WatsUp-Token: $TOKEN" -m 3 http://127.0.0.1:5001/api/status)
        if echo "$RESPONSE" | grep -q '"status"' ; then
            echo "✅ WatsUp Engine is already running on port $PORT."
            REUSE_ENGINE=true
        fi
    fi

    if [ "$REUSE_ENGINE" = false ]; then
        # Not verified, could be another user's port or different app
        echo "❌ Error: Port $PORT is occupied by an unknown process (PID: $BUSY_PID)."
        echo "Please stop the other process or free port $PORT before launching."
        exit 1
    fi
fi

if [ "$REUSE_ENGINE" = false ]; then
    echo "⚡ Starting background Node.js WhatsApp Engine..."
    node engine.js > engine.log 2>&1 &
    ENGINE_PID=$!
    echo "$ENGINE_PID" > "$PID_FILE"
    echo "⏳ Initializing engine socket layers..."

    # Wait for token file to be created, max 10 seconds
    COUNTER=0
    while [ ! -f ".watsup_ipc_token" ] && [ $COUNTER -lt 10 ]; do
        sleep 1
        COUNTER=$((COUNTER + 1))
    done

    if [ ! -f ".watsup_ipc_token" ]; then
        echo "❌ Error: Token file '.watsup_ipc_token' was not generated."
        kill $ENGINE_PID 2>/dev/null
        rm -f "$PID_FILE"
        exit 1
    fi

    # Verify health of the newly started engine
    COUNTER=0
    HEALTHY=false
    TOKEN=$(cat .watsup_ipc_token)
    while [ $COUNTER -lt 10 ]; do
        RESPONSE=$(curl -s -H "X-WatsUp-Token: $TOKEN" -m 2 http://127.0.0.1:5001/api/status)
        if echo "$RESPONSE" | grep -q '"status"' ; then
            HEALTHY=true
            break
        fi
        sleep 1
        COUNTER=$((COUNTER + 1))
    done

    if [ "$HEALTHY" = false ]; then
        echo "❌ Error: Node.js engine failed to start or respond correctly."
        echo "📋 Check engine.log for details."
        kill $ENGINE_PID 2>/dev/null
        rm -f "$PID_FILE"
        exit 1
    fi
fi

# Apply safe permissions
if [ -f ".watsup_ipc_token" ]; then
    chmod 600 ".watsup_ipc_token" 2>/dev/null
fi
if [ -d "auth_info_baileys" ]; then
    chmod 700 "auth_info_baileys" 2>/dev/null
    chmod 600 auth_info_baileys/* 2>/dev/null
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
python3 ui.py 2> ui_error.log
PYTHON_EXIT_CODE=$?

if [ $PYTHON_EXIT_CODE -ne 0 ]; then
    echo "❌ Python GUI crashed with exit code $PYTHON_EXIT_CODE."
    echo "📋 Error details (from ui_error.log):"
    cat ui_error.log
fi

echo ""
echo "🧹 Shutting down WatsUp Streamer..."

if [ -n "$TAIL_PID" ]; then
    kill $TAIL_PID 2>/dev/null
fi

if [ -n "$ENGINE_PID" ]; then
    # Check if the process is still running node
    if ps -p "$ENGINE_PID" -o comm= 2>/dev/null | grep -q "node" ; then
        echo "🛑 Stopping background Node.js WhatsApp Engine (PID: $ENGINE_PID)..."
        kill $ENGINE_PID 2>/dev/null
        rm -f "$PID_FILE"
    fi
fi

echo "✨ Goodbye!"
echo ""
echo "=========================================================="
echo " Press [ENTER] to exit and close this terminal..."
echo "=========================================================="
read -r

