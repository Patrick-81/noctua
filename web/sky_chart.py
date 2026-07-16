"""
sky_chart.py — Sky chart renderer for telescope pointing.

Uses starplot (matplotlib) to generate a Stereographic projection.
Supports on-demand generation with custom FOV and center for zoom/pan.
"""

from __future__ import annotations

import io
import logging
import math
import threading
from typing import TYPE_CHECKING

from starplot import MapPlot, Stereographic, styles, _
from starplot.styles import MarkerStyle, ObjectStyle

if TYPE_CHECKING:
    from .devices.mount import Mount

log = logging.getLogger("indigo.skychart")

STYLE_DARK = styles.PlotStyle().extend(styles.extensions.BLUE_NIGHT)


class SkyChart:
    """Generates and caches a sky chart. Supports zoom/pan via custom FOV and center."""

    def __init__(
        self,
        default_fov: float = 42.0,
        resolution: int = 2048,
        mag_limit: float = 7.0,
        style=None,
    ):
        self.default_fov = default_fov
        self.resolution = resolution
        self.mag_limit = mag_limit
        self.style = style or STYLE_DARK

        self._lock = threading.Lock()
        # Current rendered state
        self._png_bytes: bytes | None = None
        self._center_ra: float = 0.0
        self._center_dec: float = 0.0
        self._fov: float = default_fov
        # Telescope position (updated by worker)
        self._tel_ra_hours: float = 0.0
        self._tel_dec_deg: float = 0.0
        self._tel_known: bool = False

    @property
    def ready(self) -> bool:
        return self._png_bytes is not None

    def update_telescope(self, ra_hours: float, dec_deg: float) -> None:
        """Called by the worker when telescope moves."""
        with self._lock:
            self._tel_ra_hours = ra_hours
            self._tel_dec_deg = dec_deg
            self._tel_known = True

    def needs_regen(self, ra_hours: float, dec_deg: float) -> bool:
        """Check if the telescope has moved far enough to warrant auto-regen."""
        if not self.ready:
            return True
        ra_deg = ra_hours * 15.0
        dra = abs(ra_deg - self._center_ra)
        if dra > 180:
            dra = 360 - dra
        ddec = abs(dec_deg - self._center_dec)
        dist = (dra ** 2 + ddec ** 2) ** 0.5
        return dist > self._fov * 0.3

    def generate(
        self,
        ra_hours: float,
        dec_deg: float,
        fov_deg: float | None = None,
        marker: bool = True,
    ) -> None:
        """Render the sky chart. Blocking (~2-4s).

        If fov_deg is None, uses self.default_fov.
        The chart is centered on (ra_hours, dec_deg) with the given FOV.
        """
        fov = fov_deg or self.default_fov
        ra_deg = ra_hours * 15.0
        half = fov / 2

        dec_min = max(dec_deg - half, -90.0)
        dec_max = min(dec_deg + half, 90.0)
        dec_center = (dec_min + dec_max) / 2

        try:
            p = MapPlot(
                projection=Stereographic(center_ra=ra_deg, center_dec=dec_center),
                ra_min=ra_deg - half,
                ra_max=ra_deg + half,
                dec_min=dec_min,
                dec_max=dec_max,
                resolution=self.resolution,
                style=self.style,
                autoscale=True,
                suppress_warnings=True,
            )

            # Adjust star limit based on FOV (wider = fainter stars visible)
            mag = self.mag_limit
            if fov > 60:
                mag = 5.5
            elif fov > 30:
                mag = 6.5

            p.stars(where=[_.magnitude < mag])
            p.constellations()
            p.constellation_labels()
            p.dsos(where=[_.size < 20])

            if fov < 20:
                p.gridlines(labels=True)
            else:
                p.gridlines(labels=False)

            if marker:
                p.marker(
                    ra=ra_deg, dec=dec_deg,
                    style=ObjectStyle(
                        marker=MarkerStyle(
                            symbol="circle_crosshair",
                            size=60,
                            color="#ff4444",
                            edge_color="#ff4444",
                            fill="none",
                            edge_width=2,
                        ),
                    ),
                    label="",
                )

            buf = io.BytesIO()
            p.export(buf, format="png")
            p.close_fig()

            with self._lock:
                self._png_bytes = buf.getvalue()
                self._center_ra = ra_deg
                self._center_dec = dec_center
                self._fov = fov

            log.info(
                "Chart: RA=%.2fh DEC=%.2f° FOV=%.0f° (%d KB)",
                ra_hours, dec_deg, fov, len(self._png_bytes) // 1024,
            )

        except Exception as e:
            log.error("Chart generation failed: %s", e, exc_info=True)

    def get_image_bytes(self) -> bytes | None:
        with self._lock:
            return self._png_bytes

    def get_info(self) -> dict:
        """Return chart metadata for the client."""
        with self._lock:
            return {
                "ready": self._png_bytes is not None,
                "center_ra": self._center_ra,
                "center_dec": self._center_dec,
                "fov": self._fov,
                "resolution": self.resolution,
                "tel_ra": self._tel_ra_hours,
                "tel_dec": self._tel_dec_deg,
                "tel_known": self._tel_known,
            }

    def get_crosshair_position(
        self, tel_ra_hours: float, tel_dec_deg: float
    ) -> tuple[float, float]:
        """Compute pixel position of a given RA/DEC on the current chart."""
        with self._lock:
            center_ra = math.radians(self._center_ra)
            center_dec = math.radians(self._center_dec)
            fov = self._fov
            res = self.resolution

        ra = math.radians(tel_ra_hours * 15.0)
        dec = math.radians(tel_dec_deg)

        cos_c = (
            math.sin(center_dec) * math.sin(dec)
            + math.cos(center_dec) * math.cos(dec) * math.cos(ra - center_ra)
        )
        if cos_c <= 0:
            return (-1.0, -1.0)

        k = 1.0 / cos_c
        x_proj = k * math.cos(dec) * math.sin(ra - center_ra)
        y_proj = k * (
            math.cos(center_dec) * math.sin(dec)
            - math.sin(center_dec) * math.cos(dec) * math.cos(ra - center_ra)
        )

        half_fov_rad = math.radians(fov / 2)
        scale = (res / 2) / math.tan(half_fov_rad)

        px = (res / 2) + x_proj * scale
        py = (res / 2) - y_proj * scale

        return (px, py)

    def pixel_to_radec(self, px: float, py: float) -> tuple[float, float]:
        """Convert pixel position to RA/Dec (degrees) using inverse stereographic."""
        with self._lock:
            center_ra = math.radians(self._center_ra)
            center_dec = math.radians(self._center_dec)
            fov = self._fov
            res = self.resolution

        half_fov_rad = math.radians(fov / 2)
        scale = (res / 2) / math.tan(half_fov_rad)

        x_proj = (px - res / 2) / scale
        y_proj = -(py - res / 2) / scale  # y inverted

        rho = math.sqrt(x_proj ** 2 + y_proj ** 2)
        if rho < 1e-10:
            return (math.degrees(center_ra), math.degrees(center_dec))

        c = 2 * math.atan(rho / 2)
        sin_c = math.sin(c)
        cos_c = math.cos(c)

        dec = math.asin(
            cos_c * math.sin(center_dec)
            + y_proj * sin_c * math.cos(center_dec) / rho
        )
        ra = center_ra + math.atan2(
            x_proj * sin_c,
            rho * math.cos(center_dec) * cos_c - y_proj * sin_c * math.sin(center_dec),
        )

        return (math.degrees(ra), math.degrees(dec))


# ── Background worker ──────────────────────────────────────────


class SkyChartWorker:
    """Background thread that keeps the sky chart centered on the telescope."""

    def __init__(self, chart: SkyChart, get_mount_fn, interval: float = 3.0):
        self.chart = chart
        self._get_mount = get_mount_fn
        self._interval = interval
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        log.info("SkyChartWorker started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        log.info("SkyChartWorker stopped")

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                mount = self._get_mount()
                if mount and mount.connected:
                    ra = mount.ra_hours
                    dec = mount.dec_deg
                    self.chart.update_telescope(ra, dec)
                    if self.chart.needs_regen(ra, dec):
                        self.chart.generate(ra, dec)
            except Exception as e:
                log.error("SkyChartWorker error: %s", e, exc_info=True)

            self._stop.wait(self._interval)
