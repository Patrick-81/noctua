"""
server_manager.py — Manages the lifecycle of the protocol server (indiserver or indigo_server).
"""

import asyncio
import logging
import os
import socket
import subprocess
import signal
from pathlib import Path
from typing import Optional

log = logging.getLogger("indigo.server_manager")

SERVER_EXECUTABLES = ("indiserver", "indigo_server")

class ServerManager:
    """Manages the lifecycle of the protocol server (indiserver or indigo_server)."""

    def __init__(self, server_type: str, host: str = "127.0.0.1", port: int = 7624, command: Optional[list[str]] = None):
        self._server_type = server_type.lower()
        self._host = host
        self._port = port
        self._command = command
        self._process: Optional[subprocess.Popen] = None
        self._task: Optional[asyncio.Task] = None
        self._external_server = False

        if self._server_type not in ("indigo", "indi"):
            raise ValueError(f"Unsupported server_type: {self._server_type}. Must be 'indigo' or 'indi'.")

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    @property
    def external_server(self) -> bool:
        return self._external_server

    def _is_local_host(self) -> bool:
        """True when the configured server host belongs to this machine."""
        host = (self._host or "").strip()
        if host in ("", "0.0.0.0", "::", "localhost"):
            return True
        try:
            addr = socket.gethostbyname(host)
        except OSError:
            return False
        if addr.startswith("127."):
            return True
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind((addr, 0))
            return True
        except OSError:
            return False

    def _find_local_servers(self) -> list[dict]:
        """Return INDI/INDIGO server processes already running locally."""
        found: list[dict] = []
        proc = Path("/proc")
        if not proc.is_dir():
            return found
        own_pid = os.getpid()
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            if pid == own_pid:
                continue
            try:
                raw = (entry / "cmdline").read_bytes()
            except OSError:
                continue
            args = [a.decode(errors="replace") for a in raw.split(b"\0") if a]
            if not args:
                continue
            name = os.path.basename(args[0])
            if name in SERVER_EXECUTABLES:
                found.append({"pid": pid, "name": name, "cmdline": " ".join(args)})
        return found

    def _port_in_use(self) -> bool:
        """True when something already listens on the configured host/port."""
        host = self._host
        if host in ("", "0.0.0.0", "::"):
            host = "127.0.0.1"
        try:
            with socket.create_connection((host, self._port), timeout=0.5):
                return True
        except OSError:
            return False

    async def start(self) -> None:
        """Starts the server process if it's not already running."""
        if self.is_running:
            log.info("Server (%s) is already running.", self._server_type)
            return

        if not self._is_local_host():
            log.warning(
                "auto_start ignoré : le serveur INDI %s:%d est distant, "
                "aucun processus local ne sera démarré.",
                self._host, self._port,
            )
            return

        existing = self._find_local_servers()
        if existing:
            details = ", ".join(f"{s['name']} (PID {s['pid']})" for s in existing)
            log.warning(
                "Serveur INDI/INDIGO déjà actif localement : %s — "
                "aucun nouveau processus démarré.", details,
            )
            self._external_server = True
            return

        if self._port_in_use():
            log.warning(
                "Port %d déjà utilisé localement — aucun nouveau serveur "
                "INDI/INDIGO démarré.", self._port,
            )
            self._external_server = True
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
        if self._external_server:
            log.info(
                "Serveur INDI/INDIGO externe détecté au démarrage — "
                "il n'est pas arrêté par Noctua."
            )
            return
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
            return ["indigo_server", "-p", str(self._port)]
        else:  # indi
            return ["indiserver", "-p", str(self._port)]
