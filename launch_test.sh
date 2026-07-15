#!/bin/bash
export MSYS=winsymlinks:lnk
# Mock testing suite for launch.sh

# 1. Pre-flight checks: verify core tools are available
for cmd in mktemp realpath rm mkdir dirname basename cp grep stat ln cmp; do
    if ! command -v "$cmd" &>/dev/null; then
        if [ "$cmd" = "realpath" ] && command -v readlink &>/dev/null; then
            continue
        fi
        echo "❌ Pre-flight Error: Required testing command '$cmd' is missing on host."
        exit 1
    fi
done

# Initialize secure sandbox root
TEST_TEMP_DIR=$(mktemp -d -t watsup_test_XXXXXX 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$TEST_TEMP_DIR" ]; then
    echo "❌ Pre-flight Error: Failed to create test sandbox root directory."
    exit 1
fi

# Canonicalize test root
if command -v realpath &>/dev/null; then
    TEST_TEMP_DIR=$(realpath "$TEST_TEMP_DIR")
else
    TEST_TEMP_DIR=$(readlink -f "$TEST_TEMP_DIR")
fi

# Convert backslashes to forward slashes for Git Bash path safety
TEST_TEMP_DIR=$(echo "$TEST_TEMP_DIR" | tr '\\' '/')

# Validate sandbox root
if [ -z "$TEST_TEMP_DIR" ] || [ ! -d "$TEST_TEMP_DIR" ] || [ "$TEST_TEMP_DIR" = "/" ] || [ "$TEST_TEMP_DIR" = "/tmp" ]; then
    echo "❌ Pre-flight Error: Sandbox root path '$TEST_TEMP_DIR' is unsafe."
    exit 1
fi

base_sandbox=$(basename "$TEST_TEMP_DIR")
if [[ ! "$base_sandbox" =~ ^watsup_test_ ]]; then
    echo "❌ Pre-flight Error: Sandbox root basename '$base_sandbox' does not match watsup_test_ prefix."
    exit 1
fi

# Enforce unbound variable errors for safety
set -u

# Build sandbox paths
TEST_BIN_DIR="$TEST_TEMP_DIR/bin"
TEST_HOME_DIR="$TEST_TEMP_DIR/home"
TEST_ETC_DIR="$TEST_TEMP_DIR/etc"

# Save and export system path and APP_DIR to allow framework setup bypass and prevent mock recursion loops
export SYSTEM_PATH="$PATH"
export APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$TEST_BIN_DIR"
mkdir -p "$TEST_HOME_DIR"
mkdir -p "$TEST_ETC_DIR/apt/keyrings"
mkdir -p "$TEST_ETC_DIR/apt/sources.list.d"

# Set up environment variables before sourcing
export PATH="$TEST_BIN_DIR:$PATH"
export HOME="$TEST_HOME_DIR"
export WATSUP_TEST_ROOT="$TEST_TEMP_DIR"
export WATSUP_ETC_DIR="$TEST_ETC_DIR"
export WATSUP_KEYRING_DIR="$TEST_ETC_DIR/apt/keyrings"
export WATSUP_NODESOURCE_LIST="$TEST_ETC_DIR/apt/sources.list.d/nodesource.list"
export WATSUP_LOG_PATH="$TEST_TEMP_DIR/engine.log"
export WATSUP_TEST_MODE="true"
export TMPDIR="$TEST_TEMP_DIR"

# Sourcing wrappers as absolute paths inside TEST_BIN_DIR
export WATSUP_CP="$TEST_BIN_DIR/cp"
export WATSUP_MV="$TEST_BIN_DIR/mv"
export WATSUP_RM="$TEST_BIN_DIR/rm"
export WATSUP_TOUCH="$TEST_BIN_DIR/touch"
export WATSUP_APT_GET="$TEST_BIN_DIR/apt-get"
export WATSUP_CURL="$TEST_BIN_DIR/curl"
export WATSUP_GPG="$TEST_BIN_DIR/gpg"
export WATSUP_MKTEMP="$TEST_BIN_DIR/mktemp"
export WATSUP_INSTALL="$TEST_BIN_DIR/install"
export WATSUP_CHMOD="$TEST_BIN_DIR/chmod"
export WATSUP_SUDO="$TEST_BIN_DIR/sudo"
export WATSUP_CMP="$TEST_BIN_DIR/cmp"

# Create fail-closed mocks for all wrappers to protect host system
create_fail_closed_mock() {
    local name="$1"
    echo -e '#!/bin/bash\necho "❌ Error: Fail-closed mock called for '"$name"' with args: $*" >&2\nexit 1' > "$TEST_BIN_DIR/$name"
    # Always make mock executable using system path
    PATH="$SYSTEM_PATH" chmod +x "$TEST_BIN_DIR/$name"
}

for wrapper in cp mv rm touch apt-get curl gpg mktemp install chmod sudo cmp node npm python3 id stat wc lsof safe_make_test_executable; do
    create_fail_closed_mock "$wrapper"
done

# Override command for test injection isolation
command() {
    if [ "$1" = "-v" ]; then
        local cmd=$2
        if [ "${MOCK_NO_REALPATH:-false}" = "true" ] && [[ "$cmd" =~ ^(realpath|readlink)$ ]]; then
            return 1
        fi
        if [[ "$cmd" =~ ^(node|npm|python3|curl|lsof|gpg|apt-get|install|chmod|sudo|cp|mv|rm|touch|cmp|safe_make_test_executable)$ ]]; then
            [ -x "$TEST_BIN_DIR/$cmd" ]
            return $?
        fi
    fi
    builtin command "$@"
}
export -f command 2>/dev/null

# Track umask, pwd, and traps before sourcing
umask_before=$(umask)
pwd_before=$(pwd)
traps_before=$(trap -p EXIT INT TERM)

# Source the production script
source ./launch.sh

umask_after=$(umask)
pwd_after=$(pwd)
traps_after=$(trap -p EXIT INT TERM)

# Verify sourcing does not pollute traps, cwd, or umask
if [ "$umask_before" != "$umask_after" ] || [ "$pwd_before" != "$pwd_after" ] || [ "$traps_before" != "$traps_after" ]; then
    echo "❌ Error: Sourcing launch.sh changed environment state!"
    echo "umask: $umask_before -> $umask_after"
    echo "pwd: $pwd_before -> $pwd_after"
    echo "traps: $traps_before -> $traps_after"
    exit 1
fi

# Signals tracking
SKIPPED_PERMS_COUNT=0
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Verification safety helpers
assert_safe_test_path() {
    local path="$1"
    if [ -z "$path" ]; then
        return 1
    fi
    local canonical
    if command -v realpath &>/dev/null; then
        canonical=$(realpath "$path" 2>/dev/null)
    elif command -v readlink &>/dev/null; then
        canonical=$(readlink -f "$path" 2>/dev/null)
    else
        canonical="$path"
    fi
    if [ -z "$canonical" ]; then
        return 1
    fi

    # Must be strictly inside the sandbox root directory (as offspring)
    case "$canonical" in
        "$TEST_TEMP_DIR"/*) ;;
        *) return 1 ;;
    esac

    # Reject critical paths
    if [ "$canonical" = "/" ] || [ "$canonical" = "/tmp" ] || [ "$canonical" = "$HOME" ]; then
        return 1
    fi
    return 0
}

safe_make_test_executable() {
    local path="$1"
    if [ -z "$path" ]; then
        return 1
    fi
    local canonical
    if command -v realpath &>/dev/null; then
        canonical=$(realpath "$path" 2>/dev/null)
    elif command -v readlink &>/dev/null; then
        canonical=$(readlink -f "$path" 2>/dev/null)
    else
        canonical="$path"
    fi
    if [ -z "$canonical" ]; then
        return 1
    fi
    case "$canonical" in
        "$TEST_TEMP_DIR"/*) ;;
        *)
            echo "HOST_PATH_BLOCKED: path '$path' is outside sandbox." >&2
            return 99
            ;;
    esac
    PATH="$SYSTEM_PATH" chmod +x "$canonical"
}
export -f safe_make_test_executable 2>/dev/null

safe_remove_dir() {
    local dir_path="$1"
    if assert_safe_test_path "$dir_path"; then
        PATH="$SYSTEM_PATH" rm -rf "$dir_path"
    else
        echo "❌ Error: Refused to delete unsafe path: '$dir_path'" >&2
        exit 1
    fi
}

safe_reset_dir() {
    local target_dir="$1"
    if assert_safe_test_path "$target_dir"; then
        PATH="$SYSTEM_PATH" rm -rf "$target_dir"
        PATH="$SYSTEM_PATH" mkdir -p "$target_dir"
    else
        echo "⚠️ Warning: safe_reset_dir refused to clean unsafe directory: '$target_dir'"
        exit 1
    fi
}

safe_cleanup_test_root() {
    local canonical_root=""
    if command -v realpath &>/dev/null; then
        canonical_root=$(realpath "$TEST_TEMP_DIR" 2>/dev/null)
    else
        canonical_root=$(readlink -f "$TEST_TEMP_DIR" 2>/dev/null)
    fi

    if [ -n "$canonical_root" ] && [ "$canonical_root" = "$TEST_TEMP_DIR" ] && [[ "$base_sandbox" =~ ^watsup_test_ ]]; then
        PATH="$SYSTEM_PATH" rm -rf "$TEST_TEMP_DIR"
    else
        echo "⚠️ Warning: safe_cleanup_test_root refused to cleanup path: '$TEST_TEMP_DIR'"
        exit 1
    fi
}

# Trap cleanup registration for test execution
cleanup() {
    safe_cleanup_test_root
}
trap cleanup EXIT

# Best effort permission validation
verify_perms() {
    local file=$1
    local expected_octal=$2
    if [ ! -e "$file" ]; then
        echo "❌ Error: File/Dir does not exist: $file"
        return 1
    fi
    if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* || "${OS:-}" == *Windows* ]]; then
        SKIPPED_PERMS_COUNT=$((SKIPPED_PERMS_COUNT + 1))
        return 0
    fi
    local actual_octal
    actual_octal=$(stat -c "%a" "$file" 2>/dev/null || stat -f "%Op" "$file" 2>/dev/null | cut -c 4-6)
    if [ -z "$actual_octal" ] || [[ ! "$actual_octal" =~ ^[0-7]+$ ]]; then
        echo "❌ Error: stat failed to return valid octal permissions for $file"
        return 1
    fi
    local actual_clean
    actual_clean=$(echo "$actual_octal" | sed 's/^0*//')
    if [ -z "$actual_clean" ]; then
        actual_clean="0"
    fi
    local expected_clean
    expected_clean=$(echo "$expected_octal" | sed 's/^0*//')
    if [ -z "$expected_clean" ]; then
        expected_clean="0"
    fi
    if [ "$actual_clean" != "$expected_clean" ]; then
        echo "❌ Permission mismatch: $file is $actual_octal (expected $expected_octal)"
        return 1
    fi
    return 0
}

assert_test_pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

# Sourcing trap validation check (formally defined test)
test_sourcing_traps() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Sourcing Traps Isolation..."
    if [ "$traps_before" = "$traps_after" ]; then
        assert_test_pass
        echo "✅ Sourcing Traps Isolation passed!"
    else
        echo "❌ Sourcing launch.sh modified exit traps!"
        assert_test_fail
    fi
}

