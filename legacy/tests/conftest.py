"""Isolate tests from the real dev data (library DB, books, covers, audio).

Must run before any `backend` import: config.py reads DATA_DIR from the
environment, and absolute paths override ROOT_DIR in pathlib.
"""
import atexit
import os
import shutil
import tempfile

_TMP = tempfile.mkdtemp(prefix="bookly_test_")
os.environ["DATA_DIR"] = _TMP
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)
