#!/usr/bin/env python3
"""Génère docs/bus-architecture.svg — bus conventionnel + bulle descriptive au passage du flux."""

VIEW = (1300, 850)
HW, HH = 84, 24
BUS1_Y, BUS2_Y = 360, 680
BAR_TOP1, BAR_BOT1 = BUS1_Y - 4, BUS1_Y + 4
BAR_TOP2, BAR_BOT2 = BUS2_Y - 4, BUS2_Y + 4
BAR_X0, BAR_X1 = 60, 1230
FLOW_X1 = BAR_X1 - 22

DOMAIN_COLOR = {
    'system': '#4488ff', 'acquisition': '#44cc88', 'astrometry': '#ffaa44',
    'guidance': '#ff6644', 'orchestration': '#00ffcc',
}

DESC = {
    'ws': 'Reçoit l\'état INDIGO via WebSocket et le publie sur le bus',
    'objects': 'Recherche d\'objets, config site et heure',
    'hardware': 'Devices, connexions et profils matériel',
    'mount': 'Commandes monture : slew, park, tracking',
    'api': 'Logs, toasts et appels API',
    'capture': 'Lance les poses, émet capture:progress',
    'sequence': 'Plan d\'acquisition multi-poses',
    'stacking': 'Empile les poses en direct',
    'preview': 'FITS, aperçus, overlays, étoile guide',
    'solver': 'Résout l\'image, publie solver:result',
    'target': 'Centrage automatique de la cible',
    'polar': 'Alignement polaire en 3 points',
    'guide': 'Autoguidage : boucle, dérive, RMS',
    'calibration': 'Calibre la monture, annonce calibration:done',
    'focuser': 'Mise au point et autofocus (V-curve)',
    'app': 'Orchestre modes, init et ciel (sky)',
    'state': 'État global partagé : devices, uiConfig, modes',
}

NODES = {
    'ws':          (160, 225, 1, 'above', 'system',        'WebSocket · devices'),
    'capture':     (430, 225, 1, 'above', 'acquisition',   'prise de vue'),
    'calibration': (700, 225, 1, 'above', 'guidance',      'calibration monture'),
    'app':         (900, 225, 1, 'above', 'orchestration', 'modes · init · sky'),
    'objects':     (270, 495, 1, 'below', 'system',        'search · site · time'),
    'hardware':    (560, 495, 1, 'below', 'system',        'panneau · profils'),
    'stacking':    (830, 495, 1, 'below', 'acquisition',   'live stacking'),
    'state':       (1090, 495, 1, 'below', 'orchestration', 'état global partagé'),
    'preview':     (170, 555, 2, 'above', 'acquisition',   'FITS · overlays'),
    'solver':      (430, 555, 2, 'above', 'astrometry',    'plate solve'),
    'mount':       (700, 555, 2, 'above', 'system',        'commandes monture'),
    'guide':       (950, 555, 2, 'above', 'guidance',      'autoguidage'),
    'sequence':    (270, 790, 2, 'below', 'acquisition',   'multi-poses'),
    'target':      (560, 790, 2, 'below', 'astrometry',    'centrage cible'),
    'polar':       (830, 790, 2, 'below', 'astrometry',    'alignement polaire'),
    'focuser':     (1030, 790, 2, 'below', 'guidance',     'focuser · autofocus'),
    'api':         (1210, 790, 2, 'below', 'system',       'addLog · API'),
}

TOPICS = [
    ('t_ws_state', 'ws:state', 'ws', ['mount', 'capture', 'focuser', 'solver', 'guide', 'hardware'], '#4488ff', '{ devices }'),
    ('t_ws_image', 'ws:image', 'ws', ['preview'], '#44cc88', '{ device, format, b64 }'),
    ('t_ws_log',   'ws:log',   'ws', ['api'], '#9aa3b2', '{ level, logger, msg }'),
    ('t_solver_result', 'solver:result', 'solver', ['target', 'preview'], '#ffaa44', '{ result }'),
    ('t_mode_changed', 'mode:changed', 'app', ['solver', 'hardware'], '#ffcc55', '{ mode }'),
    ('t_calibration_done', 'calibration:done', 'calibration', ['app', 'guide'], '#ff6644', '{ quality, gains }'),
    ('t_capture_progress', 'capture:progress', 'capture', ['sequence', 'stacking', 'app'], '#7ee08a', '{ done, total, last }'),
    ('t_guide_star', 'guide:starSelected', 'preview', ['guide'], '#cc88ff', '{ star }'),
    ('t_mount_slewed', 'mount:slewed', 'mount', ['target'], '#66bbff', '{ ra, dec }'),
]

