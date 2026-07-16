import os
import shutil
import tempfile
import subprocess
import math
import re
from typing import List, NamedTuple, Optional

class SplitResult(NamedTuple):
    paths: List[str]
    is_split: bool
    temp_dir: Optional[str]

def format_bytes(bytes_val: int) -> str:
    if bytes_val == 0:
        return "0 Bytes"
    sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    import math
    i = int(math.floor(math.log(bytes_val) / math.log(1024)))
    return f"{round(bytes_val / math.pow(1024, i), 2)} {sizes[i]}"

def create_manifest_file(original_path: str, part_paths: List[str], temp_dir: str, is_rar: bool, format_bytes_fn, log_fn) -> None:
    try:
        manifest_path = os.path.join(temp_dir, "manifest.txt")
        orig_name = os.path.basename(original_path)
        orig_size = os.path.getsize(original_path)

        with open(manifest_path, "w", encoding="utf-8") as f:
            f.write(f"Original File: {orig_name}\n")
            f.write(f"Total Size: {orig_size} bytes ({format_bytes_fn(orig_size)})\n")
            f.write(f"Number of Parts: {len(part_paths)}\n")
            f.write(f"Type: {'RAR Volume Set (Compressed/Stored)' if is_rar else 'Raw Binary Chunks'}\n\n")
            f.write("Parts List:\n")
            for idx, p in enumerate(part_paths):
                f.write(f"  {idx+1}. {os.path.basename(p)} ({format_bytes_fn(os.path.getsize(p))})\n")

            f.write("\nHow to merge and restore the original file:\n")
            if is_rar:
                f.write("  Use WinRAR, unrar, or 7-Zip to extract the first part (*.part1.rar or *.part01.rar) to reconstruct the file automatically.\n")
            else:
                f.write("  Combine the parts sequentially using command line tools:\n")
                f.write("  - Windows Command Prompt:\n")
                parts_cmd_win = " + ".join([os.path.basename(p) for p in part_paths])
                f.write(f"    copy /b {parts_cmd_win} \"{orig_name}\"\n")
                f.write("  - Linux/macOS Terminal:\n")
                parts_cmd_nix = " ".join([os.path.basename(p) for p in part_paths])
                f.write(f"    cat {parts_cmd_nix} > \"{orig_name}\"\n")
        log_fn(f"Created manifest instructions: {os.path.basename(manifest_path)}")
    except Exception as e:
        log_fn(f"Failed to create manifest file: {str(e)}")

def _purge_rar_fragments(temp_dir: str, log_fn) -> None:
    if not temp_dir or not os.path.exists(temp_dir):
        return
    for f in os.listdir(temp_dir):
        if f.endswith(".rar"):
            p = os.path.join(temp_dir, f)
            try:
                os.remove(p)
                log_fn(f"Purged partial RAR volume: {f}")
            except Exception as e:
                log_fn(f"Failed to purge partial RAR volume {f}: {str(e)}")

def safe_cleanup_temp_dir(temp_dir: str, temp_root: str, log_fn) -> bool:
    if not temp_dir:
        log_fn("Cleanup skipped: temp_dir path is empty or None")
        return False
    try:
        abs_temp = os.path.realpath(temp_dir)
        abs_root = os.path.realpath(temp_root)
        
        if abs_temp == abs_root:
            log_fn("Cleanup rejected: temp_dir matches temp_root")
            return False
        
        if abs_temp in ("/", "\\") or os.path.dirname(abs_temp) == abs_temp:
            log_fn("Cleanup rejected: temp_dir matches root folder")
            return False
            
        if not abs_temp.startswith(abs_root + os.sep):
            log_fn("Cleanup rejected: temp_dir is not a strict child of temp_root (path escape detected)")
            return False
            
        is_correct_name = os.path.basename(abs_temp).startswith("watsup_temp_split_")
        if not is_correct_name:
            log_fn("Cleanup rejected: temp_dir name pattern invalid")
            return False
            
        if os.path.exists(abs_temp):
            shutil.rmtree(abs_temp)
            log_fn(f"🧹 Cleaned up temporary split directory: {os.path.basename(abs_temp)}")
            return True
        return False
    except Exception as e:
        log_fn(f"Cleanup warning: {str(e)}")
        return False

