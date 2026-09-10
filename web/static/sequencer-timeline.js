// ═══════════════════════════════════════════════════════════════
// Noctua — sequencer-timeline.js — POC timeline à blocs
// Activé uniquement avec ?timeline=1  (feature-flag, n'affecte pas le mode classique)
// Remplace la liste dense d'étapes par une timeline verticale à blocs
// couleur par filtre, drag & drop, drawer d'édition, résumé.
// ═══════════════════════════════════════════════════════════════

(function () {
    const ENABLED = new URLSearchParams(location.search).get('timeline') === '1';
    if (!ENABLED) return;

    // ── Couleurs par filtre (extensible) ──────────────────────────
    const FILTER_COLORS = {
        'L': '#c0c8d0', 'R': '#ff5555', 'G': '#44dd44', 'B': '#5599ff',
        'HA': '#cc1111', 'H_A': '#cc1111', 'H-ALPHA': '#cc1111',
        'OIII': '#00cccc', 'SII': '#ff8800', 'CLEAR': '#aaaaaa',
    };
    function filterColor(f) {
        const k = (f || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        return FILTER_COLORS[k] || FILTER_COLORS[(f||'').toUpperCase()] || '#00ffcc';
    }
    function filterBg(f) { return filterColor(f); }

    // ── Inject CSS ────────────────────────────────────────────────
    const css = `
    .seq-timeline { display:flex; flex-direction:column; gap:6px; padding:4px 0; }
    .seq-timeline-block {
        display:flex; align-items:center; gap:8px;
        padding:8px 10px; border-radius:8px;
        background: rgba(0,0,0,0.25); border:1px solid var(--border-subtle);
        border-left:4px solid var(--fc, #00ffcc);
        cursor:grab; user-select:none; position:relative;
        transition: border-color .15s, background .15s, transform .12s;
    }
    .seq-timeline-block:active { cursor:grabbing; }
    .seq-timeline-block.dragging { opacity:0.45; transform:scale(0.98); }
    .seq-timeline-block.drag-over { border-color: var(--accent); background: var(--accent-faint); }
    .seq-timeline-block .seq-tl-handle { color:#666; font-size:0.7rem; cursor:grab; padding:0 2px; }
    .seq-timeline-block .seq-tl-badge {
        font-size:0.55rem; font-weight:bold; padding:2px 6px; border-radius:10px;
        background: var(--fc, #00ffcc); color:#001; min-width:38px; text-align:center;
    }
    .seq-timeline-block .seq-tl-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
    .seq-timeline-block .seq-tl-title { font-size:0.65rem; color:#ddd; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .seq-timeline-block .seq-tl-meta { font-size:0.55rem; color:#888; }
    .seq-timeline-block .seq-tl-count {
        font-size:0.7rem; font-weight:bold; color: var(--fc, #00ffcc);
        background: rgba(0,0,0,0.35); border:1px solid var(--fc, #00ffcc);
        border-radius:6px; padding:2px 6px; min-width:36px; text-align:center;
    }
    .seq-timeline-block .seq-tl-del {
        background:none; border:none; color:#666; cursor:pointer; font-size:0.85rem; padding:2px 4px; border-radius:4px;
    }
    .seq-timeline-block .seq-tl-del:hover { color:#ff6666; background: rgba(255,60,60,0.12); }
    .seq-timeline-empty {
        padding:14px; text-align:center; color:var(--text-muted); font-size:0.6rem;
        border:1px dashed var(--border-subtle); border-radius:8px; background: rgba(0,0,0,0.15);
    }
    .seq-timeline-summary {
        display:flex; gap:8px; flex-wrap:wrap; align-items:center;
        padding:6px 8px; margin-top:6px; font-size:0.6rem; color:var(--text-secondary);
        background: rgba(0,255,204,0.06); border:1px solid var(--border-subtle); border-radius:6px;
    }
    .seq-timeline-summary strong { color: var(--accent); }
    .seq-timeline-summary .dot { width:7px; height:7px; border-radius:50%; display:inline-block; vertical-align:middle; margin-right:3px; }
    /* Drawer */
    .seq-drawer-overlay {
        position:fixed; inset:0; background: rgba(0,0,0,0.55); z-index:2000;
        display:flex; align-items:center; justify-content:center;
    }
    .seq-drawer {
        background: var(--bg-panel); border:1px solid var(--border-default); border-radius:12px;
        padding:16px; width:360px; max-width:92vw; box-shadow: var(--shadow-panel);
        display:flex; flex-direction:column; gap:10px;
    }
    .seq-drawer h3 { margin:0; font-size:0.8rem; color: var(--accent); border-bottom:1px solid var(--border-subtle); padding-bottom:6px; }
    .seq-drawer .row { display:flex; gap:8px; align-items:center; font-size:0.65rem; }
    .seq-drawer .row label { width:80px; color:#aaa; }
    .seq-drawer .row input, .seq-drawer .row select { flex:1; }
    .seq-drawer .actions { display:flex; gap:8px; justify-content:flex-end; padding-top:6px; border-top:1px solid var(--border-subtle); }
    .seq-timeline-flag {
        position:fixed; top:6px; right:12px; z-index:3000;
        font-size:0.55rem; color:#001; background:#00ffcc; padding:2px 8px; border-radius:10px; letter-spacing:0.04em;
    }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Flag visuel
    const flag = document.createElement('div');
    flag.className = 'seq-timeline-flag';
    flag.textContent = 'TIMELINE POC (?timeline=1)';
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(flag));
    if (document.readyState !== 'loading') document.body.appendChild(flag);

    // ── Remplace le rendu d'étape par des blocs ───────────────────
    // seqRenderStep est global (sequence.js). On le monkey-patch.
    function patchWhenReady() {
        if (typeof seqRenderStep !== 'function' || typeof seqRenderTargetDetail !== 'function') {
            setTimeout(patchWhenReady, 50);
            return;
        }

        const _origRenderStep = window.seqRenderStep;
        const _origRenderDetail = window.seqRenderTargetDetail;

        // Nouveau rendu d'une étape -> bloc timeline
        window.seqRenderStep = function (target, step, idx, running) {
            const col = filterBg(step.filter);
            const dur = parseFloat(step.duration) || 0;
            const cnt = parseInt(step.count) || 1;
            const total = dur * cnt;
            const label = `${step.frame_type || 'LIGHT'} · ${dur}s ${step.filter ? '· ' + escapeAttr(step.filter) : ''}`;
            const meta = `${cnt > 1 ? cnt + '× ' : ''}${seqFormatTime ? seqFormatTime(total) : total + 's'}${step.delay ? ' + pause ' + step.delay + 's' : ''}`;
            const disabled = running ? ' data-disabled="1" style="opacity:0.55;pointer-events:none;"' : '';
            // On génère du HTML qui sera inséré dans .seq-steps-list ; on ajoute des data- attrs pour le drag/drawer
            return `
            <div class="seq-timeline-block" draggable="${running ? 'false' : 'true'}" data-idx="${idx}" data-step-id="${step.id}" style="--fc:${col};"${disabled}>
                <span class="seq-tl-handle" title="Glisser pour réordonner">⋮⋮</span>
                <span class="seq-tl-badge">${escapeAttr(step.frame_type || 'LIGHT')}</span>
                <div class="seq-tl-main">
                    <div class="seq-tl-title">${escapeAttr(label)}</div>
                    <div class="seq-tl-meta">${escapeAttr(meta)}</div>
                </div>
                <span class="seq-tl-count" title="Nombre de poses">×${cnt}</span>
                <button class="seq-tl-del" data-idx="${idx}" title="Supprimer">✕</button>
            </div>`;
        };

        // Patch du détail cible : wrap la liste en .seq-timeline + résumé
        window.seqRenderTargetDetail = function () {
            const res = _origRenderDetail.apply(this, arguments);
            // L'original a déjà rempli #seq-target-detail avec .seq-steps-list
            const t = (typeof seqData !== 'undefined' && typeof seqSelectedTargetId !== 'undefined')
                ? seqData.targets.find(x => x.id === seqSelectedTargetId) : null;
            const det = document.getElementById('seq-target-detail');
            if (!det) return res;

            // Transforme .seq-steps-list en .seq-timeline
            const list = det.querySelector('.seq-steps-list');
            if (list) {
                list.classList.add('seq-timeline');
                list.classList.remove('seq-steps-list');
                if (t && !t.steps.length) {
                    list.innerHTML = '<div class="seq-timeline-empty">Aucune étape — cliquez ＋ Ajouter</div>';
                }
                // Inject résumé sous la liste
                let summ = det.querySelector('.seq-timeline-summary');
                if (!summ) {
                    summ = document.createElement('div');
                    summ.className = 'seq-timeline-summary';
                    list.after(summ);
                }
                if (t) {
                    const totalPoses = t.steps.reduce((s, s2) => s + (parseInt(s2.count) || 1), 0);
                    const totalSec = t.steps.reduce((s, s2) => s + (parseFloat(s2.duration) || 0) * (parseInt(s2.count) || 1), 0);
                    const byFilter = {};
                    t.steps.forEach(s2 => {
                        const f = (s2.filter || '—').trim() || '—';
                        byFilter[f] = (byFilter[f] || 0) + (parseInt(s2.count) || 1);
                    });
                    const chips = Object.entries(byFilter).map(([f, n]) =>
                        `<span><i class="dot" style="background:${filterColor(f === '—' ? '' : f)}"></i>${escapeAttr(f)}×${n}</span>`).join(' · ');
                    summ.innerHTML = `<span><strong>${totalPoses}</strong> poses</span> · <span><strong>${seqFormatTime ? seqFormatTime(totalSec) : totalSec + 's'}</strong></span> ${chips ? '· ' + chips : ''}`;
                }
                // Hook drag & click
                bindTimelineInteractions(t, list);
            }

            // Masque le catalogue/mosaïque en accordéon réduit si timeline (allège la densité)
            // On ne supprime rien, on replie juste la mosaïque si désactivée
            return res;
        };

        // Si un détail est déjà affiché, re-render pour appliquer le patch
        if (typeof seqSelectedTargetId !== 'undefined' && seqSelectedTargetId != null) {
            try { window.seqRenderTargetDetail(); } catch (e) { console.debug('timeline initial re-render', e); }
        }
        console.info('[timeline] POC actif (?timeline=1) — blocs, drag, drawer.');
    }

    let dragSrcIdx = null;

    function bindTimelineInteractions(target, listEl) {
        if (!target || !listEl) return;
        // Éviter double bind
        if (listEl.dataset.tlBound === '1') return;
        listEl.dataset.tlBound = '1';

        listEl.addEventListener('click', (e) => {
            const del = e.target.closest('.seq-tl-del');
            if (del) {
                const idx = parseInt(del.dataset.idx);
                if (!isNaN(idx) && target.steps[idx]) {
                    target.steps.splice(idx, 1);
                    if (!target.steps.length) target.steps.push(typeof seqNewStep === 'function' ? seqNewStep() : { id: Date.now() + Math.random(), frame_type: 'LIGHT', duration: 60, filter: '', count: 1, delay: 1 });
                    seqRenderTargetDetail();
                    if (typeof seqRenderTargetList === 'function') seqRenderTargetList();
                }
                return;
            }
            const block = e.target.closest('.seq-timeline-block');
            if (block && block.dataset.idx != null) {
                const idx = parseInt(block.dataset.idx);
                const step = target.steps[idx];
                if (step) openDrawer(target, step, idx);
            }
        });

        listEl.addEventListener('dragstart', (e) => {
            const block = e.target.closest('.seq-timeline-block');
            if (!block) return;
            dragSrcIdx = parseInt(block.dataset.idx);
            block.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(dragSrcIdx)); } catch (_) {}
        });
        listEl.addEventListener('dragend', (e) => {
            const b = e.target.closest('.seq-timeline-block');
            if (b) b.classList.remove('dragging');
            listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
        listEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            const block = e.target.closest('.seq-timeline-block');
            if (!block) return;
            block.classList.add('drag-over');
        });
        listEl.addEventListener('dragleave', (e) => {
            const block = e.target.closest('.seq-timeline-block');
            if (block) block.classList.remove('drag-over');
        });
        listEl.addEventListener('drop', (e) => {
            e.preventDefault();
            const over = e.target.closest('.seq-timeline-block');
            if (over == null || dragSrcIdx == null) return;
            const dstIdx = parseInt(over.dataset.idx);
            if (isNaN(dstIdx) || dstIdx === dragSrcIdx) return;
            const [moved] = target.steps.splice(dragSrcIdx, 1);
            target.steps.splice(dstIdx, 0, moved);
            dragSrcIdx = null;
            seqRenderTargetDetail();
            if (typeof seqRenderTargetList === 'function') seqRenderTargetList();
        });
    }

    function openDrawer(target, step, idx) {
        // Fermer ancien
        const prev = document.querySelector('.seq-drawer-overlay');
        if (prev) prev.remove();

        const overlay = document.createElement('div');
        overlay.className = 'seq-drawer-overlay';
        overlay.innerHTML = `
            <div class="seq-drawer" role="dialog" aria-modal="true">
                <h3>Étape ${idx + 1} — ${escapeAttr(step.frame_type || 'LIGHT')}</h3>
                <div class="row"><label>Type</label>
                    <select class="d-field" data-field="frame_type">
                        ${['LIGHT','DARK','BIAS','FLAT'].map(t => `<option ${step.frame_type===t?'selected':''}>${t}</option>`).join('')}
                    </select>
                </div>
                <div class="row"><label>Durée (s)</label><input class="d-field" data-field="duration" type="number" min="0.1" step="0.5" value="${step.duration}"></div>
                <div class="row"><label>Filtre</label><input class="d-field" data-field="filter" type="text" placeholder="L, R, Ha…" value="${escapeAttr(step.filter||'')}"></div>
                <div class="row"><label>× poses</label><input class="d-field" data-field="count" type="number" min="1" step="1" value="${step.count}"></div>
                <div class="row"><label>Pause (s)</label><input class="d-field" data-field="delay" type="number" min="0" step="0.5" value="${step.delay||0}"></div>
                <div class="row"><label>Gain</label><input class="d-field" data-field="gain" type="number" step="1" value="${step.gain ?? -1}" title="-1 = défaut caméra"></div>
                <div class="row"><label>Binning</label><input class="d-field" data-field="binning" type="number" min="1" max="4" step="1" value="${step.binning||1}"></div>
                <div class="actions">
                    <button class="btn-glass" data-act="cancel">Annuler</button>
                    <button class="btn-glass success" data-act="save">Enregistrer</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
        overlay.querySelector('[data-act="save"]').addEventListener('click', () => {
            overlay.querySelectorAll('.d-field').forEach(el => {
                const f = el.dataset.field;
                let v = el.value;
                if (f === 'duration' || f === 'delay') step[f] = parseFloat(v) || 0;
                else if (f === 'count' || f === 'gain' || f === 'binning') step[f] = parseInt(v);
                else step[f] = v;
            });
            close();
            seqRenderTargetDetail();
            if (typeof seqRenderTargetList === 'function') seqRenderTargetList();
        });
        // ESC
        const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    }

    // Lancer patch dès que possible
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', patchWhenReady);
    } else {
        patchWhenReady();
    }

    // Expose pour debug
    window.__timelinePOC = { filterColor, enabled: ENABLED };
})();
