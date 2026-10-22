"""
server_manager.py — Manages the lifecycle of the protocol server (indiserver or indigo_server).
"""

import asyncio
import logging
import subprocess
import signal
from typing import Optional

log = logging.getLogger("indigo.server_manager")

class ServerManager:
    """Manages the lifecycle of the protocol server (indiserver or indigo_server)."""

    def __init__(self, server_type: str, host: str = "127.0.0.1", port: int = 7624, command: Optional[list[str]] = None):
        self._server_type = server_type.lower()
        self._host = host
        self._port = port
        self._command = command
        self._process: Optional[subprocess.Popen] = None
        self._task: Optional[asyncio.Task] = None

        if self._server_type not in ("indigo", "indi"):
            raise ValueError(f"Unsupported server_type: {self._server_type}. Must be 'indigo' or 'indi'.")

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    async def start(self) -> None:
        """Starts the server process if it's not already running."""
        if self.is_running:
            log.info("Server (%s) is already running.", self._server_type)
            return

        cmd = self._get_command()
        log.info("Starting %s server: %s", self._server_type, " ".join(cmd))

        try:
            # Inherit current env and force Python to flush stdout/stderr immediately
            env = {**dict(__import__("os").environ), "PYTHONUNBUFFERED": "1"}
            # Start the process
            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
                preexec_fn=None, # Use setsid on Linux if we want to kill the whole group
            )
            
            # We'll run a task to monitor the process and log its output
            self._task = asyncio.create_task(self._monitor_process())
            
            # Wait a bit to see if it crashes immediately
            await asyncio.sleep(2.0)
            if not self.is_running:
                stdout, stderr = self._process.communicate()
                log.error("%s server failed to start. STDOUT: %s, STDERR: %s", 
                          self._server_type, stdout, stderr)
                self._process = None
                raise RuntimeError(f"{self._server_type} server failed to start.")
            
            log.info("%s server started (PID: %d)", self._server_type, self._process.pid)

        except Exception as e:
            log.error("Failed to start %s server: %s", self._server_type, e)
            raise

    async def stop(self) -> None:
        """Stops the server process."""
        if not self.is_running:
            log.info("Server (%s) is not running.", self._server_type)
            return

        log.info("Stopping %s server (PID: %d)...", self._server_type, self._process.pid)
        
        # Try SIGTERM first
        self._process.terminate()
        
        try:
            # Wait for it to exit
            await asyncio.wait_for(self._wait_for_exit(), timeout=5.0)
            log.info("%s server stopped gracefully.", self._server_type)
        except asyncio.TimeoutError:
            log.warning("%s server did not stop gracefully, sending SIGKILL...", self._server_type)
            self._process.kill()
            await self._wait_for_exit()
            log.info("%s server killed.", self._server_type)
        finally:
            self._process = None
            if self._task:
                self._task.cancel()

    async def _wait_for_exit(self) -> None:
        """Wait for the process to exit in a non-blocking way."""
        while self.is_running:
            await asyncio.sleep(0.5)

    async def _monitor_process(self) -> None:
        """Monitors the process and logs its output."""
        if not self._process:
            return

        # We use a thread to read from the pipes to avoid blocking the event loop
        loop = asyncio.get_running_loop()

        def _read_pipe(pipe, prefix):
            for line in iter(pipe.readline, ""):
                if line:
                    log.debug("[%s] %s", prefix, line.strip())
                else:
                    break

        # Read stdout and stderr concurrently (process may write to either)
        await asyncio.gather(
            loop.run_in_executor(None, _read_pipe, self._process.stdout, f"{self._server_type}-stdout"),
            loop.run_in_executor(None, _read_pipe, self._process.stderr, f"{self._server_type}-stderr"),
        )

    def _get_command(self) -> list[str]:
        """Returns the command to start the server."""
        if self._command:
            return self._command
        if self._server_type == "indigo":
            return ["indigo_server"]
        else:  # indi
            return ["indiserver"]