TAG_POS = {
    't_ws_state': (1, 160), 't_ws_image': (1, 250), 't_ws_log': (1, 340),
    't_capture_progress': (1, 430), 't_calibration_done': (1, 700), 't_mode_changed': (1, 900),
    't_solver_result': (2, 430), 't_mount_slewed': (2, 700), 't_guide_star': (2, 950),
}

topic_classes = {}
for tid, topic, prod, cons, color, payload in TOPICS:
    topic_classes.setdefault(tid, set()).update([prod] + list(cons))

# ── MODULES map pour le JS (position + description) ────────────
js_modules = "\n".join(
    "    {name}: {{ cx: {cx}, cy: {cy}, bus: {bus}, name: '{name}.js', desc: '{desc}' }},"
    .format(name=name, cx=cx, cy=cy, bus=bus, desc=DESC[name].replace("'", "\\'"))
    for name, (cx, cy, bus, side, dom, sub) in NODES.items())

markers = "\n".join(
    '<marker id="m_{tid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
    'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 10 0 z" fill="{color}"/></marker>'
    .format(tid=tid, color=color)
    for (tid, topic, prod, cons, color, payload) in TOPICS)

nodes = []
stubs = []
for name, (cx, cy, bus, side, dom, sub) in NODES.items():
    color = DOMAIN_COLOR[dom]
    tops = sorted(tid for tid, s in topic_classes.items() if name in s)
    nodes.append(
        '<g class="node {cls}" data-module="{name}" data-topics="{ts}" '
        'transform="translate({x} {y})">'
        '<rect width="{w}" height="{h}" stroke="{color}"/>'
        '<text x="{hw}" y="{hh}" text-anchor="middle" class="n">{name}.js</text>'
        '<text x="{hw}" y="{hh2}" text-anchor="middle" class="s">{sub}</text></g>'
        .format(cls=' '.join(tops), name=name, ts=' '.join(tops),
                x=cx - HW, y=cy - HH, w=HW * 2, h=HH * 2, hw=HW, hh=HH - 5, hh2=HH + 12,
                color=color, sub=sub))
    y1 = cy + HH if side == 'above' else cy - HH
    y2 = BAR_TOP1 if (bus == 1 and side == 'above') else BAR_BOT1 if bus == 1 else BAR_TOP2 if side == 'above' else BAR_BOT2
    stubs.append(
        '<line class="stub {ts}" data-module="{name}" data-topics="{ts}" '
        'x1="{cx}" y1="{y1}" x2="{cx}" y2="{y2}" stroke="#3a4558"/>'
        .format(ts=' '.join(tops), name=name, cx=cx, y1=y1, y2=y2))

tags = []
for tid, topic, prod, cons, color, payload in TOPICS:
    bus, tx = TAG_POS[tid]
    bar_y = BUS1_Y if bus == 1 else BUS2_Y
    w = 14 + len(topic) * 6.6
    tag_y = bar_y + 20
    tags.append(
        '<g class="tag-pill" data-topic="{tid}" data-color="{color}" '
        'data-info="{topic} — producteur {prod} → {cons} — payload {payload}" '
        'transform="translate({tx} {tag_y})">'
        '<line class="tick" x1="0" y1="{ty}" x2="0" y2="0" stroke="{color}"/>'
        '<rect x="{x}" y="-9" width="{w}" height="16" rx="8" stroke="{color}"/>'
        '<circle cx="{dot}" cy="0" r="3" fill="{color}"/>'
        '<text x="{tx2}" y="3">{topic}</text></g>'
        .format(tid=tid, topic=topic, prod=prod, cons=', '.join(cons), payload=payload, color=color,
                tx=tx, tag_y=tag_y, ty=0, x=-w / 2, w=w, dot=-w / 2 + 7, tx2=-w / 2 + 15))

