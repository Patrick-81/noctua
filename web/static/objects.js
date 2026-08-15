// ═══════════════════════════════════════════════════════════════
// Noctua — objects.js (module classique, bindings lexicaux globaux)
// ═══════════════════════════════════════════════════════════════

// ── Object search ─────────────────────────────────────────────

function initObjectSearch() {
    const input = document.getElementById('obj-search');
    const resultsEl = document.getElementById('obj-search-results');
    if (!input || !resultsEl) return;

    let activeIdx = -1;
    let currentResults = [];

    function renderResults(results) {
        currentResults = results;
        activeIdx = -1;
        resultsEl.innerHTML = '';
        if (!results.length) { resultsEl.style.display = 'none'; return; }
        results.forEach((r, i) => {
            const div = document.createElement('div');
            div.className = 'obj-search-item';
            const name = r.name || '';
            div.innerHTML = `<span class="obj-id">${escapeHTML(r.id)}</span><span class="obj-name">${escapeHTML(name)}</span><span class="obj-catalog">${escapeHTML(r.catalog)}</span>`;
            div.addEventListener('click', () => selectResult(r));
            div.addEventListener('mouseenter', () => setActive(i));
            resultsEl.appendChild(div);
        });
        resultsEl.style.display = 'block';
    }

    function setActive(idx) {
        resultsEl.querySelectorAll('.obj-search-item').forEach((el, i) => el.classList.toggle('active', i === idx));
        activeIdx = idx;
    }

    function selectResult(r) {
        input.value = r.id;
        resultsEl.style.display = 'none';
        setTargetObject(r);
        if (skyEngine) {
            skyEngine.centerOnObject(r.ra, r.dec);
            addLog('info', 'search', i18nFmt('log.search.object', { id: r.id, catalog: r.catalog }));
        }
    }

    let searchTimeout = null;
    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const q = input.value.trim();
        if (q.length < 1) { resultsEl.style.display = 'none'; return; }
        searchTimeout = setTimeout(() => {
            if (!skyEngine) return;
            renderResults(skyEngine.search(q));
        }, 150);
    });

    input.addEventListener('keydown', (e) => {
        const count = currentResults.length;
        if (!count || resultsEl.style.display === 'none') return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIdx + 1) % count); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIdx - 1 + count) % count); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && activeIdx < count) selectResult(currentResults[activeIdx]);
            else if (count > 0) selectResult(currentResults[0]);
        } else if (e.key === 'Escape') { resultsEl.style.display = 'none'; input.blur(); }
    });

    input.addEventListener('blur', () => setTimeout(() => { resultsEl.style.display = 'none'; }, 200));
    input.addEventListener('focus', () => {
        const q = input.value.trim();
        if (q.length >= 1 && skyEngine) renderResults(skyEngine.search(q));
    });
}

// ── Object selector (GOTO) ────────────────────────────────────

function initObjectSelector() {
    const overlay = document.getElementById('obj-select-overlay');
    const search = document.getElementById('obj-select-search');
    const results = document.getElementById('obj-select-results');
    const closeBtn = document.getElementById('obj-select-close');
    const cancelBtn = document.getElementById('obj-select-cancel');
    const gotoBtn = document.getElementById('obj-select-goto');
    const openBtn = document.getElementById('btn-obj-select');
    if (!overlay || !search || !results) return;

    let allObjects = [];
    let filtered = [];
    let activeIdx = -1;
    let activeObj = null;

    function sourceObjects() {
        if (allObjects.length) return allObjects;
        allObjects = (skyEngine && Array.isArray(skyEngine._objects)) ? skyEngine._objects : [];
        return allObjects;
    }

    function renderList() {
        results.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        filtered = sourceObjects();
        if (q) {
            filtered = filtered.filter(o =>
                String(o.id || '').toLowerCase().includes(q) ||
                String(o.name || '').toLowerCase().includes(q) ||
                String(o.catalog || '').toLowerCase().includes(q));
        }
        if (!filtered.length) {
            results.innerHTML = '<div class="obj-select-empty">Aucun objet — catalogue vide ou non chargé.</div>';
            return;
        }
        const shown = filtered.slice(0, 300);
        shown.forEach((o, i) => {
            const div = document.createElement('div');
            div.className = 'obj-select-item' + (i === activeIdx ? ' active' : '');
            div.innerHTML = `<span class="obj-id">${escapeHTML(o.id)}</span><span class="obj-name">${escapeHTML(o.name || '')}</span><span class="obj-catalog">${escapeHTML(o.catalog || '')}</span>`;
            div.addEventListener('mouseenter', () => setActive(i));
            div.addEventListener('click', () => { selectObject(o); close(); });
            results.appendChild(div);
        });
        activeIdx = Math.min(activeIdx, shown.length - 1);
    }

    function setActive(i) {
        activeIdx = i;
        activeObj = filtered.slice(0, 300)[i] || null;
        results.querySelectorAll('.obj-select-item').forEach((el, idx) => el.classList.toggle('active', idx === i));
    }

    function selectObject(o) {
        setTargetObject(o);
        if (skyEngine) {
            skyEngine.centerOnObject(o.ra, o.dec);
            addLog('info', 'mount', i18nFmt('log.mount.target_set', { id: o.id, cat: o.catalog || '' }));
        }
    }

    function open() {
        activeIdx = -1;
        activeObj = null;
        search.value = '';
        renderList();
        overlay.style.display = 'flex';
        search.focus();
    }

    function close() {
        overlay.style.display = 'none';
    }

    if (openBtn) openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    search.addEventListener('input', () => { activeIdx = -1; activeObj = null; renderList(); });
    search.addEventListener('keydown', (e) => {
        const count = results.querySelectorAll('.obj-select-item').length;
        if (!count) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIdx + 1) % count); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIdx - 1 + count) % count); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeObj) { selectObject(activeObj); close(); }
        } else if (e.key === 'Escape') { close(); }
    });
    if (gotoBtn) gotoBtn.addEventListener('click', () => {
        const o = activeObj || filtered.slice(0, 300)[0];
        if (!o) { addLog('warning', 'mount', i18n('log.mount.no_object')); return; }
        selectObject(o);
        mountGoto();
    });
}

