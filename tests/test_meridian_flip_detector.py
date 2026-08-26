"""Tests for MeridianFlipDetector."""

import asyncio
import pytest
from unittest.mock import Mock, patch
from indigo.devices.mount import MeridianFlipDetector


class TestMeridianFlipDetector:
    """Tests for MeridianFlipDetector."""

    @pytest.fixture
    def mock_mount(self, request):
        """Create a mock mount device with configurable hour_angle."""
        mock = Mock()
        mock.flip = Mock()
        mock.state_dict = Mock(return_value={"target": {"hour_angle": 1.0}})
        return mock

    @pytest.fixture
    def detector(self, mock_mount):
        """Create a MeridianFlipDetector instance."""
        detector = MeridianFlipDetector(mock_mount)
        detector._last_ha = -1.0
        return detector

    def test_initial_state(self, detector):
        """Detector should not have detected a flip initially."""
        assert detector._flip_detected is False

    def test_negative_to_positive_ha_triggers_flip(self, detector, mock_mount):
        """HA going from negative to positive should trigger a flip."""
        detector._last_ha = -1.0
        mock_mount.state_dict.return_value = {"target": {"hour_angle": 1.0}}
        mock_mount.flip.reset_mock()

        detector._detect_flip()

        mock_mount.flip.assert_called_once()
        assert detector._flip_detected is True

    def test_positive_to_negative_ha_triggers_flip(self, detector, mock_mount):
        """HA going from positive to negative should trigger a flip."""
        detector._last_ha = 1.0
        mock_mount.state_dict.return_value = {"target": {"hour_angle": -1.0}}
        mock_mount.flip.reset_mock()

        detector._detect_flip()

        mock_mount.flip.assert_called_once()
        assert detector._flip_detected is True

    def test_same_sign_ha_no_flip(self, detector):
        """HA staying on same side of meridian should not trigger flip."""
        detector._last_ha = -1.0
        detector._mount.state_dict.return_value = {"target": {"hour_angle": -0.5}}
        detector._mount.flip.reset_mock()

        detector._detect_flip()

        detector._mount.flip.assert_not_called()
        assert detector._flip_detected is False

    def test_zero_to_positive_no_flip(self, detector):
        """HA crossing from negative zero to positive should not trigger flip."""
        detector._last_ha = -0.0001
        detector._mount.state_dict.return_value = {"target": {"hour_angle": 0.0001}}
        detector._mount.flip.reset_mock()

        detector._detect_flip()

        detector._mount.flip.assert_not_called()
        assert detector._flip_detected is False

    def test_zero_to_negative_no_flip(self, detector, mock_mount):
        """HA crossing from positive zero to negative should not trigger flip."""
        detector._last_ha = 0.0001
        mock_mount.flip.reset_mock()

        detector._detect_flip()

        mock_mount.flip.assert_not_called()
        assert detector._flip_detected is False

    def test_flip_flag_prevents_duplicate_calls(self, detector, mock_mount):
        """After a flip is detected, subsequent calls should not trigger another."""
        detector._last_ha = -1.0
        mock_mount.flip.reset_mock()

        detector._detect_flip()
        detector._detect_flip()
        detector._detect_flip()

        detector._mount.flip.assert_called_once()

    @pytest.mark.asyncio
    async def test_poll_loop_calls_detect(self, detector):
        """Poll loop should call detect_flip at regular intervals."""
        detector._last_ha = -1.0
        detector._running = True
        detector._stop_requested = False

        with patch.object(detector, '_detect_flip') as mock_detect:
            with patch.object(detector, 'POLL_INTERVAL', 0.1):
                # Give it a chance to run and then stop it
                await asyncio.sleep(0.2)
                detector._stop_requested = True
                await detector._task
                assert mock_detect.call_count >= 1

    @pytest.mark.asyncio
    async def test_poll_loop_stops_on_stop_requested(self, detector):
        """Poll loop should stop when stop is requested."""
        detector._last_ha = -1.0
        detector._running = True
        detector._stop_requested = True

        with patch.object(detector, '_detect_flip') as mock_detect:
            await asyncio.sleep(0.2)
            detector._stop_requested = True
            await detector._task
            assert mock_detect.call_count == 0

    def test_poll_loop_respects_interval(self, detector, mock_mount):
        """Poll loop should respect POLL_INTERVAL between calls."""
        detector._last_ha = -1.0
        detector._running = True
        detector._stop_requested = False

        with patch.object(detector, '_detect_flip') as mock_detect:
            import time
            start = time.time()
            detector._poll_loop()
            elapsed = time.time() - start
            # Should have called at least once with at least POLL_INTERVAL elapsed
            assert mock_detect.call_count >= 1
            assert elapsed >= MeridianFlipDetector.POLL_INTERVAL

    @pytest.mark.asyncio
    async def test_poll_loop_calls_detect(self, detector, mock_mount):
        """Poll loop should call detect_flip at regular intervals."""
        detector._last_ha = -1.0
        detector._running = True
        detector._stop_requested = False

        with patch.object(detector, '_detect_flip') as mock_detect:
            await detector._poll_loop()
            assert mock_detect.call_count >= 1

    def test_state_dict_saves_flip_state(self, detector, mock_mount):
        """State dict should save the flip detection state."""
        detector._last_ha = -1.0
        detector._flip_detected = True
        mock_mount.flip.reset_mock()

        detector._detect_flip()
        state = detector.state_dict()

        assert state['flip_detected'] is True

    def test_state_dict_includes_flip_state(self, detector):
        """State dict should include flip detection state."""
        state = detector.state_dict()
        assert 'flip_detected' in state
        assert state['flip_detected'] is False

    def test_last_ha_saved_in_state(self, detector):
        """State dict should save the last known hour angle."""
        detector._last_ha = 45.5
        state = detector.state_dict()
        assert state['last_ha'] == 45.5

    def test_state_dict_saves_last_ha(self, detector):
        """State dict should save the last hour angle."""
        detector._last_ha = 45.5
        state = detector.state_dict()
        assert state['last_ha'] == 45.5

    def test_load_state_restores_ha(self, detector):
        """Load state should restore the last known hour angle."""
        state = {'last_ha': 30.0, 'meridian_flip_detected': False}
        detector.load_state(state)
        assert detector._last_ha == 30.0

    def test_load_state_restores_flip_detected(self, detector):
        """Load state should restore the flip detection state."""
        state = {'last_ha': 30.0, 'meridian_flip_detected': True}
        detector.load_state(state)
        assert detector._flip_detected is True

    def test_state_dict_filters_nan_values(self, detector):
        """State dict should filter out NaN values."""
        detector._last_ha = float('nan')
        state = detector.state_dict()
        assert 'last_ha' not in state or not (state['last_ha'] != state['last_ha'])

    def test_state_dict_filters_inf_values(self, detector):
        """State dict should filter out Inf values."""
        detector._last_ha = float('inf')
        state = detector.state_dict()
        assert 'last_ha' not in state or state['last_ha'] != float('inf')