bars = []
for y, label in ((BUS1_Y, 'BUS — events.js'), (BUS2_Y, 'BUS — events.js (suite)')):
    x1 = BAR_X1 - 22
    w = x1 - BAR_X0
    bars.append(
        '<g class="busbar">'
        '<rect x="{x0}" y="{y}" width="{w}" height="8" rx="4" fill="#0a3f40" stroke="#00e5ff" stroke-width="1.4"/>'
        '<line class="busflow" x1="{x0}" y1="{yf}" x2="{x1}" y2="{yf}" stroke="#00e5ff" stroke-width="2"/>'
        '<polygon points="{x1},{y} {xh},{yf} {x1},{yh}" fill="#00e5ff"/>'
        '<text x="70" y="{yt}" font-size="10" fill="#00e5ff">{label}</text></g>'
        .format(x0=BAR_X0, x1=x1, xh=x1 + 22, w=w, y=y, yf=y + 4, yh=y + 8, yt=y - 8, label=label))

cont = ('<line class="cont" x1="1258" y1="{y1}" x2="1258" y2="{y2}" '
        'stroke="#00e5ff" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#m_cont)"/>'
        '<text x="1244" y="522" text-anchor="end" font-size="9.5" fill="#00e5ff">continuation</text>'
        .format(y1=BAR_BOT1 + 2, y2=BAR_TOP2 - 2))

legend = "\n".join(
    '<g class="legend-item" data-topic="{tid}" data-color="{color}" '
    'data-info="{topic} — producteur {prod} → {cons} — payload {payload}" '
    'transform="translate(0 {y})">'
    '<rect width="195" height="24" rx="5" stroke="{color}"/>'
    '<circle cx="12" cy="12" r="4.5" fill="{color}"/>'
    '<text x="24" y="16">{topic}</text></g>'
    .format(tid=tid, topic=topic, prod=prod, cons=', '.join(cons), payload=payload,
            y=80 + i * 30, color=color)
    for i, (tid, topic, prod, cons, color, payload) in enumerate(TOPICS))

CSS = """
    .node { cursor:pointer; transition: opacity .25s; }
    .node rect { fill:#131722; stroke-width:1.6; rx:9; }
    .node .n { fill:#e8ecf4; font-size:14px; font-weight:bold; }
    .node .s { fill:#7a8598; font-size:9px; }
    .node.active rect { filter: drop-shadow(0 0 7px currentColor); }
    .node.dim, .stub.dim, .tag-pill.dim, .legend-item.dim { opacity:.12; }
    .node.buspass rect { stroke-width:2.8; filter: drop-shadow(0 0 9px #00e5ff); }
    .stub { transition: opacity .25s; }
    .stub.active { stroke-width:2.5; }
    .busbar { pointer-events:none; }
    .busflow { opacity:.35; }
    .flow .busflow { stroke-dasharray:14 10; animation: dash 1.2s linear infinite; }
    @keyframes dash { to { stroke-dashoffset:-24; } }
    .msg-marker { visibility:hidden; pointer-events:none; filter: drop-shadow(0 0 6px #00e5ff); }
    .flow .msg-marker { visibility:visible; }
    #bubble { visibility:hidden; pointer-events:none; }
    #bubble.show { visibility:visible; }
    #bubble-rect { fill:#141b2a; fill-opacity:.97; stroke:#00e5ff; stroke-width:1.2; rx:8; }
    #bubble-pointer { fill:#141b2a; stroke:#00e5ff; stroke-width:1; }
    #bubble-name { fill:#e8ecf4; font-size:12px; font-weight:bold; }
    #bubble-desc { fill:#9fb0c8; font-size:9.5px; }
    .tag-pill { cursor:pointer; transition: opacity .25s; }
    .tag-pill rect { fill:#10141d; }
    .tag-pill text { font-size:10px; fill:#c6cedd; }
    .tag-pill.active rect { fill:#1a2333; }
    .cont { pointer-events:none; }
    .legend-item { cursor:pointer; transition: opacity .25s; }
    .legend-item rect { fill:#10141d; stroke-width:1; rx:5; }
    .legend-item text { font-size:11px; fill:#c6cedd; }
    .legend-item.active rect { stroke-width:1.6; }
    .legend-title { font-size:12px; font-weight:bold; fill:#e8ecf4; }
    .btn { cursor:pointer; }
    .btn rect { fill:#151b28; stroke:#2a3550; stroke-width:1; rx:6; }
    .btn text { font-size:12px; fill:#00ffcc; }
    .btn:hover rect { fill:#1c2436; }
    #info-bar rect { fill:#10141d; stroke:#2a3550; stroke-width:1; rx:8; }
    #info-text { font-size:12.5px; fill:#d7dde8; }
"""