// ── Object catalogs (pour search + hit-test) ─────────────────

async function loadObjectCatalogs() {
    const objects = [];
    try {
        const [mess, ngc, namedStars, bsc] = await Promise.all([
            fetch('/catalogs/messier.json').then(r => r.json()),
            fetch('/catalogs/ngc_ic.json').then(r => r.json()),
            fetch('/catalogs/stars.json').then(r => r.json()),
            fetch('/catalogs/bsc5.json').then(r => r.json()),
        ]);
        for (const o of mess.objects) {
            objects.push({ id: o.id, name: o.names?.[0] || o.id, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'Messier', type: o.type || 'Messier' });
        }
        for (const o of ngc.objects) {
            objects.push({ id: o.id, name: o.names?.[0] || o.id, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'NGC', type: o.type || 'NGC' });
        }
        for (const o of namedStars.objects) {
            objects.push({ id: o.id, name: o.names?.[0] || o.id, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'Star', type: o.constellation ? `${o.id} (${o.constellation})` : 'Star' });
        }
        for (const o of bsc.objects) {
            if (objects.some(e => e.id === o.id)) continue;
            objects.push({ id: o.id, name: o.names?.[0] || null, ra: o.ra_deg, dec: o.dec_deg, mag: o.mag, catalog: 'BSC', type: o.constellation ? `${o.id} (${o.constellation})` : 'Star' });
        }
        if (skyEngine) skyEngine._objects = objects;
        addLog('info', 'sky', i18nFmt('log.sky.hit_test', { n: objects.length }));
    } catch (e) {
        addLog('warning', 'sky', i18nFmt('log.sky.catalog_error', { err: e.message }));
    }
}

// ── Site config popup ─────────────────────────────────────────

