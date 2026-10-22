import os
import subprocess
import sys

# This wrapper runs the existing mock_indigo.py but forces it to use port 7624
# to simulate 'indiserver' for testing purposes.

cmd = [sys.executable, "tests/mock_indigo.py", "--port", "7624"]
env = {**os.environ, "PYTHONUNBUFFERED": "1"}
process = subprocess.Popen(cmd, env=env)

try:
    process.wait()
except KeyboardInterrupt:
    process.terminate()