JS_TEMPLATE = """
(function () {
  var svg = document.getElementById('bus-svg');
  var nodes = Array.prototype.slice.call(svg.querySelectorAll('.node'));
  var stubs = Array.prototype.slice.call(svg.querySelectorAll('.stub'));
  var tags = Array.prototype.slice.call(svg.querySelectorAll('.tag-pill'));
  var legend = Array.prototype.slice.call(svg.querySelectorAll('.legend-item'));
  var infoText = document.getElementById('info-text');
  var marker = document.getElementById('msg-marker');
  var bubble = document.getElementById('bubble');
  var bubbleRect = document.getElementById('bubble-rect');
  var bubblePointer = document.getElementById('bubble-pointer');
  var bubbleName = document.getElementById('bubble-name');
  var bubbleDesc = document.getElementById('bubble-desc');
  var raf = null, lastMod = null;

  var X0 = 60, X1 = 1208, Y1 = 364, Y2 = 684, CX = 1258;
  var MODULES = {
@@MODULES@@
  };

  var TOPICS = {
    t_ws_state: { prod: 'ws', cons: ['mount','capture','focuser','solver','guide','hardware'], color: '#4488ff', topic: 'ws:state' },
    t_ws_image: { prod: 'ws', cons: ['preview'], color: '#44cc88', topic: 'ws:image' },
    t_ws_log:   { prod: 'ws', cons: ['api'], color: '#9aa3b2', topic: 'ws:log' },
    t_solver_result: { prod: 'solver', cons: ['target','preview'], color: '#ffaa44', topic: 'solver:result' },
    t_mode_changed: { prod: 'app', cons: ['solver','hardware'], color: '#ffcc55', topic: 'mode:changed' },
    t_calibration_done: { prod: 'calibration', cons: ['app','guide'], color: '#ff6644', topic: 'calibration:done' },
    t_capture_progress: { prod: 'capture', cons: ['sequence','stacking','app'], color: '#7ee08a', topic: 'capture:progress' },
    t_guide_star: { prod: 'preview', cons: ['guide'], color: '#cc88ff', topic: 'guide:starSelected' },
    t_mount_slewed: { prod: 'mount', cons: ['target'], color: '#66bbff', topic: 'mount:slewed' }
  };

  function setState(el, active) {
    el.classList.toggle('active', active);
    el.classList.toggle('dim', !active);
  }
  function involvedModules(tids) {
    var set = {};
    tids.forEach(function (t) {
      var info = TOPICS[t];
      if (!info) return;
      set[info.prod] = true;
      info.cons.forEach(function (c) { set[c] = true; });
    });
    return set;
  }
  function focusTopic(tid) {
    var info = TOPICS[tid], involved = {};
    involved[info.prod] = true;
    info.cons.forEach(function (c) { involved[c] = true; });
    nodes.forEach(function (n) {
      setState(n, !!involved[n.getAttribute('data-module')]);
    });
    stubs.forEach(function (s) {
      var active = !!involved[s.getAttribute('data-module')];
      setState(s, active);
      s.style.stroke = active ? info.color : '';
    });
    tags.forEach(function (t) { setState(t, t.getAttribute('data-topic') === tid); });
    legend.forEach(function (l) { setState(l, l.getAttribute('data-topic') === tid); });
  }
  function focusModule(name) {
    var tids = [];
    nodes.forEach(function (n) {
      if (n.getAttribute('data-module') === name) tids = n.getAttribute('data-topics').split(' ');
    });
    var involved = involvedModules(tids);
    nodes.forEach(function (n) { setState(n, !!involved[n.getAttribute('data-module')]); });
    stubs.forEach(function (s) {
      var active = !!involved[s.getAttribute('data-module')];
      setState(s, active);
      s.style.stroke = active ? '#00ffcc' : '';
    });
    tags.forEach(function (t) { setState(t, tids.indexOf(t.getAttribute('data-topic')) >= 0); });
    legend.forEach(function (l) { setState(l, tids.indexOf(l.getAttribute('data-topic')) >= 0); });
  }
  function clear() {
    nodes.concat(stubs, tags, legend).forEach(function (el) {
      el.classList.remove('active', 'dim');
      if (el.style) el.style.stroke = '';
    });
    bubble.classList.remove('show');
    if (svg.classList.contains('flow') && lastMod) bubbleFor(lastMod);
  }
  function bind(els, enter, leave) {
    els.forEach(function (el) {
      el.addEventListener('mouseenter', enter);
      el.addEventListener('mouseleave', leave);
    });
  }
  bind(nodes, function () {
    var name = this.getAttribute('data-module');
    focusModule(name);
    bubbleFor(name);
    infoText.textContent = 'module ' + name + '.js — émet/écoute : ' + this.getAttribute('data-topics').split(' ').join(', ');
  }, clear);
  bind(stubs, function () {
    var name = this.getAttribute('data-module');
    focusModule(name);
    bubbleFor(name);
    infoText.textContent = 'module ' + name + '.js — connecté au bus';
  }, clear);
  bind(tags, function () {
    var tid = this.getAttribute('data-topic');
    focusTopic(tid);
    infoText.textContent = this.getAttribute('data-info');
  }, clear);
  bind(legend, function () {
    var tid = this.getAttribute('data-topic');
    focusTopic(tid);
    infoText.textContent = this.getAttribute('data-info');
  }, clear);

  function bubbleFor(name) {
    var m = MODULES[name];
    if (!m) return;
    var W = 230, PAD = 12, LINE = 12, CHAR_W = 5.8;
    var words = m.desc.split(' '), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (t.length * CHAR_W <= W - 2 * PAD) cur = t;
      else { if (cur) lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    var H = 30 + lines.length * LINE + 7;
    var x = Math.max(0, Math.min(m.cx - W / 2, 1300 - W));
    var y = m.cy - 24 - (H + 7);
    bubbleName.textContent = m.name;
    bubbleDesc.textContent = '';
    lines.forEach(function (ln, i) {
      var tsp = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      tsp.setAttribute('x', PAD);
      tsp.setAttribute('y', 31 + i * LINE);
      tsp.textContent = ln;
      bubbleDesc.appendChild(tsp);
    });
    bubbleRect.setAttribute('width', W);
    bubbleRect.setAttribute('height', H);
    bubblePointer.setAttribute('points', (W/2 - 7) + ',' + H + ' ' + (W/2) + ',' + (H + 7) + ' ' + (W/2 + 7) + ',' + H);
    bubble.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
    bubble.classList.add('show');
  }
  function flowLoop(ts) {
    if (!svg.classList.contains('flow')) { raf = null; return; }
    var t = ((ts % 4200) / 4200);
    var x, y, bus = 0;
    if (t < 0.45) { bus = 1; x = X0 + (X1 - X0) * (t / 0.45); y = Y1; }
    else if (t < 0.55) { bus = 0; x = CX; y = Y1 + (Y2 - Y1) * ((t - 0.45) / 0.10); }
    else { bus = 2; x = X0 + (X1 - X0) * ((t - 0.55) / 0.45); y = Y2; }
    marker.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
    var hit = null, best = 1e9;
    if (bus) {
      for (var name in MODULES) {
        var m = MODULES[name];
        if (m.bus !== bus) continue;
        var d = Math.abs(m.cx - x);
        if (d < 92 && d < best) { best = d; hit = name; }
      }
    }
    if (hit !== lastMod) {
      if (lastMod) document.querySelector('[data-module="' + lastMod + '"]').classList.remove('buspass');
      if (hit) {
        document.querySelector('[data-module="' + hit + '"]').classList.add('buspass');
        bubbleFor(hit);
      } else {
        bubble.classList.remove('show');
      }
      lastMod = hit;
    }
    raf = requestAnimationFrame(flowLoop);
  }
  function stopFlow() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    bubble.classList.remove('show');
    if (lastMod) { document.querySelector('[data-module="' + lastMod + '"]').classList.remove('buspass'); lastMod = null; }
  }
  document.getElementById('btn-animate').addEventListener('click', function () {
    var on = svg.classList.toggle('flow');
    document.getElementById('btn-animate-text').textContent = on ? '\u23F8 Pause' : '\u25B6 Animer le flux';
    if (on) { if (!raf) raf = requestAnimationFrame(flowLoop); }
    else stopFlow();
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    clear();
    infoText.textContent = 'Survolez un module, une étiquette de topic ou la légende pour afficher les détails.';
  });
})();
"""