function initSitePopup() {
    const overlay = document.getElementById('site-popup-overlay');
    const siteBtn = document.getElementById('btn-update-location');
    const closeBtn = document.getElementById('site-popup-close');
    const cancelBtn = document.getElementById('site-cancel-btn');
    const saveBtn = document.getElementById('site-save-btn');
    const gpsBtn = document.getElementById('site-gps-btn');
    const siteName = document.getElementById('site-name');
    const siteLat = document.getElementById('site-lat');
    const siteLng = document.getElementById('site-lng');
    const siteElev = document.getElementById('site-elev');
    const siteTz = document.getElementById('site-tz');
    const citySearch = document.getElementById('site-city-search');
    const cityResults = document.getElementById('site-city-results');

    function openPopup() {
        fetch('/api/site').then(r => r.json()).then(site => {
            if (siteName) siteName.value = site.name || '';
            if (siteLat) siteLat.value = site.latitude ?? '';
            if (siteLng) siteLng.value = site.longitude ?? '';
            if (siteElev) siteElev.value = site.elevation ?? '';
            if (siteTz && site.timezone) {
                const opt = siteTz.querySelector(`option[value="${site.timezone}"]`);
                if (opt) siteTz.value = site.timezone;
            }
        }).catch(() => {});
        if (overlay) overlay.style.display = 'flex';
        if (cityResults) cityResults.style.display = 'none';
        if (citySearch) citySearch.value = '';
    }

    function closePopup() {
        if (overlay) overlay.style.display = 'none';
    }

    if (siteBtn) siteBtn.addEventListener('click', openPopup);
    if (closeBtn) closeBtn.addEventListener('click', closePopup);
    if (cancelBtn) cancelBtn.addEventListener('click', closePopup);
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(); });

    if (citySearch) {
        let searchTimeout = null;
        citySearch.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const q = citySearch.value.trim();
            if (q.length < 2) { cityResults.style.display = 'none'; return; }
            searchTimeout = setTimeout(() => {
                fetch(`/api/site/cities?q=${encodeURIComponent(q)}`).then(r => r.json()).then(cities => {
                    if (!cities.length) { cityResults.style.display = 'none'; return; }
                    cityResults.innerHTML = '';
                    cities.forEach(c => {
                        const div = document.createElement('div');
                        div.className = 'city-item';
                        div.innerHTML = `<span>${c.name}</span><span class="city-meta">${c.lat.toFixed(2)}°N ${c.lng.toFixed(2)}°E ${c.elev}m</span>`;
                        div.addEventListener('click', () => {
                            if (siteLat) siteLat.value = c.lat;
                            if (siteLng) siteLng.value = c.lng;
                            if (siteElev) siteElev.value = c.elev;
                            cityResults.style.display = 'none';
                            citySearch.value = c.name;
                        });
                        cityResults.appendChild(div);
                    });
                    cityResults.style.display = 'block';
                }).catch(() => { cityResults.style.display = 'none'; });
            }, 300);
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.site-city-row')) cityResults.style.display = 'none';
        });
    }

    if (gpsBtn) {
        gpsBtn.addEventListener('click', () => {
            if (!navigator.geolocation) { addLog('warning', 'site', i18n('log.site.unsupported')); return; }
            gpsBtn.textContent = '⏳ Localisation...';
            gpsBtn.disabled = true;
            navigator.geolocation.getCurrentPosition(
                pos => {
                    if (siteLat) siteLat.value = pos.coords.latitude.toFixed(4);
                    if (siteLng) siteLng.value = pos.coords.longitude.toFixed(4);
                    if (siteElev) siteElev.value = Math.round(pos.coords.altitude || 0);
                    gpsBtn.textContent = '📍 Géolocaliser (GPS)';
                    gpsBtn.disabled = false;
                },
                err => {
                    addLog('warning', 'site', i18nFmt('log.site.gps_failed', { err: err.message }));
                    gpsBtn.textContent = '📍 Géolocaliser (GPS)';
                    gpsBtn.disabled = false;
                },
                { enableHighAccuracy: true, timeout: 15000 }
            );
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const body = {
                name: siteName?.value?.trim() || '',
                latitude: parseFloat(siteLat?.value) || 0,
                longitude: parseFloat(siteLng?.value) || 0,
                elevation: parseFloat(siteElev?.value) || 0,
                timezone: siteTz?.value || 'UTC',
            };
            try {
                await fetch('/api/site', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                addLog('info', 'site', i18nFmt('log.site.saved', { lat: body.latitude.toFixed(4), lng: body.longitude.toFixed(4) }));
                if (skyEngine) skyEngine.updateSite(body.latitude, body.longitude, body.elevation);
                closePopup();
            } catch (e) {
                addLog('error', 'site', i18nFmt('log.site.error', { err: e.message }));
            }
        });
    }
}

// ── Time management ───────────────────────────────────────────

function initTimeControls() {
    const realtimeBtn = document.getElementById('btn-mode-realtime');
    const manualBtn = document.getElementById('btn-mode-manual');
    const manualControls = document.getElementById('manual-controls');
    const applyBtn = document.getElementById('btn-apply-manual');
    const dateInput = document.getElementById('manual-date');
    const timeInput = document.getElementById('manual-time');

    function fillManualFields(date) {
        const pad = (n) => String(n).padStart(2, '0');
        if (dateInput) dateInput.value = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
        if (timeInput) timeInput.value = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    if (realtimeBtn) {
        realtimeBtn.addEventListener('click', () => {
            realtimeBtn.classList.add('active');
            if (manualBtn) manualBtn.classList.remove('active');
            if (manualControls) manualControls.style.display = 'none';
            if (skyEngine) skyEngine.setRealTime();
            currentModeConfig().time_mode = 'realtime';
            saveUiConfig();
        });
    }

    if (manualBtn) {
        manualBtn.addEventListener('click', () => {
            manualBtn.classList.add('active');
            if (realtimeBtn) realtimeBtn.classList.remove('active');
            if (manualControls) manualControls.style.display = 'flex';
            fillManualFields(new Date());
            currentModeConfig().time_mode = 'manual';
            saveUiConfig();
        });
    }

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            const dateVal = dateInput?.value;
            const timeVal = timeInput?.value;
            if (!dateVal) return;
            const full = new Date(`${dateVal}T${timeVal || '00:00:00'}`);
            if (isNaN(full.getTime())) return;
            if (skyEngine) skyEngine.setManualTime(full);
            const modeCfg = currentModeConfig();
            modeCfg.manual_date = dateVal;
            modeCfg.manual_time = timeVal || '00:00:00';
            saveUiConfig();
        });
    }

    fillManualFields(new Date());
}

