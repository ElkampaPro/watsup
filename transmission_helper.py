import os
import time
from typing import List, NamedTuple, Optional

class TransmissionResult(NamedTuple):
    total_count: int
    success_count: int
    succeeded_paths: List[str]
    failed_paths: List[str]
    aborted: bool
    fatal_error: Optional[str]
    final_message: str

def is_fatal_response(res: dict) -> bool:
    if not isinstance(res, dict):
        return False
    if res.get("offline_flag") is True:
        return True
    if res.get("status_code") == 401:
        return True
    error_msg = str(res.get("error", "")).lower()
    if "unauthorized" in error_msg:
        return True
    if "disconnected" in error_msg:
        return True
    return False

def run_transmission_loop(
    files_to_send: List[str],
    target_jid: str,
    make_request_fn,
    split_fn,
    log_fn,
    cleanup_fn,
    sleep_fn=time.sleep
) -> TransmissionResult:
    files_to_process = list(files_to_send)
    total_files = len(files_to_process)
    
    log_fn(f"Starting sequential transmission of {total_files} files...")
    
    success_count = 0
    succeeded_paths = []
    failed_paths = []
    aborted = False
    fatal_error = None
    
    for index, filePath in enumerate(files_to_process):
        if not os.path.exists(filePath):
            log_fn(f"File not found: {filePath}. Skipping...")
            failed_paths.append(filePath)
            continue
            
        fileName = os.path.basename(filePath)
        file_num_str = f"({index + 1}/{total_files})"
        
        paths_to_send = [filePath]
        is_split = False
        temp_dir = None
        split_success = True
        
        try:
            try:
                split_res = split_fn(filePath)
                paths_to_send = split_res.paths
                is_split = split_res.is_split
                temp_dir = split_res.temp_dir
            except Exception as e:
                log_fn(f"Skipping '{fileName}' due to splitting failure: {str(e)}")
                split_success = False
                failed_paths.append(filePath)
                continue
                
            for part_idx, path in enumerate(paths_to_send):
                partName = os.path.basename(path)
                if is_split:
                    part_str = f" [Part {part_idx + 1}/{len(paths_to_send)}]"
                    log_fn(f"Streaming file {index + 1} of {total_files}{part_str}: {partName}...")
                else:
                    log_fn(f"Streaming file {index + 1} of {total_files}: {fileName}...")
                    
                if part_idx > 0:
                    sleep_fn(3)
                    
                payload = {
                    "filePath": path,
                    "recipient": target_jid
                }
                
                t_start = time.time()
                t_start_str = time.strftime("%H:%M:%S", time.localtime(t_start))
                log_fn(f"-> Starting transmission of '{partName}' at {t_start_str}...")
                
                res = None
                try:
                    res = make_request_fn("/api/send", data=payload, timeout=1800)
                except Exception as e:
                    t_end = time.time()
                    t_end_str = time.strftime("%H:%M:%S", time.localtime(t_end))
                    duration = t_end - t_start
                    log_fn(f"❌ Failed to send '{partName}' (Failed at {t_end_str} after {duration:.1f}s) due to exception: {str(e)}")
                    split_success = False
                    aborted = True
                    fatal_error = f"Worker exception: {str(e)}"
                    break
                    
                t_end = time.time()
                t_end_str = time.strftime("%H:%M:%S", time.localtime(t_end))
                duration = t_end - t_start
                
                if not res.get("success", False):
                    error_msg = res.get("error", "Unknown transmission error")
                    log_fn(f"❌ Failed to send '{partName}' (Failed at {t_end_str} after {duration:.1f}s). Error: {error_msg}")
                    split_success = False
                    if is_fatal_response(res):
                        aborted = True
                        fatal_error = error_msg
                    break
                else:
                    log_fn(f"✅ Successfully sent '{partName}' (Completed at {t_end_str} in {duration:.1f}s)")
        finally:
            if is_split:
                log_fn(f"Cleaning up temporary split files for '{fileName}'...")
                for path in paths_to_send:
                    if path != filePath and os.path.exists(path):
                        try:
                            os.remove(path)
                        except Exception:
                            pass
            if temp_dir:
                try:
                    cleanup_fn(temp_dir)
                except Exception as e:
                    log_fn(f"Cleanup failure for {temp_dir}: {str(e)}")
                    
        if split_success:
            success_count += 1
            succeeded_paths.append(filePath)
            log_fn(f"Successfully sent {file_num_str}: {fileName}")
        else:
            if filePath not in failed_paths:
                failed_paths.append(filePath)
            log_fn(f"Failed to send {file_num_str}: {fileName}")
            if aborted:
                log_fn("Fatal communication error encountered. Aborting transmission queue.")
                break
                
        if index < total_files - 1 and not aborted:
            log_fn("Waiting 5 seconds before starting next transfer...")
            sleep_fn(5)
            
    if success_count == total_files:
        final_message = f"All {total_files} files streamed and sent successfully!"
    elif success_count > 0:
        final_message = f"Queue completed with warnings: Sent {success_count} of {total_files} files successfully."
    else:
        final_message = "All file transmissions in the queue failed."
        
    return TransmissionResult(
        total_count=total_files,
        success_count=success_count,
        succeeded_paths=succeeded_paths,
        failed_paths=failed_paths,
        aborted=aborted,
        fatal_error=fatal_error,
        final_message=final_message
    )
