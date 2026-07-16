import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import io
import json
import os
import shutil
import tempfile
import sys
import tkinter as tk

# Ensure d:\watsup is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ui import WatsUpUI
import api_client

class DummyTk:
    def __init__(self):
        self.title_val = ""
    def title(self, val):
        self.title_val = val
    def geometry(self, val):
        pass
    def resizable(self, w, h):
        pass
    def configure(self, **kwargs):
        pass
    def after(self, ms, func, *args):
        # execute immediately in test
        func(*args)
    def drop_target_register(self, dnd_type):
        pass
    def dnd_bind(self, event, func):
        pass

class TestWatsUpUI(unittest.TestCase):
    def setUp(self):
        self.root = DummyTk()
        # Patch methods to avoid Tkinter GUI creation and widget modification in headless environment
        with patch.object(WatsUpUI, 'setup_styles'), \
             patch.object(WatsUpUI, 'create_widgets'), \
             patch.object(WatsUpUI, 'start_background_polling'), \
             patch.object(WatsUpUI, 'log_message'):
            self.ui = WatsUpUI(self.root)
        # Mock log_message and GUI transition methods on the instance for testing
        self.ui.log_message = MagicMock()
        self.ui.refresh_queue_table = MagicMock()
        self.ui.post_transmission_ui = MagicMock()
        self.ui.show_splitting_banner = MagicMock()
        self.ui.hide_splitting_banner = MagicMock()

    def test_recipient_jid_resolution(self):
        # 1. Recipient from contacts data
        self.ui.contacts_data = {"👤 Alice (+123)": "123@s.whatsapp.net"}
        self.ui.selected_files = ["/path/to/somefile.txt"]

        # Test Alice resolution
        self.ui.make_api_request = MagicMock(return_value={"success": True})
        self.ui.split_large_file = MagicMock(return_value=(["/path/to/somefile.txt"], False))

        with patch('os.path.exists', return_value=True):
            self.ui.transmission_worker("👤 Alice (+123)")

            # Ensure recipient parameter passed to api is alice JID
            self.ui.make_api_request.assert_called_once()
            called_args = self.ui.make_api_request.call_args[0]
            called_kwargs = self.ui.make_api_request.call_args[1]
            self.assertEqual(called_args[0], "/api/send")
            self.assertEqual(called_kwargs['data']['recipient'], "123@s.whatsapp.net")

            # 2. Manual Entry
            self.ui.make_api_request.reset_mock()
            self.ui.selected_files = ["/path/to/somefile.txt"]
            self.ui.transmission_worker("Manual Entry: +987654321")
            self.assertEqual(self.ui.make_api_request.call_args[1]['data']['recipient'], "987654321@s.whatsapp.net")

    def test_http_error_parsing(self):
        # Test that make_api_request parses JSON from HTTPError and adds status_code
        err_json = {"success": False, "error": "Another send is in progress"}
        err_stream = io.BytesIO(json.dumps(err_json).encode('utf-8'))

        try:
            # Raise HTTPError
            mock_err = urllib.error.HTTPError(
                url="http://127.0.0.1:5001/api/send",
                code=409,
                msg="Conflict",
                hdrs={},
                fp=err_stream
            )

            with patch('urllib.request.urlopen', side_effect=mock_err):
                res = self.ui.make_api_request("/api/send", data={"filePath": "dummy.txt"})

                # Assertions
                self.assertEqual(res.get("success"), False)
                self.assertEqual(res.get("error"), "Another send is in progress")
                self.assertEqual(res.get("status_code"), 409)
                self.assertTrue(err_stream.closed)
        finally:
            err_stream.close()

    def test_raw_splitting_naming(self):
        # Verify that fallback splitter creates files named part001, part002 (no .rar suffix) and appends manifest
        temp_test_dir = tempfile.mkdtemp()
        dummy_file = os.path.join(temp_test_dir, "large_video.mp4")

        # Create a 25 MB dummy file
        with open(dummy_file, 'wb') as f:
            f.write(os.urandom(25 * 1024 * 1024)) # 25 MB

        try:
            # Set the split limit to 10 MB temporarily to force splitting
            self.ui.max_split_size = 10 * 1024 * 1024

            with patch('shutil.which', return_value=None): # Force native fallback by hiding rar
                part_paths, is_split = self.ui.split_large_file(dummy_file)

                self.assertTrue(is_split)
                # Since manifest.txt is appended to part_paths, len(part_paths) should be 4 (3 parts + manifest)
                self.assertEqual(len(part_paths), 4)

                # Check that manifest.txt is the last file
                self.assertEqual(os.path.basename(part_paths[-1]), "manifest.txt")

                # Verify naming conventions (no .rar suffix on raw part files)
                for idx, path in enumerate(part_paths[:-1]):
                    expected_name = f"large_video.mp4.part{idx+1:03d}"
                    self.assertEqual(os.path.basename(path), expected_name)
                    self.assertFalse(path.endswith('.rar'))

                    # Clean up the generated temp split files
                    if os.path.exists(path):
                        os.remove(path)

                # Clean up manifest.txt
                if os.path.exists(part_paths[-1]):
                    os.remove(part_paths[-1])

                # Clean up temp split directory
                parent_temp_dir = os.path.dirname(part_paths[0])
                if os.path.exists(parent_temp_dir):
                    shutil.rmtree(parent_temp_dir)
        finally:
            shutil.rmtree(temp_test_dir)

    def test_queue_preservation_on_partial_failure(self):
        # Setup files queue with three files
        self.ui.selected_files = ["/path/to/file1.txt", "/path/to/file2.txt", "/path/to/file3.txt"]
        self.ui.contacts_data = {"👤 Alice": "123@s.whatsapp.net"}

        # Mock split_large_file to skip splitting
        self.ui.split_large_file = MagicMock(side_effect=lambda f: ([f], False))

        # Mock api request to fail on file2 (non-fatal error)
        def mock_request(path, data=None, timeout=8):
            if data and "file2.txt" in data["filePath"]:
                return {"success": False, "error": "Transmission failed for file2"}
            return {"success": True}

        self.ui.make_api_request = MagicMock(side_effect=mock_request)

        # Execute transmission_worker
        with patch('os.path.exists', return_value=True):
            self.ui.transmission_worker("👤 Alice")

            # File1 succeeded, File2 failed (non-fatal), File3 succeeded
            # Check that only File 2 remains in the queue!
            self.assertEqual(self.ui.selected_files, ["/path/to/file2.txt"])
            # verify post_transmission_ui called with success=False
            self.ui.post_transmission_ui.assert_called_with(False, "Queue completed with warnings: Sent 2 of 3 files successfully.")

    def test_queue_abort_on_fatal_disconnect(self):
        # Setup files queue with three files
        self.ui.selected_files = ["/path/to/file1.txt", "/path/to/file2.txt", "/path/to/file3.txt"]
        self.ui.contacts_data = {"👤 Alice": "123@s.whatsapp.net"}

        self.ui.split_large_file = MagicMock(side_effect=lambda f: ([f], False))

        # Mock api request to return fatal WhatsApp engine disconnected error on file1
        def mock_request(path, data=None, timeout=8):
            if data and "file1.txt" in data["filePath"]:
                return {"success": False, "error": "WhatsApp engine disconnected"}
            return {"success": True}

        self.ui.make_api_request = MagicMock(side_effect=mock_request)

        with patch('os.path.exists', return_value=True):
            self.ui.transmission_worker("👤 Alice")

            # Since the first file returns a fatal error, the queue must abort immediately.
            # No other files should be processed, so all three remain in the queue.
            self.assertEqual(self.ui.selected_files, ["/path/to/file1.txt", "/path/to/file2.txt", "/path/to/file3.txt"])
            self.ui.post_transmission_ui.assert_called_with(False, "All file transmissions in the queue failed.")

    def test_split_exception_temp_dir_cleanup(self):
        temp_test_dir = tempfile.mkdtemp()
        dummy_file = os.path.join(temp_test_dir, "large_video.mp4")

        with open(dummy_file, 'wb') as f:
            f.write(os.urandom(25 * 1024 * 1024)) # 25 MB

        try:
            self.ui.max_split_size = 10 * 1024 * 1024

            # Patch write mode to throw exception when writing part files
            original_open = open
            def mock_open(file, mode='r', *args, **kwargs):
                if 'w' in mode and "watsup_temp_split_" in file:
                    raise IOError("Mock disk write failure")
                return original_open(file, mode, *args, **kwargs)

            with patch('shutil.which', return_value=None), \
                 patch('builtins.open', side_effect=mock_open):

                with self.assertRaises(IOError):
                    self.ui.split_large_file(dummy_file)

                # Assert that the temporary split directory was deleted successfully
                if self.ui.current_temp_dir:
                    self.assertFalse(os.path.exists(self.ui.current_temp_dir))
        finally:
            shutil.rmtree(temp_test_dir)

    def test_shutdown_idempotency(self):
        # Verify that shutdown can be called multiple times without exceptions
        mock_root = MagicMock()
        with patch.object(WatsUpUI, 'setup_styles'), \
             patch.object(WatsUpUI, 'create_widgets'), \
             patch.object(WatsUpUI, 'start_background_polling'), \
             patch.object(WatsUpUI, 'log_message'):
            ui = WatsUpUI(mock_root)

        self.assertFalse(ui.shutdown_started)
        ui.shutdown()
        self.assertTrue(ui.shutdown_started)
        self.assertFalse(ui.polling_active)
        mock_root.destroy.assert_called_once()

        # Call again: should not throw error or call destroy again
        ui.shutdown()
        self.assertTrue(ui.shutdown_started)
        mock_root.destroy.assert_called_once()

    def test_safe_after_scheduling(self):
        # Verify safe_after respects polling_active and shutdown_started flags
        mock_root = MagicMock()
        with patch.object(WatsUpUI, 'setup_styles'), \
             patch.object(WatsUpUI, 'create_widgets'), \
             patch.object(WatsUpUI, 'start_background_polling'), \
             patch.object(WatsUpUI, 'log_message'):
            ui = WatsUpUI(mock_root)

        # 1. Normal state
        ui.polling_active = True
        ui.shutdown_started = False
        ui.safe_after(100, lambda: None)
        mock_root.after.assert_called_once()

        # 2. After shutdown starts
        mock_root.after.reset_mock()
        ui.shutdown_started = True
        res = ui.safe_after(100, lambda: None)
        self.assertIsNone(res)
        mock_root.after.assert_not_called()

        # 3. TclError safety handler
        ui.shutdown_started = False
        import _tkinter
        mock_root.after.side_effect = _tkinter.TclError("invalid command")
        res2 = ui.safe_after(100, lambda: None)
        self.assertIsNone(res2)

    def test_icon_loading_logic(self):
        # We simulate the main block's icon loading logic on a mocked root window
        mock_root = MagicMock()
        mock_photo_image = MagicMock()

        with patch('os.path.exists', return_value=True), \
             patch('tkinter.PhotoImage', return_value=mock_photo_image) as mock_photo_class:

            # The logic that is executed in main:
            icon_path = "watsup.png"
            if os.path.exists(icon_path):
                try:
                    icon_img = tk.PhotoImage(file=icon_path)
                    mock_root._watsup_icon = icon_img
                    mock_root.iconphoto(True, icon_img)
                except Exception:
                    pass

            # Assertions
            mock_photo_class.assert_called_once_with(file=icon_path)
            self.assertEqual(mock_root._watsup_icon, mock_photo_image)
            mock_root.iconphoto.assert_called_once_with(True, mock_photo_image)

