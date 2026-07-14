import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import io
import json
import os
import shutil
import tempfile
import sys

# Ensure d:\watsup is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ui import WatsUpUI

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

if __name__ == '__main__':
    unittest.main()
