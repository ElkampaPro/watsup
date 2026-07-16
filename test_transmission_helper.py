import unittest
from unittest.mock import MagicMock, patch
import os
import shutil
import tempfile
import sys
import subprocess
import transmission_helper

class TestTransmissionHelper(unittest.TestCase):
    def test_is_fatal_response(self):
        self.assertTrue(transmission_helper.is_fatal_response({"offline_flag": True}))
        self.assertTrue(transmission_helper.is_fatal_response({"status_code": 401}))
        self.assertTrue(transmission_helper.is_fatal_response({"error": "Unauthorized Access"}))
        self.assertTrue(transmission_helper.is_fatal_response({"error": "WhatsApp engine disconnected"}))
        self.assertFalse(transmission_helper.is_fatal_response({"success": False, "error": "timeout"}))
        self.assertFalse(transmission_helper.is_fatal_response({}))

    def test_run_transmission_loop_happy_path(self):
        temp_dir = tempfile.mkdtemp()
        try:
            files = [
                os.path.join(temp_dir, "f1.txt"),
                os.path.join(temp_dir, "f2.txt")
            ]
            for f in files:
                with open(f, "wb") as out:
                    out.write(b"content")

            log_msgs = []
            log_fn = lambda m: log_msgs.append(m)

            from file_splitter import SplitResult
            split_fn = MagicMock(return_value=SplitResult(paths=[files[0]], is_split=False, temp_dir=None))

            make_request = MagicMock(return_value={"success": True})
            cleanup_fn = MagicMock(return_value=True)
            sleep_fn = MagicMock()

            split_fn.side_effect = [
                SplitResult(paths=[files[0]], is_split=False, temp_dir=None),
                SplitResult(paths=[files[1]], is_split=False, temp_dir=None)
            ]

            res = transmission_helper.run_transmission_loop(
                files_to_send=files,
                target_jid="123@s.whatsapp.net",
                make_request_fn=make_request,
                split_fn=split_fn,
                log_fn=log_fn,
                cleanup_fn=cleanup_fn,
                sleep_fn=sleep_fn
            )

            self.assertEqual(res.total_count, 2)
            self.assertEqual(res.success_count, 2)
            self.assertEqual(res.succeeded_paths, files)
            self.assertEqual(res.failed_paths, [])
            self.assertFalse(res.aborted)
            self.assertIsNone(res.fatal_error)
            sleep_fn.assert_called_once_with(5)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_run_transmission_loop_fatal_abort(self):
        temp_dir = tempfile.mkdtemp()
        try:
            files = [
                os.path.join(temp_dir, "f1.txt"),
                os.path.join(temp_dir, "f2.txt")
            ]
            for f in files:
                with open(f, "wb") as out:
                    out.write(b"content")

            log_msgs = []
            log_fn = lambda m: log_msgs.append(m)

            from file_splitter import SplitResult
            split_fn = MagicMock(side_effect=[
                SplitResult(paths=[files[0]], is_split=False, temp_dir=None),
                SplitResult(paths=[files[1]], is_split=False, temp_dir=None)
            ])

            make_request = MagicMock(return_value={"success": False, "status_code": 401, "error": "Unauthorized"})
            cleanup_fn = MagicMock(return_value=True)
            sleep_fn = MagicMock()

            res = transmission_helper.run_transmission_loop(
                files_to_send=files,
                target_jid="123@s.whatsapp.net",
                make_request_fn=make_request,
                split_fn=split_fn,
                log_fn=log_fn,
                cleanup_fn=cleanup_fn,
                sleep_fn=sleep_fn
            )

            self.assertEqual(res.total_count, 2)
            self.assertEqual(res.success_count, 0)
            self.assertEqual(res.succeeded_paths, [])
            self.assertEqual(res.failed_paths, [files[0]])
            self.assertTrue(res.aborted)
            self.assertEqual(res.fatal_error, "Unauthorized")
            sleep_fn.assert_not_called()
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_run_transmission_loop_generic_exception(self):
        temp_dir = tempfile.mkdtemp()
        try:
            files = [
                os.path.join(temp_dir, "f1.txt"),
                os.path.join(temp_dir, "f2.txt"),
                os.path.join(temp_dir, "f3.txt")
            ]
            for f in files:
                with open(f, "wb") as out:
                    out.write(b"content")

            log_msgs = []
            log_fn = lambda m: log_msgs.append(m)

            from file_splitter import SplitResult
            split_fn = MagicMock(side_effect=[
                SplitResult(paths=[files[0]], is_split=False, temp_dir=None),
                SplitResult(paths=[files[1]], is_split=False, temp_dir=None),
                SplitResult(paths=[files[2]], is_split=False, temp_dir=None)
            ])

            def mock_request(path, data, timeout):
                if "f1.txt" in data["filePath"]:
                    return {"success": True}
                elif "f2.txt" in data["filePath"]:
                    raise RuntimeError("Socket timeout")
                return {"success": True}

            make_request = MagicMock(side_effect=mock_request)
            cleanup_fn = MagicMock(return_value=True)
            sleep_fn = MagicMock()

            res = transmission_helper.run_transmission_loop(
                files_to_send=files,
                target_jid="123@s.whatsapp.net",
                make_request_fn=make_request,
                split_fn=split_fn,
                log_fn=log_fn,
                cleanup_fn=cleanup_fn,
                sleep_fn=sleep_fn
            )

            self.assertEqual(res.total_count, 3)
            self.assertEqual(res.success_count, 1)
            self.assertEqual(res.succeeded_paths, [files[0]])
            self.assertTrue(res.aborted)
            self.assertEqual(res.fatal_error, "Worker exception: Socket timeout")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_run_transmission_loop_victim_preservation(self):
        temp_dir = tempfile.mkdtemp()
        try:
            victim_file = os.path.join(temp_dir, "victim.txt")
            with open(victim_file, "wb") as f:
                f.write(b"victim_data")

            log_msgs = []
            log_fn = lambda m: log_msgs.append(m)

            from file_splitter import SplitResult
            split_fn = MagicMock(return_value=SplitResult(paths=[victim_file], is_split=True, temp_dir=None))

            make_request = MagicMock(return_value={"success": True})
            cleanup_fn = MagicMock(return_value=True)
            sleep_fn = MagicMock()

            res = transmission_helper.run_transmission_loop(
                files_to_send=[victim_file],
                target_jid="123@s.whatsapp.net",
                make_request_fn=make_request,
                split_fn=split_fn,
                log_fn=log_fn,
                cleanup_fn=cleanup_fn,
                sleep_fn=sleep_fn
            )

            self.assertEqual(res.success_count, 1)
            # Verify victim file is NOT deleted!
            self.assertTrue(os.path.exists(victim_file))
            cleanup_fn.assert_not_called()
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_run_transmission_loop_cleanup_failure_logged(self):
        temp_dir = tempfile.mkdtemp()
        try:
            test_file = os.path.join(temp_dir, "f1.txt")
            with open(test_file, "wb") as f:
                f.write(b"content")

            log_msgs = []
            log_fn = lambda m: log_msgs.append(m)

            from file_splitter import SplitResult
            split_fn = MagicMock(return_value=SplitResult(paths=[test_file], is_split=True, temp_dir=temp_dir))

            make_request = MagicMock(return_value={"success": True})
            cleanup_fn = MagicMock(return_value=False)
            sleep_fn = MagicMock()

            res = transmission_helper.run_transmission_loop(
                files_to_send=[test_file],
                target_jid="123@s.whatsapp.net",
                make_request_fn=make_request,
                split_fn=split_fn,
                log_fn=log_fn,
                cleanup_fn=cleanup_fn,
                sleep_fn=sleep_fn
            )

            self.assertEqual(res.success_count, 1)
            cleanup_fn.assert_called_once_with(temp_dir)
            # Verify that cleanup failure was logged
            logged_failures = [m for m in log_msgs if f"Cleanup failure for {temp_dir}" in m]
            self.assertTrue(len(logged_failures) > 0)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_import_safety(self):
        temp_dir = tempfile.mkdtemp()
        try:
            script_path = os.path.join(temp_dir, "verify_import.py")
            transmission_helper_abs = os.path.abspath("transmission_helper.py")

            script_code = f"""
import sys
import os
import importlib.util

spec = importlib.util.spec_from_file_location("transmission_helper", r"{transmission_helper_abs}")
module = importlib.util.module_from_spec(spec)
sys.modules["transmission_helper"] = module
spec.loader.exec_module(module)

assert "tkinter" not in sys.modules, "Tkinter was imported"
assert not [f for f in os.listdir(".") if f != "verify_import.py"], "Files created in CWD"
print("ok")
"""
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script_code)

            out = subprocess.check_output([sys.executable, script_path], cwd=temp_dir, text=True).strip()
            self.assertEqual(out, "ok")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == '__main__':
    unittest.main()
