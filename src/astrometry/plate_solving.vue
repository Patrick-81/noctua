<template>
  <div class="astrometry-panel">
    <!-- Header -->
    <div class="panel-header">
      <div class="header-left">
        <h2 class="panel-title">🔭 Astrométrie — Plate Solving</h2>
        <span class="panel-subtitle">Résolution de plaques astrométriques</span>
      </div>
      <div class="status-badge" :class="{ connected: connected, solving: solving }">
        <span class="badge-dot" :class="{ connected: connected, solving: solving }"></span>
        {{ statusText }}
      </div>
    </div>

    <!-- Controls — grid layout -->
    <div class="controls">
      <div class="control-group">
        <label class="control-label">Mode</label>
        <select v-model="solveMode" @change="onModeChange" class="control-select">
          <option value="mount">Mode Monture (avec position)</option>
          <option value="blind">Mode Aveugle (sans position)</option>
        </select>
      </div>

      <div class="control-group">
        <label class="control-label">Image de test</label>
        <select v-model="testImage" @change="onImageChange" class="control-select">
          <option value="">— Sélectionner —</option>
          <option v-for="img in fakeImages" :key="img.name" :value="img.path">
            {{ img.name }}
          </option>
          <option value="capture">Image Capture actuelle</option>
        </select>
      </div>

      <div class="control-group">
        <label class="control-label">Seuil de détection</label>
        <div class="slider-container">
          <input type="range" min="50" max="500" v-model.number="detectThreshold" step="50" class="control-range" />
          <span class="threshold-value">{{ detectThreshold }} px</span>
        </div>
      </div>
    </div>

    <!-- Buttons row -->
    <div class="btn-row">
      <button class="btn btn-primary" @click="onStartSolve" :disabled="solving || !imageSource">
        <span class="btn-icon">{{ solving ? '⏳' : '🔍' }}</span>
        {{ solving ? 'Résolution...' : 'Lancer la résolution' }}
      </button>
      <button class="btn btn-secondary" @click="onClearResults" :disabled="!results">
        <span class="btn-icon">🗑️</span> Effacer
      </button>
    </div>

    <!-- Image Preview -->
    <div class="image-preview">
      <div class="image-container">
        <canvas id="astrometry-canvas" :width="canvasWidth" :height="canvasHeight"></canvas>
        <div v-if="showOverlay" class="grid-overlay"></div>
      </div>
      <div class="image-info">
        <span v-if="imageSource === 'capture'" class="info-icon">📷</span>
        <span v-if="imageSource === 'capture'" class="info-text">Capture en direct</span>
        <span v-else-if="imageSource" class="info-text">{{ imageInfo }}</span>
        <span v-else class="placeholder">Aucune image sélectionnée</span>
      </div>
    </div>

    <!-- Results -->
    <div v-if="results" class="results">
      <h3 class="results-title">📊 Résultats de résolution</h3>

      <div class="result-grid">
        <div class="result-card">
          <strong class="result-label">Centre RA</strong>
          <span class="result-value">{{ formatRA(results.center_ra_deg) }}</span>
        </div>
        <div class="result-card">
          <strong class="result-label">Centre DEC</strong>
          <span class="result-value">{{ formatDec(results.center_dec_deg) }}</span>
        </div>
        <div class="result-card">
          <strong class="result-label">Échelle</strong>
          <span class="result-value">{{ results.scale_arcsec_px | number(4) }} arcsec/px</span>
        </div>
        <div class="result-card">
          <strong class="result-label">Rotation</strong>
          <span class="result-value">{{ results.rotation_deg | number(3) }}°</span>
        </div>
        <div class="result-card">
          <strong class="result-label">RMS (arcsec)</strong>
          <span class="result-value" :class="{ good: results.rms_arcsec < 1.0, bad: results.rms_arcsec > 3.0 }">
            {{ results.rms_arcsec | number(3) }}
          </span>
        </div>
        <div class="result-card">
          <strong class="result-label">Étoiles matched</strong>
          <span class="result-value">{{ results.matched_stars }}</span>
        </div>
      </div>

      <!-- WCS corners -->
      <div v-if="results.footprint_corners" class="footprint">
        <h4 class="footprint-title">Coin du champ de vue (WCS)</h4>
        <table>
          <thead>
            <tr>
              <th>Corner</th>
              <th>RA</th>
              <th>DEC</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="corner in results.footprint_corners" :key="$index">
              <th class="corner-label">[[{{ $index + 1 }}]</th>
              <td>{{ formatRA(corner.ra) }}</td>
              <td>{{ formatDec(corner.dec) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Log -->
    <div class="log">
      <h4 class="log-title">📝 Journal</h4>
      <div v-for="entry in log" :key="$index" class="log-entry" :class="{error: entry.error}">
        <span class="log-time">{{ entry.time }}</span>
        <span class="log-msg">{{ entry.message }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useAstrometryController } from './useAstrometryController';

// ── Controller ──
const {
  connected,
  solving,
  fakeImages,
  startSolve,
  clearResults,
  results,
  log,
  statusText,
} = useAstrometryController();

// ── Local state ──
const solveMode = ref('mount');
const testImage = ref('');
const detectThreshold = ref(100);
const imageSource = ref('');
const showOverlay = ref(false);
const canvasWidth = 800;
const canvasHeight = 600;

// ── Computed ──
const imageInfo = computed(() => {
  const img = fakeImages.find(i => i.path === testImage.value);
  if (img) return `${img.name} (${img.width}×${img.height})`;
  return '';
});

// ── Methods ──
function onModeChange() {
  logEntry('Mode: ' + solveMode.value);
}

function onImageChange() {
  imageSource.value = testImage.value;
  if (testImage.value === 'capture') {
    logEntry('Source: capture en direct');
  } else if (testImage.value) {
    logEntry('Source: ' + testImage.value);
  }
}

async function onStartSolve() {
  if (!imageSource.value) {
    logEntry('ERREUR: Aucune image sélectionnée', true);
    return;
  }
  logEntry('Lancement de la résolution...');
  await startSolve({
    mode: solveMode.value,
    image: imageSource.value,
    threshold: detectThreshold.value,
  });
  logEntry('Résolution terminée');
}

function onClearResults() {
  clearResults();
  results.value = null;
  showOverlay.value = false;
  logEntry('Résultats effacés');
}

function logEntry(message, isError = false) {
  log.push({
    time: new Date().toLocaleTimeString(),
    message,
    error: isError,
  });
  if (log.length > 100) log.shift();
}

// ── Helpers ──
function formatRA(deg) {
  if (!results.value) return '';
  const h = deg / 15.0;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const ss = ((h - hh) * 60 - mm) * 60;
  return `${hh}h ${mm}m ${ss.toFixed(3)}s`;
}

function formatDec(deg) {
  if (!results.value) return '';
  const sign = deg >= 0 ? '+' : '-';
  const d = Math.abs(deg);
  const dd = Math.floor(d);
  const mm = Math.floor((d - dd) * 60);
  const ss = ((d - dd) * 60 - mm) * 60;
  return `${sign}${dd}° ${mm}′ ${ss.toFixed(3)}″`;
}

// ── Lifecycle ──
onMounted(() => {
  logEntry('Panel chargé');
});

onUnmounted(() => {
  logEntry('Panel désactivé');
});