class TestApiClient(unittest.TestCase):
    def test_import_safety(self):
        # Verify that importing api_client has no side effects (no Tkinter, no network, etc.)
        import subprocess

        # We will write the verification code to a script and run it in a clean child process
        # set its CWD to a temp directory
        temp_dir = tempfile.mkdtemp()
        try:
            script_path = os.path.join(temp_dir, "verify_import.py")
            # Get absolute path of api_client.py
            api_client_abs = os.path.abspath("api_client.py")

            script_code = f"""
import sys
import os
import importlib.util
import socket
import urllib.request
import threading
import signal
import builtins

urlopen_called = False
connect_called = False
thread_start_called = False
files_written = []

# Mock urllib urlopen
orig_urlopen = urllib.request.urlopen
def mock_urlopen(*args, **kwargs):
    global urlopen_called
    urlopen_called = True
    raise RuntimeError("urlopen called")
urllib.request.urlopen = mock_urlopen

# Mock socket connect
orig_connect = socket.socket.connect
def mock_connect(*args, **kwargs):
    global connect_called
    connect_called = True
    raise RuntimeError("socket.connect called")
socket.socket.connect = mock_connect

# Mock socket create_connection
orig_create_connection = socket.create_connection
def mock_create_connection(*args, **kwargs):
    global connect_called
    connect_called = True
    raise RuntimeError("socket.create_connection called")
socket.create_connection = mock_create_connection

# Mock threading Thread.start
orig_thread_start = threading.Thread.start
def mock_thread_start(*args, **kwargs):
    global thread_start_called
    thread_start_called = True
    raise RuntimeError("Thread.start called")
threading.Thread.start = mock_thread_start

# Hook builtins.open to fail on write modes
orig_open = builtins.open
def mock_open(file, mode="r", *args, **kwargs):
    if any(char in mode for char in ("w", "a", "x", "+")):
        files_written.append((file, mode))
        raise IOError("Write mode forbidden during import")
    return orig_open(file, mode, *args, **kwargs)
builtins.open = mock_open

# Save signal handlers before import
orig_sigint = signal.getsignal(signal.SIGINT)
orig_sigterm = signal.getsignal(signal.SIGTERM)

# Active threads count
threads_before = threading.active_count()

# Perform absolute path fresh import
spec = importlib.util.spec_from_file_location("api_client", r"{api_client_abs}")
module = importlib.util.module_from_spec(spec)
sys.modules["api_client"] = module
spec.loader.exec_module(module)

# Assertions
assert "tkinter" not in sys.modules, "Tkinter was imported"
assert not urlopen_called, "urllib.request.urlopen was called"
assert not connect_called, "socket connection was attempted"
assert not thread_start_called, "thread start was called"
assert threading.active_count() == threads_before, "new threads were created"
assert signal.getsignal(signal.SIGINT) == orig_sigint, "SIGINT handler modified"
assert signal.getsignal(signal.SIGTERM) == orig_sigterm, "SIGTERM handler modified"
assert not files_written, f"files written: {{files_written}}"
assert not [f for f in os.listdir(".") if f != "verify_import.py"], f"files created in cwd: {{[f for f in os.listdir('.') if f != 'verify_import.py']}}"

print("ok")
"""
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script_code)

            output = subprocess.check_output(
                [sys.executable, script_path],
                cwd=temp_dir,
                text=True
            ).strip()
            self.assertEqual(output, "ok")
        finally:
            shutil.rmtree(temp_dir)

    def test_token_loading(self):
        import contextlib
        import io

        temp_dir = tempfile.mkdtemp()
        try:
            token_path = os.path.join(temp_dir, ".watsup_ipc_token")
            token_val = "my_secret_token_123"
            with open(token_path, "w", encoding="utf-8") as f:
                f.write(f"  {token_val}  \n")

            # Redirect stdout and stderr to verify no token leaks
            f_out = io.StringIO()
            f_err = io.StringIO()
            with contextlib.redirect_stdout(f_out), contextlib.redirect_stderr(f_err):
                token = api_client.load_ipc_token(token_path)

            self.assertEqual(token, token_val)
            # Ensure no leakage in stdout/stderr
            out_val = f_out.getvalue()
            err_val = f_err.getvalue()
            self.assertNotIn(token_val, out_val)
            self.assertNotIn(token_val, err_val)
            self.assertEqual(out_val, "")
            self.assertEqual(err_val, "")

            # 2. File not found
            self.assertIsNone(api_client.load_ipc_token(os.path.join(temp_dir, "nonexistent")))

            # 3. Read exception
            with patch("builtins.open", side_effect=IOError("Failed to open")):
                self.assertIsNone(api_client.load_ipc_token(token_path))
        finally:
            shutil.rmtree(temp_dir)

    def test_http_success(self):
        mock_opener = MagicMock()
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"success": true, "status": "ok"}'
        mock_response.__enter__.return_value = mock_response
        mock_opener.open.return_value = mock_response

        # 1. Test with default base_url and custom data/token/timeout
        res = api_client.make_api_request(
            "/api/status",
            data={"filePath": "abc.txt"},
            ipc_token="xyz",
            timeout=12,
            opener=mock_opener
        )
        self.assertEqual(res, {"success": True, "status": "ok"})
        mock_opener.open.assert_called_once()
        req = mock_opener.open.call_args[0][0]
        self.assertEqual(req.full_url, "http://127.0.0.1:5001/api/status")
        self.assertEqual(req.headers.get("Content-type"), "application/json")
        self.assertEqual(req.headers.get("X-watsup-token"), "xyz")
        self.assertEqual(req.data, b'{"filePath": "abc.txt"}')
        self.assertEqual(mock_opener.open.call_args[1].get("timeout"), 12)

        # 2. Test with custom base_url
        mock_opener.open.reset_mock()
        res2 = api_client.make_api_request(
            "/api/status",
            base_url="https://custom-domain.com:9000",
            opener=mock_opener
        )
        self.assertEqual(res2, {"success": True, "status": "ok"})
        req2 = mock_opener.open.call_args[0][0]
        self.assertEqual(req2.full_url, "https://custom-domain.com:9000/api/status")

    def test_http_error_json(self):
        mock_opener = MagicMock()
        mock_fp = io.BytesIO(b'{"success": false, "error": "WhatsApp engine disconnected"}')
        # HTTPError params: url, code, msg, hdrs, fp
        mock_opener.open.side_effect = urllib.error.HTTPError(
            "http://127.0.0.1:5001/api/status",
            401,
            "Unauthorized",
            {},
            mock_fp
        )

        res = api_client.make_api_request(
            "/api/status",
            opener=mock_opener
        )
        self.assertEqual(res, {
            "success": False,
            "error": "WhatsApp engine disconnected",
            "status_code": 401
        })
        self.assertTrue(mock_fp.closed)

    def test_http_error_invalid_body(self):
        mock_opener = MagicMock()
        mock_fp = io.BytesIO(b'Internal Server Error')
        mock_opener.open.side_effect = urllib.error.HTTPError(
            "http://127.0.0.1:5001/api/status",
            500,
            "Internal Server Error",
            {},
            mock_fp
        )

        res = api_client.make_api_request(
            "/api/status",
            opener=mock_opener
        )
        self.assertEqual(res, {
            "success": False,
            "status_code": 500,
            "error": "HTTP Error 500: Internal Server Error"
        })
        self.assertTrue(mock_fp.closed)

    def test_url_error(self):
        mock_opener = MagicMock()
        mock_opener.open.side_effect = urllib.error.URLError("Connection refused")

        res = api_client.make_api_request(
            "/api/status",
            opener=mock_opener
        )
        self.assertEqual(res, {
            "offline_flag": True,
            "error": "Connection refused"
        })

    def test_generic_exception(self):
        mock_opener = MagicMock()
        mock_opener.open.side_effect = Exception("Crash")

        res = api_client.make_api_request(
            "/api/status",
            opener=mock_opener
        )
        self.assertEqual(res, {
            "success": False,
            "error": "Crash"
        })
        self.assertNotIn("offline_flag", res)

    def test_compatibility_wrappers(self):
        mock_root = MagicMock()
        with patch.object(WatsUpUI, 'setup_styles'), \
             patch.object(WatsUpUI, 'create_widgets'), \
             patch.object(WatsUpUI, 'start_background_polling'), \
             patch.object(WatsUpUI, 'log_message'):
            ui = WatsUpUI(mock_root)

        with patch("api_client.load_ipc_token", return_value="wrapped_token") as mock_load:
            ui.load_ipc_token()
            self.assertEqual(ui.ipc_token, "wrapped_token")
            mock_load.assert_called_once()

        with patch("api_client.make_api_request", return_value={"ok": True}) as mock_request:
            ui.ipc_token = "some_token"
            res = ui.make_api_request("/test_path", data={"foo": "bar"}, timeout=5)
            self.assertEqual(res, {"ok": True})
            mock_request.assert_called_once_with(
                "/test_path",
                data={"foo": "bar"},
                timeout=5,
                ipc_token="some_token"
            )

