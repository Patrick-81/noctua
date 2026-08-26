/**
 * useAstrometryController — Vue 3 composable that wraps the
 * AstrometryController and exposes reactive state for the frontend.
 *
 * Usage in a Vue component:
 *
 *   import { useAstrometryController } from './useAstrometryController';
 *
 *   const { connected, solving, status, fakeImages, results, log } =
 *     useAstrometryController();
 *
 *   const controller = useAstrometryController().controller;
 *   await controller.solve({ mode: 'mount', image: 'fake_fits/orion.fits' });
 */

import { reactive, ref } from 'vue';

// ── API client ──────────────────────────────────────────────────────

const BASE_URL = import.meta.env.VITE_ASTROMETRY_API_URL || 'http://localhost:8080';

async function apiGet(endpoint: string) {
  const res = await fetch(`${BASE_URL}${endpoint}`);
  return res.json();
}

async function apiPost(endpoint: string, body: object) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Composable ──────────────────────────────────────────────────────

function useAstrometryController() {
  // ── Reactive state ──
  const state = reactive({
    connected: false,
    solving: false,
    status: 'Disconnecté',
    fakeImages: [
      {
        name: 'Orion Nebula (fake)',
        path: 'fake_fits/orion_nebula.tif',
        width: 1920,
        height: 1080,
        description: 'Simulated Orion Nebula field with ~500 stars',
      },
      {
        name: 'Pleiades (fake)',
        path: 'fake_fits/pleiades.tif',
        width: 1024,
        height: 1024,
        description: 'Simulated Pleiades cluster field',
      },
      {
        name: 'Galaxy Cluster (fake)',
        path: 'fake_fits/galaxy_cluster.tif',
        width: 2048,
        height: 2048,
        description: 'Simulated galaxy cluster with deep field',
      },
    ],
    results: null,
    log: [],
  });

  // ── Methods ──

  async function connect() {
    try {
      const data = await apiGet('/api/astrometrie/status');
      state.connected = data.connected || false;
      state.status = state.connected ? 'Connecté' : 'Disconnecté';
    } catch {
      state.connected = false;
      state.status = 'Disconnecté';
    }
  }

  async function disconnect() {
    state.connected = false;
    state.status = 'Disconnecté';
  }

  async function solve({ mode = 'mount', image = '', threshold = 100 } = {}) {
    state.solving = true;
    state.status = 'Résolution en cours...';
    state.log.push({
      time: new Date().toLocaleTimeString(),
      message: `Lancement de la résolution (mode: ${mode})`,
      error: false,
    });

    try {
      const payload = { mode, image, threshold };
      if (mode === 'mount') {
        // In a real app, these would come from the mount's current position
        // payload.ra_deg = currentMountRa;
        // payload.dec_deg = currentMountDec;
      }

      const result = await apiPost('/api/astrometrie/solve', payload);

      if (result.ok) {
        state.results = result;
        state.log.push({
          time: new Date().toLocaleTimeString(),
          message: `Résolution terminée — ${result.matched_stars} étoiles matchées`,
          error: false,
        });
      } else {
        state.results = null;
        state.log.push({
          time: new Date().toLocaleTimeString(),
          message: `Erreur: ${result.error}`,
          error: true,
        });
      }
    } catch (err) {
      state.results = null;
      state.log.push({
        time: new Date().toLocaleTimeString(),
        message: `Erreur réseau: ${err.message}`,
        error: true,
      });
    } finally {
      state.solving = false;
      state.status = state.results ? 'Résolution terminée' : 'Disconnecté';
    }
  }

  function clearResults() {
    state.results = null;
    state.status = 'Disconnecté';
    state.log.push({
      time: new Date().toLocaleTimeString(),
      message: 'Résultats effacés',
      error: false,
    });
  }

  function addLogEntry(message: string, isError = false) {
    state.log.push({
      time: new Date().toLocaleTimeString(),
      message,
      error: isError,
    });
    if (state.log.length > 100) {
      state.log = state.log.slice(-100);
    }
  }

  // ── Return ──
  return {
    connected: ref(state.connected),
    solving: ref(state.solving),
    status: ref(state.status),
    fakeImages: ref(state.fakeImages),
    results: ref(state.results),
    log: ref(state.log),
    statusText: ref(state.status),
    connect,
    disconnect,
    solve,
    clearResults,
    addLogEntry,
    controller: {
      connect,
      disconnect,
      solve,
      clearResults,
      addLogEntry,
    },
  };
}

export default useAstrometryController;
export { useAstrometryController };
