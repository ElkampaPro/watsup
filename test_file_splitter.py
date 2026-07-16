import unittest
from unittest.mock import MagicMock, patch
import os
import shutil
import tempfile
import sys
import subprocess
import file_splitter

class TestFileSplitter(unittest.TestCase):
    def setUp(self):
        self.temp_root = tempfile.mkdtemp()
        self.log_messages = []
        self.log_fn = lambda msg: self.log_messages.append(msg)

    def tearDown(self):
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def test_format_bytes(self):
        self.assertEqual(file_splitter.format_bytes(0), "0 Bytes")
        self.assertEqual(file_splitter.format_bytes(1024), "1.0 KB")
        self.assertEqual(file_splitter.format_bytes(1024 * 1024), "1.0 MB")
        self.assertEqual(file_splitter.format_bytes(1950 * 1024 * 1024), "1.9 GB")

    def test_safe_cleanup_temp_dir_refuses_unsafe_paths(self):
        # Empty path
        self.assertFalse(file_splitter.safe_cleanup_temp_dir("", self.temp_root, self.log_fn))
        # Matches root
        self.assertFalse(file_splitter.safe_cleanup_temp_dir(self.temp_root, self.temp_root, self.log_fn))
        # Roots
        self.assertFalse(file_splitter.safe_cleanup_temp_dir("/", self.temp_root, self.log_fn))
        self.assertFalse(file_splitter.safe_cleanup_temp_dir("C:\\", self.temp_root, self.log_fn))
        # Escaping
        self.assertFalse(file_splitter.safe_cleanup_temp_dir(os.path.join(self.temp_root, "..", "sibling"), self.temp_root, self.log_fn))
        # Invalid pattern
        bad_pattern = os.path.join(self.temp_root, "not_watsup_temp_split_")
        os.makedirs(bad_pattern, exist_ok=True)
        self.assertFalse(file_splitter.safe_cleanup_temp_dir(bad_pattern, self.temp_root, self.log_fn))

    def test_safe_cleanup_temp_dir_deletes_valid_path(self):
        valid_dir = os.path.join(self.temp_root, "watsup_temp_split_test")
        os.makedirs(valid_dir, exist_ok=True)
        self.assertTrue(file_splitter.safe_cleanup_temp_dir(valid_dir, self.temp_root, self.log_fn))
        self.assertFalse(os.path.exists(valid_dir))

    def test_split_large_file_below_limit(self):
        test_file = os.path.join(self.temp_root, "small.txt")
        with open(test_file, "wb") as f:
            f.write(b"hello")
        res = file_splitter.split_large_file(test_file, self.temp_root, self.log_fn, max_split_size=100)
        self.assertEqual(res.paths, [test_file])
        self.assertFalse(res.is_split)
        self.assertIsNone(res.temp_dir)

    def test_split_large_file_raw_fallback(self):
        test_file = os.path.join(self.temp_root, "large.txt")
        with open(test_file, "wb") as f:
            f.write(b"x" * 25)
        # Disable RAR
        with patch('shutil.which', return_value=None):
            res = file_splitter.split_large_file(test_file, self.temp_root, self.log_fn, max_split_size=10)
            self.assertTrue(res.is_split)
            self.assertIsNotNone(res.temp_dir)
            self.assertEqual(len(res.paths), 4) # 3 parts + manifest
            self.assertEqual(os.path.basename(res.paths[-1]), "manifest.txt")
            self.assertEqual(os.path.basename(res.paths[0]), "large.txt.part001")
            
            # verify part sizes (25 split into 3 parts -> math.ceil(25/3) = 9)
            self.assertEqual(os.path.getsize(res.paths[0]), 9)
            self.assertEqual(os.path.getsize(res.paths[1]), 9)
            self.assertEqual(os.path.getsize(res.paths[2]), 7)

    def test_split_large_file_rar_success(self):
        test_file = os.path.join(self.temp_root, "large.txt")
        with open(test_file, "wb") as f:
            f.write(b"x" * 25)
            
        def mock_run(cmd, *args, **kwargs):
            # Create dummy RAR files in target temp dir
            temp_dir = os.path.dirname(cmd[5])
            for i in range(1, 3):
                with open(os.path.join(temp_dir, f"large.txt.part{i:02d}.rar"), "wb") as f_rar:
                    f_rar.write(b"rarpart")
            return MagicMock()

        with patch('shutil.which', return_value="/usr/bin/rar"), \
             patch('subprocess.run', side_effect=mock_run):
            res = file_splitter.split_large_file(test_file, self.temp_root, self.log_fn, max_split_size=10)
            self.assertTrue(res.is_split)
            self.assertEqual(len(res.paths), 3) # 2 parts + manifest
            self.assertEqual(os.path.basename(res.paths[-1]), "manifest.txt")
            self.assertTrue(res.paths[0].endswith(".part01.rar"))

    def test_split_large_file_rar_timeout_fallback(self):
        test_file = os.path.join(self.temp_root, "large.txt")
        with open(test_file, "wb") as f:
            f.write(b"x" * 25)

        with patch('shutil.which', return_value="/usr/bin/rar"), \
             patch('subprocess.run', side_effect=subprocess.TimeoutExpired(cmd=[], timeout=10)):
            res = file_splitter.split_large_file(test_file, self.temp_root, self.log_fn, max_split_size=10)
            # fallback raw split succeeds
            self.assertTrue(res.is_split)
            self.assertEqual(len(res.paths), 4)
            self.assertTrue(res.paths[0].endswith(".part001"))

    def test_import_safety(self):
        # Subprocess fresh import check in a clean temporary CWD
        temp_dir = tempfile.mkdtemp()
        try:
            script_path = os.path.join(temp_dir, "verify_import.py")
            file_splitter_abs = os.path.abspath("file_splitter.py")
            
            script_code = f"""
import sys
import os
import importlib.util

spec = importlib.util.spec_from_file_location("file_splitter", r"{file_splitter_abs}")
module = importlib.util.module_from_spec(spec)
sys.modules["file_splitter"] = module
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
