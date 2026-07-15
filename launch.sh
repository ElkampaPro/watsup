#!/bin/bash
# WatsUp Streamer - launch.sh
# Multi-purpose self-installing launcher for background Node.js engine and Python Tkinter GUI.
# Designed to be run inside the default LinuxServer Webtop container.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Only run umask, cd, and register traps if executed directly, not sourced
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    umask 077
    cd "$APP_DIR"
fi

# Explicit commands for security and injection wrapping
CP_CMD="${WATSUP_CP:-cp}"
MV_CMD="${WATSUP_MV:-mv}"
RM_CMD="${WATSUP_RM:-rm}"
TOUCH_CMD="${WATSUP_TOUCH:-touch}"
APT_GET_CMD="${WATSUP_APT_GET:-apt-get}"
CURL_CMD="${WATSUP_CURL:-curl}"
GPG_CMD="${WATSUP_GPG:-gpg}"
MKTEMP_CMD="${WATSUP_MKTEMP:-mktemp}"
INSTALL_CMD="${WATSUP_INSTALL:-install}"
CHMOD_CMD="${WATSUP_CHMOD:-chmod}"
SUDO_CMD="${WATSUP_SUDO:-sudo}"
CMP_CMD="${WATSUP_CMP:-cmp}"

verify_executable() {
    local val="$1"
    if [ -z "$val" ]; then
        return 1
    fi
    if [[ "$val" == *"/"* ]]; then
        if [ -x "$val" ]; then
            return 0
        else
            return 1
        fi
    else
        if command -v "$val" &>/dev/null; then
            return 0
        else
            return 1
        fi
    fi
}

