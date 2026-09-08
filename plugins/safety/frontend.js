// safety frontend — panneau Safety (P2) + bandeau
(function(){
  const ID='applet-safety';
  function ensure(){
    if(document.getElementById(ID)) return;
    const layer=document.getElementById('applets-layer')||document.body;
    const el=document.createElement('div');
    el.id=ID; el.className='glass-panel applet mode-specific';
    el.dataset.modes='capture,sequencer'; el.style.cssText='display:none; top:16px; right:16px; width:280px;';
    el.innerHTML=`
      <div class="applet-drag"><span class="drag-icon">⣿⣿</span><span class="hud-title" style="margin:0;border:none;padding:0;font-size:0.7rem;">⚠ SAFETY</span><button class="applet-minimize"></button></div>
      <div style="padding:6px 8px;">
        <div class="solver-row" style="justify-content:space-between;"><span style="font-size:0.6rem;color:#aaa;">État</span><span id="safety-state" style="font-size:0.6rem;font-weight:bold;">—</span></div>
        <div id="safety-reason" style="font-size:0.55rem;color:#888; margin-top:4px; white-space:normal;">—</div>
        <div class="solver-row" style="gap:4px; margin-top:6px;">
          <button id="safety-test" class="btn-glass warning" style="flex:1;font-size:0.6rem;">Test Unsafe</button>
          <button id="safety-refresh" class="btn-glass" style="flex:0;font-size:0.6rem;">⟳</button>
        </div>
        <div id="safety-trans" style="font-size:0.5rem;color:#666; max-height:80px; overflow-y:auto; margin-top:6px;"></div>
      </div>`;
    layer.appendChild(el);
    document.getElementById('safety-test')?.addEventListener('click', async()=>{
      if(!confirm('Test Unsafe → Stop→Park→Alert ?')) return;
      await fetch('/api/safety/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'manual test'})});
      refresh();
    });
    document.getElementById('safety-refresh')?.addEventListener('click', refresh);
    if(window.Hub) Hub.subscribe('ws:state','safety', refresh);
    refresh();
  }
  async function refresh(){
    try{
      const r=await fetch('/api/safety/status').then(x=>x.json());
      const st=document.getElementById('safety-state');
      const rs=document.getElementById('safety-reason');
      const tr=document.getElementById('safety-trans');
      if(!r.ok) return;
      const col = r.state==='monitoring' ? '#44cc44' : r.state==='waiting_safe' ? '#ffaa00' : '#ff4444';
      if(st){ st.textContent=r.state; st.style.color=col; }
      if(rs) rs.textContent=r.reason||'—';
      if(tr) tr.innerHTML=(r.transitions||[]).slice(-6).map(t=>`${t.from}→${t.to} <span style="color:#666">${t.reason||''}</span>`).join('<br>');
    }catch(e){}
  }
  window.SafetyPanel={ensure,refresh};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', ensure); else ensure();
})();