JS = JS_TEMPLATE.replace('@@MODULES@@', js_modules)

svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg id="bus-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VW} {VH}"
     font-family="ui-monospace, Menlo, Consolas, monospace" role="img"
     aria-label="Bus de messages Noctua — modules connectés à un bus horizontal">
  <title>Bus de messages — Noctua</title>
  <style>{CSS}</style>
  <defs>
    <marker id="m_cont" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6"
            orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#00e5ff"/></marker>
{markers}
  </defs>
  <rect class="bg" width="{VW}" height="{VH}" rx="10" fill="#0b0e14"/>

  <text x="26" y="34" font-size="17" font-weight="bold" fill="#e8ecf4">Bus de messages — Noctua</text>
  <text x="26" y="54" font-size="10.5" fill="#7a8598">Survolez un module, une étiquette ou la légende — « Animer » : le flux déclenche une bulle sur chaque module.</text>

  {bars}

  {cont}

  {stubs}

  {tags}

  {nodes}

  <g id="msg-marker" class="msg-marker">
    <circle r="6" fill="#00e5ff" opacity=".25"/>
    <circle r="3" fill="#eaffff"/>
  </g>

  <g id="bubble">
    <rect id="bubble-rect" x="-0" y="0" width="200" height="46" rx="8"/>
    <polygon id="bubble-pointer" points="93,46 100,53 107,46"/>
    <text id="bubble-name" x="12" y="18">module</text>
    <text id="bubble-desc" x="12" y="33">description</text>
  </g>

  <g class="btn" id="btn-animate" transform="translate(470 60)">
    <rect width="118" height="26" rx="6"/>
    <text id="btn-animate-text" x="59" y="17" text-anchor="middle">▶ Animer le flux</text>
  </g>
  <g class="btn" id="btn-reset" transform="translate(600 60)">
    <rect width="112" height="26" rx="6"/>
    <text x="56" y="17" text-anchor="middle">⟲ Réinitialiser</text>
  </g>

  <g transform="translate(1040 56)">
    <text class="legend-title" x="0" y="14">Topics (événements sur le bus)</text>
{legend}
  </g>

  <g id="info-bar" transform="translate(380 812)">
    <rect width="540" height="28" rx="8"/>
    <text id="info-text" x="12" y="18">Survolez un module, une étiquette de topic ou la légende pour afficher les détails.</text>
  </g>

  <script><![CDATA[{JS}]]></script>
</svg>
""".format(VW=VIEW[0], VH=VIEW[1], CSS=CSS, markers=markers, bars="\n  ".join(bars),
           cont=cont, stubs="\n  ".join(stubs), tags="\n  ".join(tags), nodes="\n  ".join(nodes),
           legend=legend, JS=JS)

import os
with open(os.path.join(os.path.dirname(__file__), 'bus-architecture.svg'), 'w', encoding='utf-8') as f:
    f.write(svg)
print('OK — docs/bus-architecture.svg')