validate_test_path() {
    local path_val="$1"
    local desc="$2"
    if [ -z "$path_val" ]; then
        echo "❌ Error: $desc is empty in test mode." >&2
        return 1
    fi

    # Reject broken symlinks
    if [ -L "$path_val" ] && [ ! -e "$path_val" ]; then
        echo "❌ Error: $desc is a broken symlink in test mode." >&2
        return 1
    fi

    if [ -e "$path_val" ] || [ -L "$path_val" ]; then
        # Target exists or is symlink
        local canonical_target=""
        if command -v realpath &>/dev/null; then
            canonical_target=$(realpath "$path_val" 2>/dev/null)
        elif command -v readlink &>/dev/null; then
            canonical_target=$(readlink -f "$path_val" 2>/dev/null)
        fi
        if [ -z "$canonical_target" ]; then
            echo "❌ Error: Could not resolve canonical target of $desc in test mode." >&2
            return 1
        fi
        case "$canonical_target" in
            "$canonical_test_root"/*) ;;
            *)
                echo "❌ Error: $desc target '$canonical_target' is outside WATSUP_TEST_ROOT in test mode." >&2
                return 1
                ;;
        esac
    else
        # Target does not exist and is not a symlink
        local parent_dir
        local base_name
        parent_dir=$(dirname "$path_val")
        base_name=$(basename "$path_val")

        if [ -z "$base_name" ] || [ "$base_name" = "." ] || [ "$base_name" = ".." ]; then
            echo "❌ Error: $desc has invalid basename '$base_name' in test mode." >&2
            return 1
        fi

        local canonical_parent=""
        if command -v realpath &>/dev/null; then
            canonical_parent=$(realpath "$parent_dir" 2>/dev/null)
        elif command -v readlink &>/dev/null; then
            canonical_parent=$(readlink -f "$parent_dir" 2>/dev/null)
        fi

        if [ -z "$canonical_parent" ] || [ ! -d "$canonical_parent" ]; then
            echo "❌ Error: Parent directory of $desc ('$parent_dir') is missing or invalid in test mode." >&2
            return 1
        fi

        case "$canonical_parent" in
            "$canonical_test_root" | "$canonical_test_root"/*) ;;
            *)
                echo "❌ Error: Parent of $desc is outside WATSUP_TEST_ROOT in test mode." >&2
                return 1
                ;;
        esac

        local canonical_path="$canonical_parent/$base_name"
        case "$canonical_path" in
            "$canonical_test_root"/*) ;;
            *)
                echo "❌ Error: $desc path is not a strict child of WATSUP_TEST_ROOT." >&2
                return 1
                ;;
        esac
    fi

    return 0
}

if [ "${WATSUP_TEST_MODE:-false}" = "true" ]; then
    if [ -z "${WATSUP_TEST_ROOT:-}" ]; then
        echo "❌ Error: WATSUP_TEST_ROOT is required in test mode." >&2
        exit 1
    fi

    canonical_test_root=""
    if command -v realpath &>/dev/null; then
        canonical_test_root=$(realpath "$WATSUP_TEST_ROOT" 2>/dev/null)
    elif command -v readlink &>/dev/null; then
        canonical_test_root=$(readlink -f "$WATSUP_TEST_ROOT" 2>/dev/null)
    fi

    if [ -z "$canonical_test_root" ] || [ ! -d "$canonical_test_root" ]; then
        echo "❌ Error: WATSUP_TEST_ROOT is not a valid directory." >&2
        exit 1
    fi

    validate_test_path "${WATSUP_ETC_DIR:-}" "WATSUP_ETC_DIR" || exit 1
    validate_test_path "${WATSUP_KEYRING_DIR:-}" "WATSUP_KEYRING_DIR" || exit 1
    validate_test_path "${WATSUP_NODESOURCE_LIST:-}" "WATSUP_NODESOURCE_LIST" || exit 1
    validate_test_path "${WATSUP_LOG_PATH:-}" "WATSUP_LOG_PATH" || exit 1
fi

run_as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        "$SUDO_CMD" "$@"
    fi
}

is_safe_temp_dir() {
    local dir="$1"
    if [ -z "$dir" ]; then
        return 1
    fi

    # Ensure realpath or readlink -f is available, otherwise fail
    local canonical_dir=""
    if command -v realpath &>/dev/null; then
        canonical_dir=$(realpath "$dir" 2>/dev/null)
    elif command -v readlink &>/dev/null; then
        canonical_dir=$(readlink -f "$dir" 2>/dev/null)
    else
        echo "❌ Error: realpath or readlink -f is not available." >&2
        return 1
    fi

    if [ -z "$canonical_dir" ] || [ ! -d "$canonical_dir" ]; then
        return 1
    fi

    local base_name
    base_name=$(basename "$canonical_dir")

    # Reject basename if empty, ".", or ".."
    if [ -z "$base_name" ] || [ "$base_name" = "." ] || [ "$base_name" = ".." ]; then
        return 1
    fi

    if [[ ! "$base_name" =~ ^watsup_(key|test)_ ]]; then
        return 1
    fi

    local temp_dir="${TMPDIR:-/tmp}"
    local canonical_temp=""
    if command -v realpath &>/dev/null; then
        canonical_temp=$(realpath "$temp_dir" 2>/dev/null)
    elif command -v readlink &>/dev/null; then
        canonical_temp=$(readlink -f "$temp_dir" 2>/dev/null)
    fi

    if [ -z "$canonical_temp" ] || [ ! -d "$canonical_temp" ]; then
        return 1
    fi

    # Strict child boundary check using case statement
    case "$canonical_dir" in
        "$canonical_temp"/*) ;;
        *) return 1 ;;
    esac

    # Canonicalize HOME and APP_DIR before comparing
    local canonical_home=""
    local canonical_app=""
    if command -v realpath &>/dev/null; then
        canonical_home=$(realpath "$HOME" 2>/dev/null)
        canonical_app=$(realpath "$APP_DIR" 2>/dev/null)
    else
        canonical_home=$(readlink -f "$HOME" 2>/dev/null)
        canonical_app=$(readlink -f "$APP_DIR" 2>/dev/null)
    fi

    if [ "$canonical_dir" = "/" ] || [ "$canonical_dir" = "/tmp" ]; then
        return 1
    fi
    if [ -n "$canonical_home" ] && [ "$canonical_dir" = "$canonical_home" ]; then
        return 1
    fi
    if [ -n "$canonical_app" ] && [ "$canonical_dir" = "$canonical_app" ]; then
        return 1
    fi

    return 0
}

safe_cleanup_temp_dir() {
    local dir="$1"
    if is_safe_temp_dir "$dir"; then
        local abs_dir
        if command -v realpath &>/dev/null; then
            abs_dir=$(realpath "$dir")
        else
            abs_dir="$dir"
        fi
        "$RM_CMD" -rf "$abs_dir"
    else
        echo "⚠️ Warning: Refused to delete unsafe directory path: '$dir'"
        return 1
    fi
}

ACTIVE_TEMP_DIR=""

cleanup_active_temp() {
    if [ -n "$ACTIVE_TEMP_DIR" ]; then
        if [ "${PRESERVE_ACTIVE_TEMP:-false}" = "true" ]; then
            echo "⚠️ Notice: Active temp directory preserved: '$ACTIVE_TEMP_DIR'"
            return 0
        fi
        local dir_to_clean="$ACTIVE_TEMP_DIR"
        ACTIVE_TEMP_DIR=""
        if ! safe_cleanup_temp_dir "$dir_to_clean"; then
            ACTIVE_TEMP_DIR="$dir_to_clean"
            return 1
        fi
    fi
    return 0
}

cleanup_exit() {
    cleanup_active_temp
}

cleanup_sig() {
    local sig="$1"
    cleanup_active_temp
    trap - "$sig"
    kill -s "$sig" "$$"
}

# Only register traps if the script is executed directly (not sourced)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    trap cleanup_exit EXIT
    trap 'cleanup_sig INT' INT
    trap 'cleanup_sig TERM' TERM
fi

# 1. Dependency Verification and Auto-installer
rotate_engine_log() {
    local log_file="${WATSUP_LOG_PATH:-engine.log}"
    local backup_file="${log_file}.1"
    local max_size=$((5 * 1024 * 1024)) # 5MB

    if [ ! -f "$log_file" ]; then
        return 0
    fi

    # Verify all wrappers before using them
    verify_executable "$MKTEMP_CMD" || { echo "❌ Error: mktemp executable verify failed."; return 1; }
    verify_executable "$CP_CMD" || { echo "❌ Error: cp executable verify failed."; return 1; }
    verify_executable "$MV_CMD" || { echo "❌ Error: mv executable verify failed."; return 1; }
    verify_executable "$RM_CMD" || { echo "❌ Error: rm executable verify failed."; return 1; }
    verify_executable "$CHMOD_CMD" || { echo "❌ Error: chmod executable verify failed."; return 1; }
    verify_executable "$TOUCH_CMD" || { echo "❌ Error: touch executable verify failed."; return 1; }
    verify_executable "$CMP_CMD" || { echo "❌ Error: cmp executable verify failed."; return 1; }

    local file_size
    file_size=$(stat -c%s "$log_file" 2>/dev/null || stat -f%z "$log_file" 2>/dev/null || wc -c < "$log_file" 2>/dev/null || echo 0)
    file_size=$(echo "$file_size" | tr -d '[:space:]')

    if [ "$file_size" -le "$max_size" ]; then
        return 0
    fi

    echo "🔄 Rotating large engine log file..."

    # 1. Create a temporary backup file in the same directory using mktemp
    local log_dir
    log_dir=$(dirname "$log_file")
    local temp_backup
    temp_backup=$("$MKTEMP_CMD" "$log_file.tmp_bk_XXXXXX" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$temp_backup" ] || [ ! -f "$temp_backup" ]; then
        echo "❌ Error: Failed to create temporary backup file." >&2
        return 1
    fi

    # 2. Copy current log to temporary backup
    if ! "$CP_CMD" "$log_file" "$temp_backup"; then
        echo "❌ Error: Failed to copy log to temporary backup." >&2
        "$RM_CMD" -f "$temp_backup" 2>/dev/null
        return 1
    fi

    # Verify content matches using cmp
    if ! "$CMP_CMD" "$log_file" "$temp_backup" &>/dev/null; then
        echo "❌ Error: Copied backup content verification failed." >&2
        "$RM_CMD" -f "$temp_backup" 2>/dev/null
        return 1
    fi

    # Set temporary backup permissions to 0600 before installing
    if ! "$CHMOD_CMD" 600 "$temp_backup"; then
        echo "❌ Error: Failed to set permissions on temporary backup log." >&2
        "$RM_CMD" -f "$temp_backup" 2>/dev/null
        return 1
    fi

    # 3. Create a temporary empty active log file with permissions 0600
    local temp_active
    temp_active=$("$MKTEMP_CMD" "$log_file.tmp_act_XXXXXX" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$temp_active" ] || [ ! -f "$temp_active" ]; then
        echo "❌ Error: Failed to create temporary active log file." >&2
        "$RM_CMD" -f "$temp_backup" 2>/dev/null
        return 1
    fi

    if ! "$TOUCH_CMD" "$temp_active"; then
        echo "❌ Error: Failed to touch temporary active log." >&2
        "$RM_CMD" -f "$temp_backup" "$temp_active" 2>/dev/null
        return 1
    fi

    # Set temporary active permissions to 0600 before installing
    if ! "$CHMOD_CMD" 600 "$temp_active"; then
        echo "❌ Error: Failed to set permissions on temporary active log." >&2
        "$RM_CMD" -f "$temp_backup" "$temp_active" 2>/dev/null
        return 1
    fi

    # 4. If engine.log.1 exists, move it to a temporary recovery file instead of deleting it immediately
    local temp_old_backup=""
    if [ -f "$backup_file" ]; then
        temp_old_backup=$("$MKTEMP_CMD" "$log_file.tmp_old_XXXXXX" 2>/dev/null)
        if [ $? -ne 0 ] || [ -z "$temp_old_backup" ]; then
            echo "❌ Error: Failed to create temporary recovery path for old backup." >&2
            "$RM_CMD" -f "$temp_backup" "$temp_active" 2>/dev/null
            return 1
        fi
        if ! "$MV_CMD" "$backup_file" "$temp_old_backup"; then
            echo "❌ Error: Failed to backup existing engine.log.1." >&2
            "$RM_CMD" -f "$temp_backup" "$temp_active" "$temp_old_backup" 2>/dev/null
            return 1
        fi
    fi

    # 5. Install the new backup file (rename temp_backup to engine.log.1)
    if ! "$MV_CMD" "$temp_backup" "$backup_file"; then
        echo "❌ Error: Failed to install new backup log." >&2
        # Restore old backup if we moved it
        if [ -n "$temp_old_backup" ] && [ -f "$temp_old_backup" ]; then
            if ! "$MV_CMD" "$temp_old_backup" "$backup_file"; then
                echo "❌ CRITICAL: Failed to restore original engine.log.1! Recovery files retained at: temp_old_backup='$temp_old_backup', temp_backup='$temp_backup', temp_active='$temp_active'" >&2
                return 1
            fi
        fi
        "$RM_CMD" -f "$temp_backup" "$temp_active" 2>/dev/null
        return 1
    fi

    # 6. Install the new active log (rename temp_active to engine.log)
    if ! "$MV_CMD" "$temp_active" "$log_file"; then
        echo "❌ Error: Failed to install new active log." >&2
        # Rollback backup file
        if [ -n "$temp_old_backup" ] && [ -f "$temp_old_backup" ]; then
            if ! "$MV_CMD" "$temp_old_backup" "$backup_file"; then
                echo "❌ CRITICAL: Failed to restore original engine.log.1! Recovery files retained at: temp_old_backup='$temp_old_backup', temp_active='$temp_active'" >&2
                return 1
            fi
        else
            # If no old backup existed, clean up the installed backup_file
            if ! "$RM_CMD" -f "$backup_file"; then
                echo "❌ Error: Failed to remove temporary backup file on fallback." >&2
                return 1
            fi
        fi
        if ! "$RM_CMD" -f "$temp_active"; then
            echo "❌ Error: Failed to remove temporary active file on fallback." >&2
            return 1
        fi
        return 1
    fi

    # 7. Success! Clean up temp_old_backup if it exists
    if [ -n "$temp_old_backup" ] && [ -f "$temp_old_backup" ]; then
        if ! "$RM_CMD" -f "$temp_old_backup"; then
            echo "❌ Error: Failed to clean up temporary old backup file." >&2
            return 1
        fi
    fi

    if ! "$CHMOD_CMD" 600 "$log_file"; then
        echo "❌ Error: Failed to set permissions on active log file." >&2
        return 1
    fi
    if ! "$CHMOD_CMD" 600 "$backup_file"; then
        echo "❌ Error: Failed to set permissions on backup log file." >&2
        return 1
    fi

    echo "✅ Engine log file rotated successfully."
    return 0
}

rollback_nodesource_config() {
    local keyring_dir="$1"
    local nodesource_list="$2"
    local backup_key_file="$3"
    local backup_list_file="$4"

    local rollback_failed=false

    echo "⚠️ Transaction failed. Triggering rollback of configuration..."

    # Restore keyring GPG key
    if [ -n "$backup_key_file" ] && [ -f "$backup_key_file" ]; then
        if ! run_as_root "$INSTALL_CMD" -m 644 "$backup_key_file" "$keyring_dir/nodesource.gpg"; then
            rollback_failed=true
        fi
    else
        if [ -f "$keyring_dir/nodesource.gpg" ]; then
            if ! run_as_root "$RM_CMD" -f "$keyring_dir/nodesource.gpg"; then
                rollback_failed=true
            fi
        fi
    fi

    # Restore sources list
    if [ -n "$backup_list_file" ] && [ -f "$backup_list_file" ]; then
        if ! run_as_root "$INSTALL_CMD" -m 644 "$backup_list_file" "$nodesource_list"; then
            rollback_failed=true
        fi
    else
        if [ -f "$nodesource_list" ]; then
            if ! run_as_root "$RM_CMD" -f "$nodesource_list"; then
                rollback_failed=true
            fi
        fi
    fi

    if [ "$rollback_failed" = "true" ]; then
        echo "❌ CRITICAL ERROR: NodeSource config rollback failed!" >&2
        return 1
    fi
    return 0
}

install_prerequisites() {
    # Read injected path variables to support test mode sandboxing
    local etc_dir="${WATSUP_ETC_DIR:-/etc}"
    local keyring_dir="${WATSUP_KEYRING_DIR:-$etc_dir/apt/keyrings}"
    local nodesource_list="${WATSUP_NODESOURCE_LIST:-$etc_dir/apt/sources.list.d/nodesource.list}"

    MISSING_DEPS=()
    NEED_NODE_INSTALL=false
    NEED_NODE_REPAIR=false

    if ! command -v node &> /dev/null; then
        NEED_NODE_INSTALL=true
    else
        local node_ver
        node_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
        if [ -z "$node_ver" ] || [ "$node_ver" -lt 18 ]; then
            NEED_NODE_INSTALL=true
        fi
    fi

    # If node exists but npm is missing, flag for reinstall/repair (never install npm standalone)
    if [ "$NEED_NODE_INSTALL" = "false" ] && ! command -v npm &> /dev/null; then
        NEED_NODE_REPAIR=true
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

    if [ "$NEED_NODE_INSTALL" = "true" ] || [ "$NEED_NODE_REPAIR" = "true" ] || [ ${#MISSING_DEPS[@]} -ne 0 ]; then
        # Verify apt-get executable wrapper before proceeding
        verify_executable "$APT_GET_CMD" || { echo "❌ Error: apt-get executable verify failed."; exit 1; }
        verify_executable "$CP_CMD" || { echo "❌ Error: cp executable verify failed."; exit 1; }
        verify_executable "$MV_CMD" || { echo "❌ Error: mv executable verify failed."; exit 1; }
        verify_executable "$RM_CMD" || { echo "❌ Error: rm executable verify failed."; exit 1; }
        verify_executable "$TOUCH_CMD" || { echo "❌ Error: touch executable verify failed."; exit 1; }

        # Check if apt-get is available
        if ! command -v "$APT_GET_CMD" &> /dev/null; then
            echo "❌ Error: apt-get package manager not found. This auto-installer only supports apt-based Debian/Ubuntu systems."
            exit 1
        fi

        echo "📦 Missing prerequisites detected. Checking permissions for auto-installation..."

        local has_root=false
        local sudo_prefix=""
        if [ "$(id -u)" -eq 0 ]; then
            has_root=true
        else
            if verify_executable "$SUDO_CMD"; then
                if "$SUDO_CMD" -n true 2>/dev/null; then
                    has_root=true
                    sudo_prefix="$SUDO_CMD"
                fi
            fi
        fi

        if [ "$has_root" = "false" ]; then
            echo "❌ Error: Root or passwordless sudo permissions are required for automatic installation."
            echo "🔧 Please run the following command manually on your host/container to install them:"
            echo "   sudo apt-get update && sudo apt-get install -y nodejs python3-tk lsof curl"
            exit 1
        fi

        # 1. Bootstrap Phase: Ensure ca-certificates, curl, and gnupg are present first
        local bootstrap_missing=()
        if ! command -v curl &> /dev/null; then bootstrap_missing+=("curl"); fi
        if ! command -v gpg &> /dev/null; then bootstrap_missing+=("gnupg"); fi

        local check_ca_file="/etc/ssl/certs/ca-certificates.crt"
        if [ "$WATSUP_TEST_MODE" = "true" ]; then
            check_ca_file="$etc_dir/ssl/certs/ca-certificates.crt"
        fi
        if [ ! -f "$check_ca_file" ]; then
            bootstrap_missing+=("ca-certificates")
        fi

        if [ ${#bootstrap_missing[@]} -ne 0 ]; then
            echo "⚙️ Bootstrapping core installer dependencies: ${bootstrap_missing[*]}..."
            export DEBIAN_FRONTEND=noninteractive
            run_as_root "$APT_GET_CMD" update -y
            if [ $? -ne 0 ]; then
                echo "❌ Error: apt-get update failed during bootstrap."
                exit 1
            fi
            run_as_root "$APT_GET_CMD" install -y "${bootstrap_missing[@]}"
            if [ $? -ne 0 ]; then
                echo "❌ Error: Failed to install installer bootstrap dependencies."
                exit 1
            fi
        fi
        # 2. NodeSource Keyring setup (Node.js install/upgrade)
        if [ "$NEED_NODE_INSTALL" = "true" ]; then
            verify_executable "$CURL_CMD" || { echo "❌ Error: curl executable verify failed."; exit 1; }
            verify_executable "$GPG_CMD" || { echo "❌ Error: gpg executable verify failed."; exit 1; }
            verify_executable "$MKTEMP_CMD" || { echo "❌ Error: mktemp executable verify failed."; exit 1; }
            verify_executable "$INSTALL_CMD" || { echo "❌ Error: install executable verify failed."; exit 1; }
            verify_executable "$CHMOD_CMD" || { echo "❌ Error: chmod executable verify failed."; exit 1; }

            echo "📦 Preparing NodeSource repository (v20 LTS)..."
            local temp_keyring_dir
            temp_keyring_dir=$("$MKTEMP_CMD" -d -t watsup_key_XXXXXX 2>/dev/null)
            if [ $? -ne 0 ] || [ -z "$temp_keyring_dir" ]; then
                echo "❌ Error: Failed to create secure temporary directory."
                exit 1
            fi

            if ! is_safe_temp_dir "$temp_keyring_dir"; then
                echo "❌ Error: Created temporary directory path is unsafe."
                exit 1
            fi

            ACTIVE_TEMP_DIR="$temp_keyring_dir"

            local temp_key_file="$temp_keyring_dir/nodesource.gpg.tmp"
            local temp_list_file="$temp_keyring_dir/nodesource.list.tmp"

            # Execute pipe verification inside a subshell to keep parent script clean of pipefail side-effects
            (
                set -o pipefail
                "$CURL_CMD" -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | "$GPG_CMD" --dearmor -o "$temp_key_file"
            )
            local curl_gpg_status=$?

            if [ $curl_gpg_status -ne 0 ] || [ ! -s "$temp_key_file" ]; then
                echo "❌ Error: Failed to download or dearmor NodeSource repository GPG key."
                cleanup_active_temp
                exit 1
            fi

            local list_content="deb [signed-by=$keyring_dir/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main"
            echo "$list_content" > "$temp_list_file"
            if [ $? -ne 0 ]; then
                echo "❌ Error: Failed to write temporary source list."
                cleanup_active_temp
                exit 1
            fi

            # Backup transaction start
            local backup_key_file=""
            local backup_list_file=""

            if [ -f "$keyring_dir/nodesource.gpg" ]; then
                local tmp_bk_key="$temp_keyring_dir/nodesource.gpg.bak"
                if "$CP_CMD" "$keyring_dir/nodesource.gpg" "$tmp_bk_key"; then
                    backup_key_file="$tmp_bk_key"
                else
                    echo "❌ Error: Keyring backup failed."
                    cleanup_active_temp
                    exit 1
                fi
            fi
            if [ -f "$nodesource_list" ]; then
                local tmp_bk_list="$temp_keyring_dir/nodesource.list.bak"
                if "$CP_CMD" "$nodesource_list" "$tmp_bk_list"; then
                    backup_list_file="$tmp_bk_list"
                else
                    echo "❌ Error: Source list backup failed."
                    cleanup_active_temp
                    exit 1
                fi
            fi

            # Install directories and files with explicit secure permissions
            local transaction_failed=false
            run_as_root mkdir -p "$keyring_dir" && \
            run_as_root "$CHMOD_CMD" 755 "$keyring_dir" 2>/dev/null && \
            run_as_root "$INSTALL_CMD" -m 644 "$temp_key_file" "$keyring_dir/nodesource.gpg" && \
            run_as_root mkdir -p "$(dirname "$nodesource_list")" && \
            run_as_root "$INSTALL_CMD" -m 644 "$temp_list_file" "$nodesource_list"
            local install_status=$?

            if [ $install_status -ne 0 ]; then
                transaction_failed=true
            fi

            if [ "$transaction_failed" = "false" ]; then
                echo "⚙️ Updating apt repositories and installing nodejs..."
                run_as_root "$APT_GET_CMD" update -y
                if [ $? -ne 0 ]; then transaction_failed=true; fi
            fi

            if [ "$transaction_failed" = "false" ]; then
                run_as_root "$APT_GET_CMD" install -y nodejs
                if [ $? -ne 0 ]; then transaction_failed=true; fi
            fi

            # If transaction succeeded, verify installation first before cleaning up backups
            if [ "$transaction_failed" = "false" ]; then
                local node_ok=false
                if command -v node &>/dev/null && command -v npm &>/dev/null; then
                    local node_ver
                    node_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
                    if [ -n "$node_ver" ] && [ "$node_ver" -ge 18 ]; then
                        node_ok=true
                    fi
                fi
                if [ "$node_ok" = "false" ]; then
                    transaction_failed=true
                fi
            fi

            if [ "$transaction_failed" = "true" ]; then
                if rollback_nodesource_config "$keyring_dir" "$nodesource_list" "$backup_key_file" "$backup_list_file"; then
                    cleanup_active_temp
                else
                    echo "❌ CRITICAL: Rollback failed. Recovery backup files retained at: '$temp_keyring_dir'" >&2
                    PRESERVE_ACTIVE_TEMP=true
                    exit 1
                fi
                exit 1
            fi

            cleanup_active_temp
        fi

        # 3. Node.js repair if npm is missing but node exists
        if [ "$NEED_NODE_REPAIR" = "true" ]; then
            echo "🔧 Node.js is present but npm is missing. Reinstalling nodejs package..."
            run_as_root "$APT_GET_CMD" install -y --reinstall nodejs
            if [ $? -ne 0 ]; then
                echo "❌ Error: Failed to repair Node.js installation."
                exit 1
            fi

            # Post-repair validation check
            local repair_ok=false
            if command -v node &>/dev/null && command -v npm &>/dev/null; then
                local node_ver
                node_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
                if [ -n "$node_ver" ] && [ "$node_ver" -ge 18 ]; then
                    repair_ok=true
                fi
            fi
            if [ "$repair_ok" = "false" ]; then
                echo "❌ Error: Post-repair verification failed. npm is still missing or Node version is unsupported." >&2
                exit 1
            fi
        fi

        # 4. Install other missing dependencies
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
            fi
        done

        if [ ${#apt_deps[@]} -ne 0 ]; then
            echo "📦 Installing system packages: ${apt_deps[*]}..."
            run_as_root "$APT_GET_CMD" install -y "${apt_deps[@]}"
            if [ $? -ne 0 ]; then
                echo "❌ Error: Failed to install system packages."
                exit 1
            fi
        fi

        # Post-install verification check
        local final_missing=()
        if ! command -v node &> /dev/null; then
            final_missing+=("node")
        else
            local node_ver
            node_ver=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
            if [ -z "$node_ver" ] || [ "$node_ver" -lt 18 ]; then
                final_missing+=("node>=18")
            fi
        fi
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
        if [ ! -f ".tkinterdnd2_attempted" ]; then
            echo "📦 Python 'tkinterdnd2' library is missing. Attempting automatic user-local installation..."
            # Write marker file with 0600 permissions
            "$TOUCH_CMD" ".tkinterdnd2_attempted"
            "$CHMOD_CMD" 600 ".tkinterdnd2_attempted" 2>/dev/null

            if ! python3 -m pip --version &> /dev/null; then
                echo "⚠️ Warning: pip is not available. Skipping automatic tkinterdnd2 installation."
            else
                echo "🔧 Installing tkinterdnd2 via python3 -m pip (user-local)..."
                python3 -m pip install --user tkinterdnd2 &>/dev/null
                if python3 -c "import tkinterdnd2" &> /dev/null; then
                    echo "✅ Python 'tkinterdnd2' installed successfully! Drag & Drop is enabled."
                else
                    echo "⚠️ Warning: Failed to install 'tkinterdnd2'. Drag & Drop will be disabled."
                fi
            fi
        else
            echo "ℹ️ Notice: tkinterdnd2 installation was previously attempted and failed. Skipping retry."
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

    local icon_val="system-run"
    local icon_path="$APP_DIR/watsup.png"
    if [ -f "$icon_path" ] && [ -r "$icon_path" ]; then
        icon_val="$icon_path"
    fi

    write_desktop_file() {
        echo "[Desktop Entry]"
        echo "Version=1.0"
        echo "Type=Application"
        echo "Name=WatsUp Streamer"
        echo "Comment=Zero-Browser WhatsApp Streamer for Heavy Files"
        echo "Exec=bash \"$APP_DIR/launch.sh\""
        echo "Icon=$icon_val"
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
    local log_file="${WATSUP_LOG_PATH:-engine.log}"

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
        if ! rotate_engine_log; then
            echo "⚠️ Warning: Log rotation failed; continuing by appending to the original engine.log."
        fi

        echo "⚡ Starting background Node.js WhatsApp Engine..."
        node "$ENGINE_PATH" >> "$log_file" 2>&1 &
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
        tail -n 30 -f "$log_file" &
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