def split_large_file(
    filePath: str,
    temp_root: str,
    log_fn,
    max_split_size: int = 1950 * 1024 * 1024
) -> SplitResult:
    file_size = os.path.getsize(filePath)
    if file_size <= max_split_size:
        return SplitResult(paths=[filePath], is_split=False, temp_dir=None)

    num_parts = math.ceil(file_size / max_split_size)
    part_size_bytes = math.ceil(file_size / num_parts)
    part_size_mb = math.ceil(part_size_bytes / (1024 * 1024))
    file_name = os.path.basename(filePath)
    
    abs_root = os.path.realpath(temp_root)
    temp_dir = tempfile.mkdtemp(prefix="watsup_temp_split_", dir=abs_root)
    abs_temp = os.path.realpath(temp_dir)
    if not abs_temp.startswith(abs_root + os.sep):
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise ValueError("Created temp directory is not a strict child of temp_root")

    log_fn(f"⚠️ [Large File Detected] Natively splitting '{file_name}' ({format_bytes(file_size)}) into {num_parts} equally-sized parts (~{format_bytes(part_size_bytes)} each). Please wait, zero-CPU / zero-RAM active...")

    timeout = max(300, int(file_size / (10 * 1024 * 1024)))
    rar_bin = shutil.which("rar")
    is_rar = bool(rar_bin)

    if is_rar:
        log_fn(f"Using system RAR utility for authentic split RAR volumes (-m0 zero-compression)...")
        archive_base = os.path.join(temp_dir, file_name)
        cmd = [rar_bin, "a", "-m0", f"-v{part_size_mb}m", "-y", archive_base, filePath]
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=timeout)

            def natural_sort_key(s):
                return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

            part_paths = []
            for f in sorted(os.listdir(temp_dir), key=natural_sort_key):
                if f.startswith(file_name) and f.endswith(".rar"):
                    part_paths.append(os.path.join(temp_dir, f))

            if part_paths:
                create_manifest_file(filePath, part_paths, temp_dir, is_rar=True, format_bytes_fn=format_bytes, log_fn=log_fn)
                manifest_path = os.path.join(temp_dir, "manifest.txt")
                if os.path.exists(manifest_path):
                    part_paths.append(manifest_path)
                return SplitResult(paths=part_paths, is_split=True, temp_dir=temp_dir)
        except subprocess.TimeoutExpired:
            log_fn(f"System RAR command timed out after {timeout} seconds. Cleaning up partial RAR volumes...")
            _purge_rar_fragments(temp_dir, log_fn)
        except Exception as e:
            log_fn(f"System RAR command failed: {str(e)}. Cleaning up partial RAR volumes...")
            _purge_rar_fragments(temp_dir, log_fn)

    part_paths = []
    part_num = 1
    buffer_size = 10 * 1024 * 1024

    try:
        with open(filePath, 'rb') as f:
            while True:
                part_name = f"{file_name}.part{part_num:03d}"
                part_path = os.path.join(temp_dir, part_name)

                bytes_written = 0
                with open(part_path, 'wb') as out_f:
                    while bytes_written < part_size_bytes:
                        read_len = min(buffer_size, part_size_bytes - bytes_written)
                        chunk = f.read(read_len)
                        if not chunk:
                            break
                        out_f.write(chunk)
                        bytes_written += len(chunk)

                if bytes_written == 0:
                    if os.path.exists(part_path):
                        os.remove(part_path)
                    break

                part_paths.append(part_path)
                log_fn(f"Created raw part {part_num}: {part_name} ({format_bytes(bytes_written)})")
                part_num += 1

        log_fn("ℹ️ [Notice] Created raw binary parts (not RAR archives). These files must be combined sequentially to restore the original file.")
        create_manifest_file(filePath, part_paths, temp_dir, is_rar=False, format_bytes_fn=format_bytes, log_fn=log_fn)
        manifest_path = os.path.join(temp_dir, "manifest.txt")
        if os.path.exists(manifest_path):
            part_paths.append(manifest_path)
        return SplitResult(paths=part_paths, is_split=True, temp_dir=temp_dir)
    except Exception as e:
        log_fn(f"Error splitting file '{file_name}': {str(e)}")
        for p in part_paths:
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
        safe_cleanup_temp_dir(temp_dir, temp_root, log_fn)
        raise e