class TestCharacterization(unittest.TestCase):
    def setUp(self):
        self.root = DummyTk()
        with patch.object(WatsUpUI, 'setup_styles'), \
             patch.object(WatsUpUI, 'create_widgets'), \
             patch.object(WatsUpUI, 'start_background_polling'), \
             patch.object(WatsUpUI, 'log_message'):
            self.ui = WatsUpUI(self.root)
        self.ui.log_message = MagicMock()
        self.ui.refresh_queue_table = MagicMock()
        self.ui.post_transmission_ui = MagicMock()
        self.ui.show_splitting_banner = MagicMock()
        self.ui.hide_splitting_banner = MagicMock()

    def test_characterization_manifest_rar(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "test_rar.zip")
        with open(orig_file, "wb") as f:
            f.write(b"a" * 100)
        part_paths = [
            os.path.join(temp_dir, "test_rar.zip.part01.rar"),
            os.path.join(temp_dir, "test_rar.zip.part02.rar")
        ]
        for p in part_paths:
            with open(p, "wb") as f:
                f.write(b"b" * 50)
        try:
            self.ui.create_manifest_file(orig_file, part_paths, is_rar=True)
            manifest_path = os.path.join(temp_dir, "manifest.txt")
            self.assertTrue(os.path.exists(manifest_path))
            with open(manifest_path, "r", encoding="utf-8") as f:
                content = f.read()
            expected = (
                "Original File: test_rar.zip\n"
                "Total Size: 100 bytes (100.0 Bytes)\n"
                "Number of Parts: 2\n"
                "Type: RAR Volume Set (Compressed/Stored)\n\n"
                "Parts List:\n"
                "  1. test_rar.zip.part01.rar (50.0 Bytes)\n"
                "  2. test_rar.zip.part02.rar (50.0 Bytes)\n\n"
                "How to merge and restore the original file:\n"
                "  Use WinRAR, unrar, or 7-Zip to extract the first part (*.part1.rar or *.part01.rar) to reconstruct the file automatically.\n"
            )
            self.assertEqual(content, expected)
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_manifest_raw(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "test_raw.zip")
        with open(orig_file, "wb") as f:
            f.write(b"a" * 120)
        part_paths = [
            os.path.join(temp_dir, "test_raw.zip.part001"),
            os.path.join(temp_dir, "test_raw.zip.part002")
        ]
        for p in part_paths:
            with open(p, "wb") as f:
                f.write(b"b" * 60)
        try:
            self.ui.create_manifest_file(orig_file, part_paths, is_rar=False)
            manifest_path = os.path.join(temp_dir, "manifest.txt")
            self.assertTrue(os.path.exists(manifest_path))
            with open(manifest_path, "r", encoding="utf-8") as f:
                content = f.read()
            expected = (
                "Original File: test_raw.zip\n"
                "Total Size: 120 bytes (120.0 Bytes)\n"
                "Number of Parts: 2\n"
                "Type: Raw Binary Chunks\n\n"
                "Parts List:\n"
                "  1. test_raw.zip.part001 (60.0 Bytes)\n"
                "  2. test_raw.zip.part002 (60.0 Bytes)\n\n"
                "How to merge and restore the original file:\n"
                "  Combine the parts sequentially using command line tools:\n"
                "  - Windows Command Prompt:\n"
                "    copy /b test_raw.zip.part001 + test_raw.zip.part002 \"test_raw.zip\"\n"
                "  - Linux/macOS Terminal:\n"
                "    cat test_raw.zip.part001 test_raw.zip.part002 > \"test_raw.zip\"\n"
            )
            self.assertEqual(content, expected)
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_raw_split_naming_sizing(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "test_naming.zip")
        with open(orig_file, "wb") as f:
            f.write(b"a" * 25)
        self.ui.max_split_size = 10
        try:
            with patch('shutil.which', return_value=None):
                part_paths, is_split = self.ui.split_large_file(orig_file)
                self.assertTrue(is_split)
                # 3 parts + manifest = 4 elements
                self.assertEqual(len(part_paths), 4)
                self.assertEqual(os.path.basename(part_paths[-1]), "manifest.txt")
                self.assertEqual(os.path.basename(part_paths[0]), "test_naming.zip.part001")
                self.assertEqual(os.path.basename(part_paths[1]), "test_naming.zip.part002")
                self.assertEqual(os.path.basename(part_paths[2]), "test_naming.zip.part003")
                # sizes: 25 bytes split equally into 3 parts -> math.ceil(25/3) = 9 bytes per part, last part is 7 bytes
                self.assertEqual(os.path.getsize(part_paths[0]), 9)
                self.assertEqual(os.path.getsize(part_paths[1]), 9)
                self.assertEqual(os.path.getsize(part_paths[2]), 7)
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_rar_natural_sorting(self):
        import re
        def natural_sort_key(s):
            return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]
        items = ["file.part10.rar", "file.part2.rar", "file.part1.rar"]
        sorted_items = sorted(items, key=natural_sort_key)
        self.assertEqual(sorted_items, ["file.part1.rar", "file.part2.rar", "file.part10.rar"])

    def test_characterization_rar_fallback_on_timeout(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "test_timeout.zip")
        with open(orig_file, "wb") as f:
            f.write(b"a" * 25)
        self.ui.max_split_size = 10
        try:
            import subprocess
            with patch('shutil.which', return_value="/usr/bin/rar"), \
                 patch('subprocess.run', side_effect=subprocess.TimeoutExpired(cmd=[], timeout=10)):
                part_paths, is_split = self.ui.split_large_file(orig_file)
                self.assertTrue(is_split)
                self.assertEqual(len(part_paths), 4)
                self.assertEqual(os.path.basename(part_paths[-1]), "manifest.txt")
                self.assertEqual(os.path.basename(part_paths[0]), "test_timeout.zip.part001")
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_rar_fallback_on_failure(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "test_fail.zip")
        with open(orig_file, "wb") as f:
            f.write(b"a" * 25)
        self.ui.max_split_size = 10
        try:
            import subprocess
            with patch('shutil.which', return_value="/usr/bin/rar"), \
                 patch('subprocess.run', side_effect=subprocess.CalledProcessError(1, cmd=[])):
                part_paths, is_split = self.ui.split_large_file(orig_file)
                self.assertTrue(is_split)
                self.assertEqual(len(part_paths), 4)
                self.assertEqual(os.path.basename(part_paths[-1]), "manifest.txt")
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_exception_on_write_cleanup(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "test_write_exc.zip")
        with open(orig_file, "wb") as f:
            f.write(b"a" * 25)
        self.ui.max_split_size = 10
        
        original_open = open
        def mock_open(file, mode='r', *args, **kwargs):
            if 'w' in mode and "watsup_temp_split_" in file:
                raise IOError("Write error")
            return original_open(file, mode, *args, **kwargs)

        try:
            with patch('shutil.which', return_value=None), \
                 patch('builtins.open', side_effect=mock_open):
                with self.assertRaises(IOError):
                    self.ui.split_large_file(orig_file)
                if self.ui.current_temp_dir:
                    self.assertFalse(os.path.exists(self.ui.current_temp_dir))
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_original_file_untouched(self):
        temp_dir = tempfile.mkdtemp()
        orig_file = os.path.join(temp_dir, "original.zip")
        orig_data = b"a" * 25
        with open(orig_file, "wb") as f:
            f.write(orig_data)
        self.ui.max_split_size = 10
        try:
            with patch('shutil.which', return_value=None):
                part_paths, is_split = self.ui.split_large_file(orig_file)
                self.assertTrue(is_split)
                self.assertTrue(os.path.exists(orig_file))
                with open(orig_file, "rb") as f:
                    self.assertEqual(f.read(), orig_data)
        finally:
            shutil.rmtree(temp_dir)

    def test_characterization_safe_cleanup_sanitization(self):
        project_dir = os.path.dirname(os.path.abspath(__file__))
        
        with patch('shutil.rmtree') as mock_rmtree:
            self.ui.safe_cleanup_temp_dir("")
            self.ui.safe_cleanup_temp_dir(project_dir)
            self.ui.safe_cleanup_temp_dir(os.path.join(project_dir, "..", "some_sibling"))
            mock_rmtree.assert_not_called()

    def test_characterization_send_exception_queue_preservation(self):
        self.ui.selected_files = ["/path/to/file1.txt", "/path/to/file2.txt", "/path/to/file3.txt"]
        self.ui.contacts_data = {"👤 Alice": "123@s.whatsapp.net"}
        self.ui.split_large_file = MagicMock(side_effect=lambda f: ([f], False))
        
        def mock_request(path, data=None, timeout=8):
            if data and "file1.txt" in data["filePath"]:
                return {"success": True}
            elif data and "file2.txt" in data["filePath"]:
                raise Exception("Network connection lost")
            return {"success": True}
            
        self.ui.make_api_request = MagicMock(side_effect=mock_request)
        
        with patch('os.path.exists', return_value=True):
            self.ui.transmission_worker("👤 Alice")
            self.assertIn("/path/to/file2.txt", self.ui.selected_files)
            self.assertIn("/path/to/file3.txt", self.ui.selected_files)
            self.ui.post_transmission_ui.assert_called_with(False, "Worker exception: Network connection lost")

    def test_characterization_wrapper_signatures(self):
        self.assertTrue(hasattr(self.ui, 'format_bytes'))
        self.assertTrue(hasattr(self.ui, 'create_manifest_file'))
        self.assertTrue(hasattr(self.ui, 'safe_cleanup_temp_dir'))
        self.assertTrue(hasattr(self.ui, 'split_large_file'))
        self.assertTrue(hasattr(self.ui, 'transmission_worker'))

if __name__ == '__main__':
    unittest.main()
