#!/bin/bash
# WatsUp Streamer - launch.sh
# Multi-purpose self-installing launcher for background Node.js engine and Python Tkinter GUI.
# Designed to be run inside the default LinuxServer Webtop container.

# Enforce secure owner-only permissions by default for all created files/directories
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# 1. Dependency Verification and Auto-installer
install_prerequisites() {
    MISSING_DEPS=()
    NEED_NODE_INSTALL=false

    if ! command -v node &> /dev/null; then
        NEED_NODE_INSTALL=true
    else
        local node_ver
        node_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
        if [ -z "$node_ver" ] || [ "$node_ver" -lt 18 ]; then
            NEED_NODE_INSTALL=true
        fi
    fi

    if [ "$NEED_NODE_INSTALL" = "false" ] && ! command -v npm &> /dev/null; then
        MISSING_DEPS+=("npm")
    fi
    if ! command -v python3 &> /dev/null; then
        MISSING_DEPS+=("python3")
    fi
    if ! python3 -c "import tkinter" &> /dev/null; then
        MISSING_DEPS+=("python3-tk")
    fi
    if ! command -v curl &> /dev/null; then
        MISSING_DEPS+=("curl")
    fi
    if ! command -v lsof &> /dev/null; then
        MISSING_DEPS+=("lsof")
    fi

    # Git check (warning only since it is needed to clone the repo in the first place)
    if ! command -v git &> /dev/null; then
        echo "ℹ️ Notice: git is missing, but it is required for cloning the repository."
    fi

    if [ "$NEED_NODE_INSTALL" = "true" ] || [ ${#MISSING_DEPS[@]} -ne 0 ]; then
        echo "📦 Missing prerequisites detected. Checking permissions for auto-installation..."
        
        local has_root=false
        local sudo_prefix=""
        if [ "$(id -u)" -eq 0 ]; then
            has_root=true
        elif sudo -n true 2>/dev/null; then
            has_root=true
            sudo_prefix="sudo"
        fi

        if [ "$has_root" = "false" ]; then
            echo "❌ Error: Root or passwordless sudo permissions are required for automatic installation."
            echo "🔧 Please run the following command manually on your host/container to install them:"
            echo "   sudo apt-get update && sudo apt-get install -y nodejs python3-tk lsof curl"
            exit 1
        fi

        echo "⚙️ Auto-installing missing prerequisites using apt-get..."
        export DEBIAN_FRONTEND=noninteractive

        # Update package lists
        $sudo_prefix apt-get update -y
        if [ $? -ne 0 ]; then
            echo "⚠️ Warning: apt-get update failed, attempting installation anyway..."
        fi

        # Install ca-certificates first (critical for secure HTTPS curl)
        $sudo_prefix apt-get install -y ca-certificates

        # Install Node.js if needed
        if [ "$NEED_NODE_INSTALL" = "true" ]; then
            echo "📦 Installing Node.js (v20 LTS) from NodeSource..."
            $sudo_prefix mkdir -p /etc/apt/keyrings
            $sudo_prefix rm -f /etc/apt/keyrings/nodesource.gpg
            curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $sudo_prefix gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
            echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | $sudo_prefix tee /etc/apt/sources.list.d/nodesource.list >/dev/null
            $sudo_prefix apt-get update -y
            $sudo_prefix apt-get install -y nodejs
            if [ $? -ne 0 ]; then
                echo "❌ Error: Failed to install nodejs from NodeSource."
                exit 1
            fi
        fi

        # Install other missing dependencies
        local apt_deps=()
        for dep in "${MISSING_DEPS[@]}"; do
            if [ "$dep" = "python3-tk" ]; then
                apt_deps+=("python3-tk")
            elif [ "$dep" = "python3" ]; then
                apt_deps+=("python3")
            elif [ "$dep" = "curl" ]; then
                apt_deps+=("curl")
            elif [ "$dep" = "lsof" ]; then
                apt_deps+=("lsof")
            elif [ "$dep" = "npm" ] && [ "$NEED_NODE_INSTALL" = "false" ]; then
                apt_deps+=("npm")
            fi
        done

        if [ ${#apt_deps[@]} -ne 0 ]; then
            echo "📦 Installing system packages: ${apt_deps[*]}..."
            $sudo_prefix apt-get install -y "${apt_deps[@]}"
            if [ $? -ne 0 ]; then
                echo "❌ Error: Failed to install one or more apt dependencies."
                exit 1
            fi
        fi

        # Verification check
        local final_missing=()
        if ! command -v node &> /dev/null; then final_missing+=("node"); fi
        if ! command -v npm &> /dev/null; then final_missing+=("npm"); fi
        if ! command -v python3 &> /dev/null; then final_missing+=("python3"); fi
        if ! python3 -c "import tkinter" &> /dev/null; then final_missing+=("python3-tk"); fi
        if ! command -v curl &> /dev/null; then final_missing+=("curl"); fi
        if ! command -v lsof &> /dev/null; then final_missing+=("lsof"); fi

        if [ ${#final_missing[@]} -ne 0 ]; then
            echo "❌ Error: Post-installation verification failed. Missing: ${final_missing[*]}"
            exit 1
        fi
        echo "✅ All prerequisites successfully verified!"
    fi

    # Optional package check and auto-installation for Drag & Drop support
    if ! python3 -c "import tkinterdnd2" &> /dev/null; then
        echo "📦 Python 'tkinterdnd2' library is missing. Attempting automatic installation..."
        
        local has_root=false
        local sudo_prefix=""
        if [ "$(id -u)" -eq 0 ]; then
            has_root=true
        elif sudo -n true 2>/dev/null; then
            has_root=true
            sudo_prefix="sudo"
        fi

        if ! command -v pip3 &> /dev/null; then
            if [ "$has_root" = "true" ]; then
                echo "🔧 Installing python3-pip..."
                $sudo_prefix apt-get update -y
                $sudo_prefix apt-get install -y python3-pip
            fi
        fi

        if command -v pip3 &> /dev/null; then
            echo "🔧 Installing tkinterdnd2 via pip..."
            pip3 install tkinterdnd2 --break-system-packages
            if python3 -c "import tkinterdnd2" &> /dev/null; then
                echo "✅ Python 'tkinterdnd2' installed successfully! Drag & Drop is enabled."
            else
                echo "⚠️ Warning: Failed to install 'tkinterdnd2'. Drag & Drop will be disabled."
            fi
        else
            echo "⚠️ Warning: pip3 is not available. Drag & Drop will be disabled."
        fi
    fi

    if ! command -v rar &> /dev/null; then
        echo "ℹ️ Notice: System 'rar' utility is not found. Fallback raw binary splitter will be used."
    fi
}

# 2. Node Dependencies installation
install_node_modules() {
    if [ ! -d "node_modules" ] || [ ! -d "node_modules/express" ]; then
        if [ ! -f "package-lock.json" ]; then
            echo "❌ Error: 'package-lock.json' is missing. Cannot perform secure package installation."
            exit 1
        fi
        echo "📦 Installing Node.js packages via npm ci..."
        npm ci --omit=dev
        if [ $? -ne 0 ]; then
            echo "❌ Error: Failed to install Node.js dependencies."
            exit 1
        fi
        echo "✅ Application packages installed successfully!"
        echo "----------------------------------------------------------"
    fi
}

# 3. Dynamic Shortcuts Configuration
setup_desktop_shortcuts() {
    local desktop_path="$HOME/Desktop"
    local menu_path="$HOME/.local/share/applications"

    mkdir -p "$desktop_path"
    mkdir -p "$menu_path"

    write_desktop_file() {
        echo "[Desktop Entry]"
        echo "Version=1.0"
        echo "Type=Application"
        echo "Name=WatsUp Streamer"
        echo "Comment=Zero-Browser WhatsApp Streamer for Heavy Files"
        echo "Exec=bash \"$APP_DIR/launch.sh\""
        echo "Icon=system-run"
        echo "Path=$APP_DIR"
        echo "Terminal=true"
        echo "StartupNotify=false"
        echo "Categories=Network;Utility;"
    }

    write_desktop_file > "$desktop_path/watsup.desktop"
    write_desktop_file > "$menu_path/watsup.desktop"
    chmod 700 "$desktop_path/watsup.desktop" 2>/dev/null
    chmod 700 "$menu_path/watsup.desktop" 2>/dev/null

    if command -v gio &> /dev/null; then
        gio set "$desktop_path/watsup.desktop" "metadata::trusted" yes 2>/dev/null
        gio set "$menu_path/watsup.desktop" "metadata::trusted" yes 2>/dev/null
    fi
}

# 4. Core Execution and Process Management
PORT=5001
PID_FILE=".watsup_engine.pid"
REUSE_ENGINE=false
ENGINE_PATH="$APP_DIR/engine.js"

# Helper to get process start time from field 22 of /proc/$PID/stat (robust to process names with spaces/parens)
get_start_time() {
    local pid=$1
    if [ -f "/proc/$pid/stat" ]; then
        local stat_line
        stat_line=$(cat "/proc/$pid/stat" 2>/dev/null)
        if [ -n "$stat_line" ]; then
            # Extract everything after the last closing parenthesis
            local after_paren="${stat_line##*)}"
            # Parse the fields (field 22 is field 20 after the closing parenthesis)
            local fields=($after_paren)
            echo "${fields[19]}" # 0-indexed, so 19 is the 20th field
        fi
    fi
}

# Verify-and-kill subroutine for strict process verification
verify_and_kill() {
    local target_pid=$1
    local expected_start_time=$2
    local expected_path=$3

    if [ -z "$target_pid" ] || [ -z "$expected_start_time" ] || [ -z "$expected_path" ]; then
        return 1
    fi

    # Check if process is running
    if [ ! -d "/proc/$target_pid" ]; then
        return 1
    fi

    # Check process start time
    local current_start_time
    current_start_time=$(get_start_time "$target_pid")
    if [ "$current_start_time" != "$expected_start_time" ]; then
        return 1
    fi

    # Check command line matches engine.js path (not just 'node')
    local resolved_engine_path
    resolved_engine_path=$(readlink -f "$expected_path" 2>/dev/null)

    # Read /proc/$target_pid/cmdline as NUL-separated arguments
    local cmd_args=()
    while IFS= read -r -d '' arg; do
        cmd_args+=("$arg")
    done < "/proc/$target_pid/cmdline"

    local resolved_arg1
    resolved_arg1=$(readlink -f "${cmd_args[1]}" 2>/dev/null)
    if [ "$resolved_arg1" != "$resolved_engine_path" ]; then
        return 1
    fi

    echo "🛑 Stopping background Node.js WhatsApp Engine (PID: $target_pid)..."
    kill "$target_pid" 2>/dev/null
    return 0
}

# Unified PID file and process metadata cleanup
cleanup_pid_file() {
    if [ -f "$PID_FILE" ]; then
        local stored_pid
        local stored_start_time
        local stored_path
        {
            read -r stored_pid
            read -r stored_start_time
            read -r stored_path
        } < "$PID_FILE"

        if [ -z "$stored_pid" ]; then
            rm -f "$PID_FILE"
            return 0
        fi

        # Check if process is running
        if [ ! -d "/proc/$stored_pid" ]; then
            echo "🧹 Process $stored_pid is already dead. Cleaning up PID file."
            rm -f "$PID_FILE"
            return 0
        fi

        # Process is running, verify if it is ours
        if verify_and_kill "$stored_pid" "$stored_start_time" "$stored_path"; then
            rm -f "$PID_FILE"
            return 0
        else
            echo "⚠️ Warning: Process $stored_pid is running but does not match our WhatsApp engine. Keeping PID metadata untouched."
            return 1
        fi
    fi
    return 0
}

run_launcher() {
    install_prerequisites
    install_node_modules
    setup_desktop_shortcuts

    # Check port occupancy
    if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
        BUSY_PID=$(lsof -t -i:$PORT)
        if [ -f ".watsup_ipc_token" ]; then
            TOKEN=$(cat .watsup_ipc_token)
            RESPONSE=$(curl -s -H "X-WatsUp-Token: $TOKEN" -m 3 http://127.0.0.1:5001/api/status)
            if echo "$RESPONSE" | grep -q '"status"' ; then
                echo "✅ WatsUp Engine is already running on port $PORT."
                REUSE_ENGINE=true
            fi
        fi

        if [ "$REUSE_ENGINE" = "false" ]; then
            echo "❌ Error: Port $PORT is occupied by an unknown process (PID: $BUSY_PID)."
            echo "Please stop the other process or free port $PORT before launching."
            exit 1
        fi
    fi

    if [ "$REUSE_ENGINE" = "false" ]; then
        echo "⚡ Starting background Node.js WhatsApp Engine..."
        node "$ENGINE_PATH" > engine.log 2>&1 &
        ENGINE_PID=$!
        ENGINE_START_TIME=$(get_start_time "$ENGINE_PID")
        ENGINE_ABS_PATH=$(readlink -f "$ENGINE_PATH" 2>/dev/null)
        echo "$ENGINE_PID" > "$PID_FILE"
        echo "$ENGINE_START_TIME" >> "$PID_FILE"
        echo "$ENGINE_ABS_PATH" >> "$PID_FILE"
        chmod 600 "$PID_FILE" 2>/dev/null
        echo "⏳ Initializing engine socket layers..."

        # Wait for token file to be created, max 10 seconds
        COUNTER=0
        while [ ! -f ".watsup_ipc_token" ] && [ $COUNTER -lt 10 ]; do
            sleep 1
            COUNTER=$((COUNTER + 1))
        done

        if [ ! -f ".watsup_ipc_token" ]; then
            echo "❌ Error: Token file '.watsup_ipc_token' was not generated."
            cleanup_pid_file
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

        if [ "$HEALTHY" = "false" ]; then
            echo "❌ Error: Node.js engine failed to start or respond correctly."
            echo "📋 Check engine.log for details."
            cleanup_pid_file
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

    # Cleanup background engine if we started it (reused engine remains untouched)
    if [ "$REUSE_ENGINE" = "false" ] && [ -n "$ENGINE_PID" ]; then
        cleanup_pid_file
    fi

    echo "✨ Goodbye!"
    echo ""
    echo "=========================================================="
    echo " Press [ENTER] to exit and close this terminal..."
    echo "=========================================================="
    read -r
}

# Only execute when run directly, not when sourced (allowing mock testing)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    run_launcher "$@"
fi
