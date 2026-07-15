#!/bin/bash
# Mock testing suite for launch.sh

# Create temporary bin directory
TEST_BIN_DIR=$(mktemp -d -t watsup_test_bin_XXXXXX)
export PATH="$TEST_BIN_DIR:$PATH"

# Setup temporary home directory to avoid touching real ~/Desktop or ~/.local
export HOME=$(mktemp -d -t watsup_test_home_XXXXXX)

# Source launch.sh to load its functions
source ./launch.sh

cleanup() {
    rm -rf "$TEST_BIN_DIR"
    rm -rf "$HOME"
}
trap cleanup EXIT

# 1. Test case: All prerequisites are present -> No apt-get should be called
setup_all_present() {
    rm -rf "$TEST_BIN_DIR"/*
    
    echo '#!/bin/bash' > "$TEST_BIN_DIR/node"
    echo 'echo "v20.0.0"' >> "$TEST_BIN_DIR/node"
    chmod +x "$TEST_BIN_DIR/node"

    echo '#!/bin/bash' > "$TEST_BIN_DIR/npm"
    chmod +x "$TEST_BIN_DIR/npm"

    echo '#!/bin/bash' > "$TEST_BIN_DIR/python3"
    chmod +x "$TEST_BIN_DIR/python3"

    echo '#!/bin/bash' > "$TEST_BIN_DIR/curl"
    chmod +x "$TEST_BIN_DIR/curl"

    echo '#!/bin/bash' > "$TEST_BIN_DIR/lsof"
    chmod +x "$TEST_BIN_DIR/lsof"

    echo '#!/bin/bash' > "$TEST_BIN_DIR/apt-get"
    echo 'echo "FAIL: apt-get should not be called!" && exit 1' >> "$TEST_BIN_DIR/apt-get"
    chmod +x "$TEST_BIN_DIR/apt-get"
}

echo "🧪 Running Test 1: All prerequisites present..."
setup_all_present
install_prerequisites
if [ $? -eq 0 ]; then
    echo "✅ Test 1 Passed!"
else
    echo "❌ Test 1 Failed!"
    exit 1
fi

# 2. Test case: Prerequisites missing, root/sudo unavailable -> Should fail
setup_missing_no_root() {
    rm -rf "$TEST_BIN_DIR"/*
    # Mock id to not be 0
    echo '#!/bin/bash' > "$TEST_BIN_DIR/id"
    echo 'echo 1000' >> "$TEST_BIN_DIR/id"
    chmod +x "$TEST_BIN_DIR/id"
    
    # Mock sudo to fail
    echo '#!/bin/bash' > "$TEST_BIN_DIR/sudo"
    echo 'exit 1' >> "$TEST_BIN_DIR/sudo"
    chmod +x "$TEST_BIN_DIR/sudo"
}

echo "🧪 Running Test 2: Prerequisites missing, no root..."
setup_missing_no_root
( install_prerequisites )
if [ $? -ne 0 ]; then
    echo "✅ Test 2 Passed (Failed gracefully)!"
else
    echo "❌ Test 2 Failed!"
    exit 1
fi

# 3. Test case: Prerequisites missing, root/sudo available -> Should install via apt-get
setup_missing_with_root() {
    rm -rf "$TEST_BIN_DIR"/*
    
    # Mock root (id -u returns 0)
    echo '#!/bin/bash' > "$TEST_BIN_DIR/id"
    echo 'echo 0' >> "$TEST_BIN_DIR/id"
    chmod +x "$TEST_BIN_DIR/id"
    
    # Mock curl and gpg to succeed
    echo '#!/bin/bash' > "$TEST_BIN_DIR/curl"
    chmod +x "$TEST_BIN_DIR/curl"
    
    echo '#!/bin/bash' > "$TEST_BIN_DIR/gpg"
    chmod +x "$TEST_BIN_DIR/gpg"

    # Mock apt-get to record arguments and simulate successful tool population
    echo '#!/bin/bash' > "$TEST_BIN_DIR/apt-get"
    echo 'echo "apt-get called with: $*" >> "$HOME/apt_calls.log"' >> "$TEST_BIN_DIR/apt-get"
    echo 'echo "v20.0.0" > "'"$TEST_BIN_DIR"'/node"' >> "$TEST_BIN_DIR/apt-get"
    echo 'chmod +x "'"$TEST_BIN_DIR"'/node"' >> "$TEST_BIN_DIR/apt-get"
    echo 'touch "'"$TEST_BIN_DIR"'/npm"' >> "$TEST_BIN_DIR/apt-get"
    echo 'chmod +x "'"$TEST_BIN_DIR"'/npm"' >> "$TEST_BIN_DIR/apt-get"
    echo 'touch "'"$TEST_BIN_DIR"'/python3"' >> "$TEST_BIN_DIR/apt-get"
    echo 'chmod +x "'"$TEST_BIN_DIR"'/python3"' >> "$TEST_BIN_DIR/apt-get"
    echo 'touch "'"$TEST_BIN_DIR"'/lsof"' >> "$TEST_BIN_DIR/apt-get"
    echo 'chmod +x "'"$TEST_BIN_DIR"'/lsof"' >> "$TEST_BIN_DIR/apt-get"
    chmod +x "$TEST_BIN_DIR/apt-get"
}

echo "🧪 Running Test 3: Auto-installation with root..."
setup_missing_with_root
install_prerequisites
if [ $? -eq 0 ]; then
    echo "✅ Test 3 Passed!"
    if grep -q "npm" "$HOME/apt_calls.log"; then
        echo "❌ Test 3 Failed: standalone npm package was installed in NodeSource path!"
        exit 1
    fi
else
    echo "❌ Test 3 Failed!"
    exit 1
fi

# 4. Test case: Desktop Entry Creation
echo "🧪 Running Test 4: Desktop shortcut creation..."
setup_desktop_shortcuts
if [ -f "$HOME/Desktop/watsup.desktop" ] && [ -f "$HOME/.local/share/applications/watsup.desktop" ]; then
    echo "✅ Test 4 Passed!"
else
    echo "❌ Test 4 Failed: Desktop files were not created!"
    exit 1
fi

echo "🎉 All launch.sh shell tests passed successfully!"