assert_test_fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "❌ Assertion Failed!"
    exit 1
}

# Define base mocks that represent successful execution
setup_success_mocks() {
    safe_reset_dir "$TEST_BIN_DIR"
    rm -f "$TEST_TEMP_DIR/mock_calls.log"

    # Clean up config files and log files left by previous tests to prevent test pollution
    PATH="$SYSTEM_PATH" rm -f "$WATSUP_KEYRING_DIR/nodesource.gpg" "$WATSUP_NODESOURCE_LIST" "$WATSUP_LOG_PATH" "${WATSUP_LOG_PATH}.1"
    PATH="$SYSTEM_PATH" rm -f "$TEST_TEMP_DIR"/engine.log.tmp_*

    # Write the safe_make_test_executable helper script
    cat << 'EOF' > "$TEST_BIN_DIR/safe_make_test_executable"
#!/bin/bash
path="$1"
if [ -z "$path" ]; then
    echo "❌ Error: safe_make_test_executable called with empty path" >&2
    exit 1
fi
canonical=""
if command -v realpath &>/dev/null; then
    canonical=$(realpath "$path" 2>/dev/null)
elif command -v readlink &>/dev/null; then
    canonical=$(readlink -f "$path" 2>/dev/null)
fi
if [ -z "$canonical" ]; then
    parent_dir=$(dirname "$path")
    base_name=$(basename "$path")
    if [ -n "$parent_dir" ] && [ -d "$parent_dir" ]; then
        if command -v realpath &>/dev/null; then
            canonical=$(realpath "$parent_dir" 2>/dev/null)
        else
            canonical=$(readlink -f "$parent_dir" 2>/dev/null)
        fi
        if [ -n "$canonical" ]; then
            canonical="$canonical/$base_name"
        fi
    fi
fi
if [ -z "$canonical" ]; then
    echo "❌ Error: Could not canonicalize '$path'" >&2
    exit 1
fi
case "$canonical" in
    "$WATSUP_TEST_ROOT"/*) ;;
    *)
        echo "HOST_PATH_BLOCKED: path '$path' is outside sandbox." >&2
        exit 99
        ;;
esac
PATH="$SYSTEM_PATH" chmod +x "$canonical"
EOF
    # Make the helper script executable using host system chmod
    PATH="$SYSTEM_PATH" chmod +x "$TEST_BIN_DIR/safe_make_test_executable"

    # Write the inline path safety checker helper script
    cat << 'EOF' > "$TEST_BIN_DIR/path_safety_check.sh"
assert_safe_arg() {
    local arg="$1"
    local is_delete="${2:-false}"
    if [[ "$arg" =~ ^- ]] || [[ "$arg" =~ ^[+] ]] || [ -z "$arg" ]; then
        return 0
    fi
    # Skip purely numeric strings (modes, etc.), chmod symbolics, and format strings starting with %
    if [[ "$arg" =~ ^[0-9]+$ ]] || [[ "$arg" =~ ^[ugoa]*[-+=][rwx]+$ ]] || [[ "$arg" =~ ^% ]]; then
        return 0
    fi
    local norm_arg
    norm_arg=$(echo "$arg" | tr '\\' '/')
    local canonical=""
    if [ -e "$arg" ] || [ -h "$arg" ]; then
        if command -v realpath &>/dev/null; then
            canonical=$(realpath "$arg" 2>/dev/null)
        elif command -v readlink &>/dev/null; then
            canonical=$(readlink -f "$arg" 2>/dev/null)
        fi
    else
        local parent_dir
        local base_name
        parent_dir=$(dirname "$arg")
        base_name=$(basename "$arg")
        if [ -n "$parent_dir" ] && [ -d "$parent_dir" ]; then
            if command -v realpath &>/dev/null; then
                canonical=$(realpath "$parent_dir" 2>/dev/null)
            else
                canonical=$(readlink -f "$parent_dir" 2>/dev/null)
            fi
            if [ -n "$canonical" ]; then
                canonical="$canonical/$base_name"
            fi
        fi
    fi
    if [ -z "$canonical" ]; then
        if [[ "$norm_arg" == /* ]]; then
            case "$norm_arg" in
                "$WATSUP_TEST_ROOT"/*) ;;
                *)
                    echo "HOST_PATH_BLOCKED: path '$arg' is outside sandbox." >&2
                    exit 99
                    ;;
            esac
        fi
        return 0
    fi
    canonical=$(echo "$canonical" | tr '\\' '/')
    local test_root_can=$(echo "$WATSUP_TEST_ROOT" | tr '\\' '/')
    if [ "$is_delete" = "true" ] && [ "$canonical" = "$test_root_can" ]; then
        echo "HOST_PATH_BLOCKED: Refusing to delete WATSUP_TEST_ROOT: '$canonical'" >&2
        exit 99
    fi
    if [ "$canonical" = "/" ] || [ "$canonical" = "/tmp" ] || [ "$canonical" = "/etc" ] || [ "$canonical" = "$HOME" ] || [ "$canonical" = "$APP_DIR" ]; then
        echo "HOST_PATH_BLOCKED: Refusing access to critical path '$canonical'" >&2
        exit 99
    fi
    case "$canonical" in
        "$test_root_can"/*) ;;
        *)
            echo "HOST_PATH_BLOCKED: Path '$canonical' is outside sandbox." >&2
            exit 99
            ;;
    esac
    if [ -h "$arg" ]; then
        local link_target
        link_target=$(readlink "$arg" 2>/dev/null)
        if [[ "$link_target" == /* ]]; then
            case "$link_target" in
                "$test_root_can"/*) ;;
                *)
                    echo "HOST_PATH_BLOCKED: Symlink target '$link_target' is outside sandbox." >&2
                    exit 99
                    ;;
            esac
        else
            local sym_parent
            sym_parent=$(dirname "$arg")
            local resolved_link
            if command -v realpath &>/dev/null; then
                resolved_link=$(realpath "$sym_parent/$link_target" 2>/dev/null)
            else
                resolved_link=$(readlink -f "$sym_parent/$link_target" 2>/dev/null)
            fi
            resolved_link=$(echo "$resolved_link" | tr '\\' '/')
            case "$resolved_link" in
                "$test_root_can"/*) ;;
                *)
                    echo "HOST_PATH_BLOCKED: Resolved symlink '$resolved_link' is outside sandbox." >&2
                    exit 99
                    ;;
            esac
        fi
    fi
    return 0
}
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/cp"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "cp $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" cp "$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/mv"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "mv $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" mv "$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/rm"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg" "true"
done
echo "rm $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" rm "$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/touch"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "touch $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" touch "$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/chmod"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "chmod $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/install"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "install $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" cp "$3" "$4" 2>/dev/null || PATH="$SYSTEM_PATH" cp "$2" "$3" 2>/dev/null || PATH="$SYSTEM_PATH" cp "$1" "$2" 2>/dev/null
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/mktemp"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    if [[ "$arg" == *"/"* ]]; then
        assert_safe_arg "$arg"
    fi
done
echo "mktemp $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" mktemp "$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/cmp"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "cmp $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
PATH="$SYSTEM_PATH" cmp "$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/id"
#!/bin/bash
echo "id $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
echo 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/node"
#!/bin/bash
echo "node $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
echo "v20.0.0"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/npm"
#!/bin/bash
echo "npm $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/python3"
#!/bin/bash
echo "python3 $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/curl"
#!/bin/bash
echo "curl $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/gpg"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
echo "gpg $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
echo "gpg key dearmored" > "$3"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/apt-get"
#!/bin/bash
echo "apt-get $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/lsof"
#!/bin/bash
echo "lsof $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
exit 0
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/sudo"
#!/bin/bash
echo "sudo $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
if [ "$1" = "-n" ] && [ "$2" = "true" ]; then
    exit 0
fi
while [[ "$1" == -* ]]; do
    shift
done
"$@"
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/stat"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *"engine.log"* ]]; then
    echo 6291456
elif [[ "$*" == *"unbound_test_file"* ]]; then
    echo 600
else
    PATH="$SYSTEM_PATH" stat "$@"
fi
EOF

    cat << 'EOF' > "$TEST_BIN_DIR/wc"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
PATH="$SYSTEM_PATH" wc "$@"
EOF

    # Make all setup mocks executable using host system chmod explicitly
    PATH="$SYSTEM_PATH" chmod +x "$TEST_BIN_DIR"/*
}

# ----------------- TEST CASES -----------------

# 1. Mock Safety Enforcement Check
test_sandbox_safety_enforced_on_mocks() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Sandbox Safety Enforced on Mocks..."
    setup_success_mocks

    # Verify touch blocked
    local err_touch
    err_touch=$("$TEST_BIN_DIR/touch" "/etc/hosts" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_touch" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Touch did not block outside path: $err_touch"
        assert_test_fail
    fi

    # Verify rm blocked
    local err_rm
    err_rm=$("$TEST_BIN_DIR/rm" "/etc/hosts" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_rm" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Rm did not block outside path: $err_rm"
        assert_test_fail
    fi

    # Verify rm blocks deleting TEST_TEMP_DIR itself
    local err_rm_root
    err_rm_root=$("$TEST_BIN_DIR/rm" "$TEST_TEMP_DIR" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_rm_root" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Rm did not block deleting WATSUP_TEST_ROOT: $err_rm_root"
        assert_test_fail
    fi

    # Verify cp blocked
    local err_cp
    err_cp=$("$TEST_BIN_DIR/cp" "/etc/hosts" "$TEST_TEMP_DIR/" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_cp" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Cp did not block outside path: $err_cp"
        assert_test_fail
    fi

    # Verify mv blocked
    local err_mv
    err_mv=$("$TEST_BIN_DIR/mv" "/etc/hosts" "$TEST_TEMP_DIR/" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_mv" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Mv did not block outside path: $err_mv"
        assert_test_fail
    fi

    # Verify install blocked
    local err_install
    err_install=$("$TEST_BIN_DIR/install" "/etc/hosts" "$TEST_TEMP_DIR/" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_install" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Install did not block outside path: $err_install"
        assert_test_fail
    fi

    # Verify gpg blocked
    local err_gpg
    err_gpg=$("$TEST_BIN_DIR/gpg" "/etc/hosts" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_gpg" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Gpg did not block outside path: $err_gpg"
        assert_test_fail
    fi

    # Verify cmp blocked
    local err_cmp
    err_cmp=$("$TEST_BIN_DIR/cmp" "/etc/hosts" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_cmp" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Cmp did not block outside path: $err_cmp"
        assert_test_fail
    fi

    assert_test_pass
    echo "✅ Sandbox Safety Enforced on Mocks passed!"
}

# 1b. Non-existent Evil Sibling Path Rejected Check
test_nonexistent_evil_sibling_path_rejected() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Non-existent Evil Sibling Path Rejected..."
    setup_success_mocks

    local evil_path="${WATSUP_TEST_ROOT}_evil/nonexistent"

    # Test touch
    local err_touch
    err_touch=$("$TEST_BIN_DIR/touch" "$evil_path" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_touch" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Touch did not block evil sibling path: $err_touch"
        assert_test_fail
    fi

    # Test rm
    local err_rm
    err_rm=$("$TEST_BIN_DIR/rm" "$evil_path" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_rm" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Rm did not block evil sibling path: $err_rm"
        assert_test_fail
    fi

    # Test cp
    local err_cp
    err_cp=$("$TEST_BIN_DIR/cp" "$evil_path" "$TEST_TEMP_DIR/" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_cp" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Cp did not block evil sibling path: $err_cp"
        assert_test_fail
    fi

    # Test mv
    local err_mv
    err_mv=$("$TEST_BIN_DIR/mv" "$evil_path" "$TEST_TEMP_DIR/" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_mv" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Mv did not block evil sibling path: $err_mv"
        assert_test_fail
    fi

    # Test install
    local err_install
    err_install=$("$TEST_BIN_DIR/install" "$evil_path" "$TEST_TEMP_DIR/" 2>&1)
    if [ $? -ne 99 ] || [[ "$err_install" != *"HOST_PATH_BLOCKED"* ]]; then
        echo "❌ Install did not block evil sibling path: $err_install"
        assert_test_fail
    fi

    assert_test_pass
    echo "✅ Non-existent Evil Sibling Path Rejected passed!"
}

# 1c. verify_perms unbound variable safety under set -u
test_verify_perms_unbound_safety() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: verify_perms Unbound Safety Check..."
    setup_success_mocks

    local test_file="$TEST_TEMP_DIR/unbound_test_file"
    touch "$test_file"

    # Run verify_perms in a subshell with set -u and unsetting OS/OSTYPE
    (
        set -u
        unset OS
        unset OSTYPE
        verify_perms "$test_file" 600
    )
    local status=$?
    if [ $status -ne 0 ]; then
        echo "❌ verify_perms failed or crashed when OS/OSTYPE were unbound!"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ verify_perms Unbound Safety Check passed!"
}

# 2. Boundary and Traversal Tests
test_boundary_checks() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Boundary and Traversal Checks..."

    # Check traversal rejected
    assert_safe_test_path "$TEST_TEMP_DIR/../" && assert_test_fail
    assert_safe_test_path "" && assert_test_fail
    assert_safe_test_path "/" && assert_test_fail
    assert_safe_test_path "$TEST_TEMP_DIR" && assert_test_fail
    assert_safe_test_path "${TEST_TEMP_DIR}_evil" && assert_test_fail
    assert_safe_test_path "$HOME" && assert_test_fail
    assert_safe_test_path "$APP_DIR" && assert_test_fail

    # Setup isolated mock temp
    local mock_tmp="$TEST_TEMP_DIR/mock_tmp"
    PATH="$SYSTEM_PATH" mkdir -p "$mock_tmp"
    local old_tmpdir="${TMPDIR:-}"
    export TMPDIR="$mock_tmp"

    local valid_dir="$mock_tmp/watsup_key_1"
    PATH="$SYSTEM_PATH" mkdir -p "$valid_dir"

    is_safe_temp_dir "$valid_dir" || assert_test_fail
    is_safe_temp_dir "$mock_tmp" && assert_test_fail # Temp root itself rejected
    is_safe_temp_dir "${mock_tmp}_evil/watsup_key_1" && assert_test_fail # Sibling rejected
    is_safe_temp_dir "$valid_dir/../../etc" && assert_test_fail # Traversal rejected

    # Symlink inside temp pointing outside rejected
    ln -s "$TEST_BIN_DIR" "$valid_dir/sym_outside" 2>/dev/null
    if [ -h "$valid_dir/sym_outside" ]; then
        is_safe_temp_dir "$valid_dir/sym_outside" && assert_test_fail
    fi

    # Symlink outside temp pointing inside accepted only if canonical path is inside temp and secure
    ln -s "$valid_dir" "$TEST_TEMP_DIR/sym_outside_to_inside" 2>/dev/null
    if [ -h "$TEST_TEMP_DIR/sym_outside_to_inside" ]; then
        is_safe_temp_dir "$TEST_TEMP_DIR/sym_outside_to_inside" || assert_test_fail
    fi

    # Symlink outside temp pointing to unsafe inside temp rejected
    local unsafe_inside="$mock_tmp/unsafe_dir"
    PATH="$SYSTEM_PATH" mkdir -p "$unsafe_inside"
    ln -s "$unsafe_inside" "$TEST_TEMP_DIR/sym_outside_to_unsafe" 2>/dev/null
    if [ -h "$TEST_TEMP_DIR/sym_outside_to_unsafe" ]; then
        is_safe_temp_dir "$TEST_TEMP_DIR/sym_outside_to_unsafe" && assert_test_fail
    fi

    # HOME and APP_DIR rejected
    is_safe_temp_dir "$HOME" && assert_test_fail
    is_safe_temp_dir "$APP_DIR" && assert_test_fail

    # Absence of realpath and readlink
    export MOCK_NO_REALPATH="true"
    is_safe_temp_dir "$valid_dir" && assert_test_fail
    export MOCK_NO_REALPATH="false"

    if [ -n "$old_tmpdir" ]; then
        export TMPDIR="$old_tmpdir"
    else
        unset TMPDIR
    fi

    assert_test_pass
    echo "✅ Boundary checks passed!"
}

# 3. Symlink Escape Sourcing test cases
test_sourcing_fails_on_symlink_escape() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Sourcing Fails on Symlink Escape..."
    setup_success_mocks

    local outside_target="/etc/hosts"

    for var in WATSUP_ETC_DIR WATSUP_KEYRING_DIR WATSUP_NODESOURCE_LIST WATSUP_LOG_PATH; do
        # Reset variables
        local saved_etc="${WATSUP_ETC_DIR:-}"
        local saved_keyring="${WATSUP_KEYRING_DIR:-}"
        local saved_list="${WATSUP_NODESOURCE_LIST:-}"
        local saved_log="${WATSUP_LOG_PATH:-}"

        local test_link="$TEST_TEMP_DIR/test_escape_link_$var"
        ln -s "$outside_target" "$test_link" 2>/dev/null

        # Set the environment variable to the symlink
        export WATSUP_ETC_DIR="$TEST_ETC_DIR"
        export WATSUP_KEYRING_DIR="$TEST_ETC_DIR/apt/keyrings"
        export WATSUP_NODESOURCE_LIST="$TEST_ETC_DIR/apt/sources.list.d/nodesource.list"
        export WATSUP_LOG_PATH="$TEST_TEMP_DIR/engine.log"

        export $var="$test_link"

        # Source in a subshell to check for failure
        (
            source ./launch.sh
        ) &>/dev/null
        local status=$?

        # Clean up link
        rm -f "$test_link" 2>/dev/null

        export WATSUP_ETC_DIR="$saved_etc"
        export WATSUP_KEYRING_DIR="$saved_keyring"
        export WATSUP_NODESOURCE_LIST="$saved_list"
        export WATSUP_LOG_PATH="$saved_log"

        if [ $status -eq 0 ]; then
            echo "❌ Sourcing did not fail when $var was a symlink pointing outside!"
            assert_test_fail
        fi
    done

    assert_test_pass
    echo "✅ Sourcing Fails on Symlink Escape passed!"
}

# 4. Installer Matrix Test Cases

test_installer_all_present() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - All Present..."
    setup_success_mocks
    ( safe_cleanup_test_root() { :; }; install_prerequisites ) || assert_test_fail
    assert_test_pass
    echo "✅ Installer - All Present passed!"
}

test_installer_no_root_no_sudo() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - No Root/Sudo..."
    setup_success_mocks

    # Mock id to return non-root
    echo -e '#!/bin/bash\necho 1000' > "$TEST_BIN_DIR/id"
    safe_make_test_executable "$TEST_BIN_DIR/id"
    # Mock sudo to fail
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/sudo"
    safe_make_test_executable "$TEST_BIN_DIR/sudo"
    # Mock node to be missing
    rm -f "$TEST_BIN_DIR/node"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    local exit_status=$?

    if [ $exit_status -eq 0 ] || [[ "$output" != *"Root or passwordless sudo permissions are required"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - No Root/Sudo passed!"
}

test_installer_bootstrap_update_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Bootstrap Update Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    # Mock apt-get update to fail during update
    echo -e '#!/bin/bash\nif [[ "$*" == *"update"* ]]; then exit 1; fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"apt-get update failed during bootstrap"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Bootstrap Update Failure passed!"
}

test_installer_bootstrap_install_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Bootstrap Install Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    # Mock apt-get install to fail
    echo -e '#!/bin/bash\nif [[ "$*" == *"install"* ]]; then exit 1; fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Failed to install installer bootstrap dependencies"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Bootstrap Install Failure passed!"
}

test_installer_curl_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Curl Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/curl"
    safe_make_test_executable "$TEST_BIN_DIR/curl"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Failed to download or dearmor NodeSource repository GPG key"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Curl Failure passed!"
}

test_installer_gpg_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - GPG Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/gpg"
    safe_make_test_executable "$TEST_BIN_DIR/gpg"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Failed to download or dearmor NodeSource repository GPG key"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - GPG Failure passed!"
}

test_installer_mktemp_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Mktemp Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/mktemp"
    safe_make_test_executable "$TEST_BIN_DIR/mktemp"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Failed to create secure temporary directory"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Mktemp Failure passed!"
}

test_installer_keyring_backup_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Keyring Backup Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    touch "$WATSUP_KEYRING_DIR/nodesource.gpg"
    # Make cp fail
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/cp"
    safe_make_test_executable "$TEST_BIN_DIR/cp"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Keyring backup failed"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Keyring Backup Failure passed!"
}

test_installer_sourcelist_backup_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Source List Backup Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    touch "$WATSUP_NODESOURCE_LIST"
    # Make cp fail
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/cp"
    safe_make_test_executable "$TEST_BIN_DIR/cp"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Source list backup failed"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Source List Backup Failure passed!"
}

test_installer_keyring_install_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Keyring Install Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install

    # Mock install command to fail on nodesource.gpg
    cat << 'EOF' > "$TEST_BIN_DIR/install"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *"nodesource.gpg"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" cp "$2" "$3" 2>/dev/null || PATH="$SYSTEM_PATH" cp "$1" "$2" 2>/dev/null
exit 0
EOF
    safe_make_test_executable "$TEST_BIN_DIR/install"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/install" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Keyring Install Failure passed!"
}

test_installer_sourcelist_install_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Source List Install Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install

    # Mock install command to fail on nodesource.list
    cat << 'EOF' > "$TEST_BIN_DIR/install"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *"nodesource.list"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" cp "$2" "$3" 2>/dev/null || PATH="$SYSTEM_PATH" cp "$1" "$2" 2>/dev/null
exit 0
EOF
    safe_make_test_executable "$TEST_BIN_DIR/install"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/install" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Source List Install Failure passed!"
}

test_installer_chmod_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Chmod Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/chmod"
    safe_make_test_executable "$TEST_BIN_DIR/chmod"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Chmod Failure passed!"
}

test_installer_nodesource_update_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - NodeSource Update Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    # Mock apt-get update to fail when called the second time
    echo -e '#!/bin/bash\nif [[ "$*" == *"update"* ]]; then\n  if [ -f '"$TEST_TEMP_DIR/bootstrap_done"'
  ]; then exit 1; else touch '"$TEST_TEMP_DIR/bootstrap_done"'
  fi\nfi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    rm -f "$TEST_TEMP_DIR/bootstrap_done"
    assert_test_pass
    echo "✅ Installer - NodeSource Update Failure passed!"
}

test_installer_nodejs_apt_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Node.js Apt Installation Failure..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    # Mock apt-get install nodejs to fail
    echo -e '#!/bin/bash\nif [[ "$*" == *"install -y nodejs"* ]]; then exit 1; fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Node.js Apt Installation Failure passed!"
}

test_installer_post_install_node_missing() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Post-install Node Missing..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    # Mock apt-get install to NOT create node
    echo -e '#!/bin/bash\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Post-install Node Missing passed!"
}

test_installer_post_install_npm_missing() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Post-install NPM Missing..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    rm -f "$TEST_BIN_DIR/npm"  # ensure npm is missing post-install
    # Mock apt-get install to create node but NOT npm
    echo -e '#!/bin/bash\nif [[ "$*" == *"install -y nodejs"* ]]; then\n  echo -e "#!/bin/bash\necho v20.0.0" > '"$TEST_BIN_DIR/node"'
  safe_make_test_executable '"$TEST_BIN_DIR/node"'
fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Post-install NPM Missing passed!"
}

test_installer_post_install_node_v16() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Post-install Node version v16 (unsupported)..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install
    # Mock apt-get install to create Node v16
    echo -e '#!/bin/bash\nif [[ "$*" == *"install -y nodejs"* ]]; then\n  echo -e "#!/bin/bash\necho v16.0.0" > '"$TEST_BIN_DIR/node"'
  safe_make_test_executable '"$TEST_BIN_DIR/node"'
fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"rollback"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Post-install Node version v16 passed!"
}

test_installer_rollback_success() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Rollback Success (Restore byte-for-byte)..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install

    echo "key_content_a" > "$WATSUP_KEYRING_DIR/nodesource.gpg"
    echo "list_content_b" > "$WATSUP_NODESOURCE_LIST"

    # Make nodesource install fail to trigger rollback
    echo -e '#!/bin/bash\nif [[ "$*" == *"install -y nodejs"* ]]; then exit 1; fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    local exit_status=$?

    if [ $exit_status -eq 0 ]; then
        echo "❌ Installer rollback should have failed and returned non-zero."
        assert_test_fail
    fi

    # Assert rolled back files match original content byte-for-byte
    if [ "$(cat "$WATSUP_KEYRING_DIR/nodesource.gpg")" != "key_content_a" ]; then
        echo "❌ Keyring not rolled back correctly!"
        assert_test_fail
    fi
    if [ "$(cat "$WATSUP_NODESOURCE_LIST")" != "list_content_b" ]; then
        echo "❌ Source list not rolled back correctly!"
        assert_test_fail
    fi

    assert_test_pass
    echo "✅ Installer - Rollback Success passed!"
}

test_installer_rollback_success_non_root() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Rollback Success (Non-root with sudo)..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install

    # Mock id to return 1000 (non-root)
    echo -e '#!/bin/bash\necho "id $*" >> '"$TEST_TEMP_DIR/mock_calls.log"'\necho 1000' > "$TEST_BIN_DIR/id"
    safe_make_test_executable "$TEST_BIN_DIR/id"

    # Mock sudo to allow running install and rm mocks safely (using SYSTEM_PATH or direct call)
    cat << 'EOF' > "$TEST_BIN_DIR/sudo"
#!/bin/bash
echo "sudo $*" >> "$WATSUP_TEST_ROOT/mock_calls.log"
if [ "$1" = "-n" ] && [ "$2" = "true" ]; then
    exit 0
fi
while [[ "$1" == -* ]]; do
    shift
done
"$@"
EOF
    safe_make_test_executable "$TEST_BIN_DIR/sudo"

    echo "key_content_a" > "$WATSUP_KEYRING_DIR/nodesource.gpg"
    echo "list_content_b" > "$WATSUP_NODESOURCE_LIST"

    # Make nodesource install fail to trigger rollback
    echo -e '#!/bin/bash\nif [[ "$*" == *"install -y nodejs"* ]]; then exit 1; fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    local exit_status=$?

    if [ $exit_status -eq 0 ]; then
        echo "❌ Installer rollback should have failed and returned non-zero."
        assert_test_fail
    fi

    # Verify rollback called sudo for keyring restore
    if ! grep -q "sudo .*install -m 644 .*nodesource.gpg" "$TEST_TEMP_DIR/mock_calls.log"; then
        echo "❌ Rollback did not call sudo for keyring install!"
        assert_test_fail
    fi

    # Verify rollback called sudo for sources list restore
    if ! grep -q "sudo .*install -m 644 .*nodesource.list" "$TEST_TEMP_DIR/mock_calls.log"; then
        echo "❌ Rollback did not call sudo for sources list install!"
        assert_test_fail
    fi

    # Assert rolled back files match original content byte-for-byte
    if [ "$(cat "$WATSUP_KEYRING_DIR/nodesource.gpg")" != "key_content_a" ]; then
        echo "❌ Keyring not rolled back correctly!"
        assert_test_fail
    fi
    if [ "$(cat "$WATSUP_NODESOURCE_LIST")" != "list_content_b" ]; then
        echo "❌ Source list not rolled back correctly!"
        assert_test_fail
    fi

    assert_test_pass
    echo "✅ Installer - Rollback Success (Non-root with sudo) passed!"
}

test_installer_rollback_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Rollback Failure (Preserve recovery path)..."
    setup_success_mocks
    rm -f "$TEST_BIN_DIR/node" # trigger install

    echo "key_content_a" > "$WATSUP_KEYRING_DIR/nodesource.gpg"

    # Mock install tool to fail when restoring during rollback
    cat << 'EOF' > "$TEST_BIN_DIR/install"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *".bak"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" cp "$2" "$3" 2>/dev/null || PATH="$SYSTEM_PATH" cp "$1" "$2" 2>/dev/null
exit 0
EOF
    safe_make_test_executable "$TEST_BIN_DIR/install"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/install" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    # Mock nodejs install to fail
    echo -e '#!/bin/bash\nif [[ "$*" == *"install -y nodejs"* ]]; then exit 1; fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    local exit_status=$?

    if [ $exit_status -eq 0 ]; then
        echo "❌ Rollback should have failed."
        assert_test_fail
    fi

    if [[ "$output" != *"CRITICAL: Rollback failed. Recovery backup files retained at:"* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi

    # Parse retained directory from output log safely
    local retained_dir
    retained_dir=$(echo "$output" | grep "retained at:" | grep -o 'watsup_key_[a-zA-Z0-9_]*' | tail -n 1)
    if [ -n "$retained_dir" ]; then
        retained_dir="$TEST_TEMP_DIR/$retained_dir"
    fi

    # Assert recovery folder not deleted
    if [ -z "$retained_dir" ] || [ ! -d "$retained_dir" ]; then
        echo "❌ Recovery directory was cleaned up or not found on rollback failure! Retained: $retained_dir"
        assert_test_fail
    fi

    # Clean up the retained directory so we don't pollute subsequent tests
    if [ -d "$retained_dir" ]; then
        safe_remove_dir "$retained_dir"
    fi

    assert_test_pass
    echo "✅ Installer - Rollback Failure passed!"
}

test_installer_repair_reinstall() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Repair triggers reinstall (no separate npm install)..."
    setup_success_mocks

    # node exists, npm missing
    echo -e '#!/bin/bash\necho "v20.0.0"' > "$TEST_BIN_DIR/node"
    safe_make_test_executable "$TEST_BIN_DIR/node"
    rm -f "$TEST_BIN_DIR/npm"

    # Pre-populate apt_calls.log
    rm -f "$TEST_TEMP_DIR/apt_calls.log"

    # Mock node/npm presence after repair success AND record calls
    echo -e '#!/bin/bash\necho "apt-get $*" >> '"$TEST_TEMP_DIR/apt_calls.log"'\nif [[ "$*" == *"install -y --reinstall nodejs"* ]]; then\n  echo -e "#!/bin/bash\\nexit 0" > '"$TEST_BIN_DIR/npm"'
  safe_make_test_executable '"$TEST_BIN_DIR/npm"'
fi\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    ( safe_cleanup_test_root() { :; }; install_prerequisites ) || assert_test_fail

    # Assert npm mock exists and is executable
    [ -x "$TEST_BIN_DIR/npm" ] || assert_test_fail

    if ! grep -q "apt-get install -y --reinstall nodejs" "$TEST_TEMP_DIR/apt_calls.log"; then
        echo "❌ Repair did not trigger --reinstall nodejs!"
        assert_test_fail
    fi

    if grep -q "install -y npm" "$TEST_TEMP_DIR/apt_calls.log"; then
        echo "❌ Standalone npm installation was requested!"
        assert_test_fail
    fi

    assert_test_pass
    echo "✅ Installer - Repair triggers reinstall passed!"
}

test_installer_repair_failure_flow() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Installer - Repair failure flow..."
    setup_success_mocks

    # node exists, npm missing
    echo -e '#!/bin/bash\necho "v20.0.0"' > "$TEST_BIN_DIR/node"
    safe_make_test_executable "$TEST_BIN_DIR/node"
    rm -f "$TEST_BIN_DIR/npm"

    # Mock repair to do nothing (so npm is still missing after repair)
    echo -e '#!/bin/bash\nexit 0' > "$TEST_BIN_DIR/apt-get"
    safe_make_test_executable "$TEST_BIN_DIR/apt-get"

    local output
    output=$(safe_cleanup_test_root() { :; }; install_prerequisites 2>&1)
    if [ $? -eq 0 ] || [[ "$output" != *"Post-repair verification failed. npm is still missing or Node version is unsupported."* ]]; then
        echo "❌ Output log: $output"
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Installer - Repair failure flow passed!"
}

# 5. Log Rotation Test Cases

test_log_rotation_cp_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Cp Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    # Make cp fail
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/cp"
    safe_make_test_executable "$TEST_BIN_DIR/cp"

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ] || [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "old_log_content" ]; then
        echo "❌ Log was corrupted or rotation returned zero."
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Cp Failure passed!"
}

test_log_rotation_touch_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Touch Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    # Make touch fail
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/touch"
    safe_make_test_executable "$TEST_BIN_DIR/touch"

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ] || [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "old_log_content" ]; then
        echo "❌ Log was corrupted or rotation returned zero."
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Touch Failure passed!"
}

test_log_rotation_chmod_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Chmod Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    # Make chmod fail
    echo -e '#!/bin/bash\nexit 1' > "$TEST_BIN_DIR/chmod"
    safe_make_test_executable "$TEST_BIN_DIR/chmod"

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ] || [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "old_log_content" ]; then
        echo "❌ Log was corrupted or rotation returned zero."
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Chmod Failure passed!"
}

test_log_rotation_mv_old_backup_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Mv Old Backup Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    touch "${WATSUP_LOG_PATH}.1"
    # Make mv fail when moving existing backup to old backup path
    cat << 'EOF' > "$TEST_BIN_DIR/mv"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *"engine.log.1"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" mv "$@"
EOF
    safe_make_test_executable "$TEST_BIN_DIR/mv"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/mv" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ] || [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "old_log_content" ]; then
        echo "❌ Log was corrupted or rotation returned zero."
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Mv Old Backup Failure passed!"
}

test_log_rotation_mv_new_backup_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Mv New Backup Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    # Make mv fail when installing new backup (temp_backup to backup_file)
    cat << 'EOF' > "$TEST_BIN_DIR/mv"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *".tmp_bk_"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" mv "$@"
EOF
    safe_make_test_executable "$TEST_BIN_DIR/mv"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/mv" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ] || [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "old_log_content" ]; then
        echo "❌ Log was corrupted or rotation returned zero."
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Mv New Backup Failure passed!"
}

test_log_rotation_mv_new_active_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Mv New Active Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    # Make mv fail when installing new active log (temp_active to log_file)
    cat << 'EOF' > "$TEST_BIN_DIR/mv"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *".tmp_act_"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" mv "$@"
EOF
    safe_make_test_executable "$TEST_BIN_DIR/mv"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/mv" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ] || [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "old_log_content" ]; then
        echo "❌ Log was corrupted or rotation returned zero."
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Mv New Active Failure passed!"
}

test_log_rotation_mv_active_failure_preserves_content() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Active Mv Failure Preserves Log Content..."
    setup_success_mocks

    echo "CURRENT_ACTIVE" > "$WATSUP_LOG_PATH"
    echo "PREVIOUS_BACKUP" > "${WATSUP_LOG_PATH}.1"

    # Make mv fail ONLY when moving temp_active to engine.log
    cat << 'EOF' > "$TEST_BIN_DIR/mv"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$1" == *".tmp_act_"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" mv "$@"
EOF
    safe_make_test_executable "$TEST_BIN_DIR/mv"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/mv" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    rotate_engine_log
    local status=$?

    if [ $status -eq 0 ]; then
        echo "❌ rotate_engine_log should have failed."
        assert_test_fail
    fi

    if [ ! -f "$WATSUP_LOG_PATH" ] || [ "$(cat "$WATSUP_LOG_PATH")" != "CURRENT_ACTIVE" ]; then
        echo "❌ engine.log was overwritten or corrupted! Content: $(cat "$WATSUP_LOG_PATH" 2>/dev/null)"
        assert_test_fail
    fi

    if [ ! -f "${WATSUP_LOG_PATH}.1" ] || [ "$(cat "${WATSUP_LOG_PATH}.1")" != "PREVIOUS_BACKUP" ]; then
        echo "❌ engine.log.1 was not correctly restored! Content: $(cat "${WATSUP_LOG_PATH}.1" 2>/dev/null)"
        assert_test_fail
    fi

    # Clean up left-over temp files
    PATH="$SYSTEM_PATH" rm -f "$TEST_TEMP_DIR"/engine.log.tmp_*

    assert_test_pass
    echo "✅ Log Rotation - Active Mv Failure Preserves Log Content passed!"
}

test_log_rotation_mv_restore_backup_failure() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Restore Backup Failure..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    touch "${WATSUP_LOG_PATH}.1"
    # Make mv fail when installing new backup AND fail when restoring the old backup
    cat << 'EOF' > "$TEST_BIN_DIR/mv"
#!/bin/bash
source "$(dirname "$0")/path_safety_check.sh"
for arg in "$@"; do
    assert_safe_arg "$arg"
done
if [[ "$*" == *".tmp_bk_"* ]]; then
    exit 1
fi
if [[ "$1" == *".tmp_old_"* ]]; then
    exit 1
fi
PATH="$SYSTEM_PATH" mv "$@"
EOF
    safe_make_test_executable "$TEST_BIN_DIR/mv"

    # Assert failure mock rejects /etc/hosts with exit status 99
    "$TEST_BIN_DIR/mv" "/etc/hosts" &>/dev/null
    [ $? -eq 99 ] || assert_test_fail

    local output
    output=$(safe_cleanup_test_root() { :; }; rotate_engine_log 2>&1)
    local status=$?

    if [ $status -eq 0 ] || [[ "$output" != *"CRITICAL: Failed to restore original engine.log.1!"* ]]; then
        echo "❌ Status: $status, Output: $output"
        assert_test_fail
    fi

    # Clean up left-over temp files from this test to prevent polluting subsequent tests
    PATH="$SYSTEM_PATH" rm -f "$TEST_TEMP_DIR"/engine.log.tmp_*

    assert_test_pass
    echo "✅ Log Rotation - Restore Backup Failure passed!"
}

test_log_rotation_rm_temp_files() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Rm Temp Files..."
    setup_success_mocks

    echo "old_log_content" > "$WATSUP_LOG_PATH"
    touch "${WATSUP_LOG_PATH}.1"

    rotate_engine_log || assert_test_fail

    # Assert no temp files left behind in the directory
    local temp_files_count
    temp_files_count=$(find "$TEST_TEMP_DIR" -name "*.tmp_*" | wc -l)
    if [ "$temp_files_count" -ne 0 ]; then
        echo "❌ Temp files left behind: $(find "$TEST_TEMP_DIR" -name "*.tmp_*")"
        echo "=== Mock Calls ==="
        cat "$TEST_TEMP_DIR/mock_calls.log" 2>/dev/null
        assert_test_fail
    fi
    assert_test_pass
    echo "✅ Log Rotation - Rm Temp Files passed!"
}

test_log_rotation_full_success() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Log Rotation - Full Success..."
    setup_success_mocks

    echo "OLD_LOG_CONTENT" > "$WATSUP_LOG_PATH"
    touch "${WATSUP_LOG_PATH}.1"

    rotate_engine_log || assert_test_fail

    # Assert engine.log.1 contains OLD_LOG_CONTENT
    if [ "$(cat "${WATSUP_LOG_PATH}.1")" != "OLD_LOG_CONTENT" ]; then
        echo "❌ New backup content mismatch!"
        assert_test_fail
    fi

    # Assert engine.log exists and is empty
    if [ -s "$WATSUP_LOG_PATH" ]; then
        echo "❌ New active log is not empty!"
        assert_test_fail
    fi

    # Assert no temporary files left behind
    local temp_files_count
    temp_files_count=$(find "$TEST_TEMP_DIR" -name "*.tmp_*" | wc -l)
    if [ "$temp_files_count" -ne 0 ]; then
        echo "❌ Temp files left behind: $(find "$TEST_TEMP_DIR" -name "*.tmp_*")"
        assert_test_fail
    fi

    # Verify permissions 0600
    verify_perms "$WATSUP_LOG_PATH" 600 || assert_test_fail
    verify_perms "${WATSUP_LOG_PATH}.1" 600 || assert_test_fail

    assert_test_pass
    echo "✅ Log Rotation - Full Success passed!"
}

# 6. Signal Traps Testing in Child Shells
test_signal_traps() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: Signal Traps (SIGINT/SIGTERM)..."

    # SIGINT child process test
    local sigint_out
    sigint_out=$(bash -c '
        source ./launch.sh
        TEST_TEMP_DIR="'"$TEST_TEMP_DIR"'"
        cleanup_active_temp() {
            echo "cleanup_active_temp_called" >> "$TEST_TEMP_DIR/trap_sigint.log"
            return 0
        }
        trap "cleanup_sig INT" INT
        kill -s INT "$$"
    ' 2>&1)
    local sigint_status=$?

    if [ $sigint_status -ne 130 ] || [ ! -f "$TEST_TEMP_DIR/trap_sigint.log" ] || [ "$(cat "$TEST_TEMP_DIR/trap_sigint.log")" != "cleanup_active_temp_called" ]; then
        echo "❌ SIGINT test failed: status=$sigint_status, log=$(cat "$TEST_TEMP_DIR/trap_sigint.log" 2>/dev/null)"
        assert_test_fail
    fi
    rm -f "$TEST_TEMP_DIR/trap_sigint.log"

    # SIGTERM child process test
    local sigterm_out
    sigterm_out=$(bash -c '
        source ./launch.sh
        TEST_TEMP_DIR="'"$TEST_TEMP_DIR"'"
        cleanup_active_temp() {
            echo "cleanup_active_temp_called" >> "$TEST_TEMP_DIR/trap_sigterm.log"
            return 0
        }
        trap "cleanup_sig TERM" TERM
        kill -s TERM "$$"
    ' 2>&1)
    local sigterm_status=$?

    if [ $sigterm_status -ne 143 ] || [ ! -f "$TEST_TEMP_DIR/trap_sigterm.log" ] || [ "$(cat "$TEST_TEMP_DIR/trap_sigterm.log")" != "cleanup_active_temp_called" ]; then
        echo "❌ SIGTERM test failed: status=$sigterm_status, log=$(cat "$TEST_TEMP_DIR/trap_sigterm.log" 2>/dev/null)"
        assert_test_fail
    fi
    rm -f "$TEST_TEMP_DIR/trap_sigterm.log"

    # PRESERVE_ACTIVE_TEMP does not clean up recovery directory on EXIT trap
    local preserve_out
    preserve_out=$(bash -c '
        source ./launch.sh
        export PRESERVE_ACTIVE_TEMP=true
        export ACTIVE_TEMP_DIR="'"$TEST_TEMP_DIR"'/mock_active_recover"
        mkdir -p "$ACTIVE_TEMP_DIR"
        trap cleanup_exit EXIT
    ')
    if [ ! -d "$TEST_TEMP_DIR/mock_active_recover" ]; then
        echo "❌ Directory mock_active_recover was incorrectly cleaned up even with PRESERVE_ACTIVE_TEMP=true"
        assert_test_fail
    fi
    safe_remove_dir "$TEST_TEMP_DIR/mock_active_recover"

    assert_test_pass
    echo "✅ Signal Traps passed!"
}

# NPM Safety Matrix Test call
test_npm_safety_matrix() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "🧪 Running Test: NPM Safety matrix..."

    local w_dir="$TEST_TEMP_DIR/npm_safety_work"
    safe_reset_dir "$w_dir"
    cd "$w_dir"

    # 1. Missing package-lock.json exits non-zero without calling npm
    rm -f package-lock.json
    safe_remove_dir node_modules
    rm -f "$TEST_TEMP_DIR/mock_calls.log"

    ( safe_cleanup_test_root() { :; }; install_node_modules ) 2>/dev/null
    local exit_status=$?
    if [ $exit_status -eq 0 ]; then
        echo "❌ Error: install_node_modules should fail when package-lock.json is missing." >&2
        assert_test_fail
    fi
    if grep -q "npm" "$TEST_TEMP_DIR/mock_calls.log" 2>/dev/null; then
        echo "❌ Error: npm was called even though package-lock.json is missing." >&2
        assert_test_fail
    fi

    # 2. Presence of node_modules/express prevents npm ci
    touch package-lock.json
    mkdir -p node_modules/express
    rm -f "$TEST_TEMP_DIR/mock_calls.log"

    install_node_modules || assert_test_fail
    if grep -q "npm" "$TEST_TEMP_DIR/mock_calls.log" 2>/dev/null; then
        echo "❌ Error: npm ci was called even though node_modules/express exists." >&2
        assert_test_fail
    fi

    # 3. Absence of node_modules/express calls exactly npm ci --omit=dev exactly once
    safe_remove_dir node_modules
    rm -f "$TEST_TEMP_DIR/mock_calls.log"

    # Mock npm to succeed
    echo -e '#!/bin/bash\necho "npm $*" >> '"$TEST_TEMP_DIR/mock_calls.log"'\nexit 0' > "$TEST_BIN_DIR/npm"
    safe_make_test_executable "$TEST_BIN_DIR/npm"

    install_node_modules || assert_test_fail

    # Verify npm ci --omit=dev was called exactly once
    local npm_calls
    npm_calls=$(grep -c "^npm ci --omit=dev$" "$TEST_TEMP_DIR/mock_calls.log" 2>/dev/null || echo 0)
    if [ "$npm_calls" -ne 1 ]; then
        echo "❌ Error: npm ci --omit=dev was not called exactly once. Actual calls count: $npm_calls" >&2
        assert_test_fail
    fi

    cd "$APP_DIR"
    assert_test_pass
    echo "✅ NPM Safety matrix passed!"
}

# Run all test cases in order
test_sandbox_safety_enforced_on_mocks
test_nonexistent_evil_sibling_path_rejected
test_verify_perms_unbound_safety
test_sourcing_traps
test_boundary_checks
test_sourcing_fails_on_symlink_escape

test_installer_all_present
test_installer_no_root_no_sudo
test_installer_bootstrap_update_fail
test_installer_bootstrap_install_fail
test_installer_curl_fail
test_installer_gpg_fail
test_installer_mktemp_fail
test_installer_keyring_backup_fail
test_installer_sourcelist_backup_fail
test_installer_keyring_install_fail
test_installer_sourcelist_install_fail
test_installer_chmod_fail
test_installer_nodesource_update_fail
test_installer_nodejs_apt_fail
test_installer_post_install_node_missing
test_installer_post_install_npm_missing
test_installer_post_install_node_v16
test_installer_rollback_success
test_installer_rollback_success_non_root
test_installer_rollback_failure
test_installer_repair_reinstall
test_installer_repair_failure_flow

test_log_rotation_cp_failure
test_log_rotation_touch_failure
test_log_rotation_chmod_failure
test_log_rotation_mv_old_backup_failure
test_log_rotation_mv_new_backup_failure
test_log_rotation_mv_new_active_failure
test_log_rotation_mv_active_failure_preserves_content
test_log_rotation_mv_restore_backup_failure
test_log_rotation_rm_temp_files
test_log_rotation_full_success

test_signal_traps
test_npm_safety_matrix

echo "🎉 All launch.sh mock shell tests completed!"
echo "passed: $TESTS_PASSED"
echo "failed: $TESTS_FAILED"
echo "skipped: $SKIPPED_PERMS_COUNT"

if [ "$TESTS_FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
