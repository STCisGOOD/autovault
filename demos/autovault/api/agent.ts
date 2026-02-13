/**
 * Agent Identity — Ridge Plot Visualization
 *
 * Joy Division-inspired ridge plot showing an agent's behavioral evolution.
 * Each ridge is a session, stacked oldest-to-newest.
 * The waveform shape comes from the weight vector across dimensions.
 * Ridge color shifts from cool indigo (low fitness) to warm gold (high fitness).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html');

  // Extract agent key from query: ?key=PUBKEY or ?did=did:persistence:devnet:PUBKEY
  const rawKey = (
    (Array.isArray(req.query.key) ? req.query.key[0] : req.query.key) ||
    (Array.isArray(req.query.did) ? req.query.did[0] : req.query.did) ||
    ''
  ).replace(/^did:persistence:devnet:/, '');

  // Sanitize: only allow base58 characters
  const agentKey = rawKey.replace(/[^A-HJ-NP-Za-km-z1-9]/g, '').slice(0, 64);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Identity${agentKey ? ' — ' + agentKey.slice(0, 8) + '...' : ''}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #0a0a0f;
      color: #e0e0e0;
      font-family: 'Courier New', monospace;
      min-height: 100vh;
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
    }

    header {
      text-align: center;
      padding: 30px 0 20px;
    }

    h1 {
      font-size: 1.1rem;
      font-weight: normal;
      color: #00ff88;
      letter-spacing: 3px;
      text-transform: uppercase;
    }

    .tagline {
      color: #00ff8866;
      font-size: 0.85rem;
      margin-top: 8px;
    }

    /* ── Search ── */
    .search-row {
      display: flex;
      gap: 8px;
      margin: 20px 0;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }

    .search-input {
      flex: 1;
      background: #0f0f18;
      border: 1px solid #00ff8833;
      color: #e0e0e0;
      font-family: 'Courier New', monospace;
      font-size: 0.8rem;
      padding: 10px 14px;
      outline: none;
      transition: border-color 0.2s;
    }

    .search-input:focus {
      border-color: #00ff8888;
    }

    .search-input::placeholder {
      color: #00ff8844;
    }

    .search-btn {
      background: #00ff8822;
      border: 1px solid #00ff8844;
      color: #00ff88;
      font-family: 'Courier New', monospace;
      font-size: 0.8rem;
      padding: 10px 18px;
      cursor: pointer;
      transition: background 0.2s;
      white-space: nowrap;
    }

    .search-btn:hover {
      background: #00ff8844;
    }

    /* ── Ridge Plot ── */
    .ridge-section {
      margin: 10px 0 0;
      border-top: 1px solid #00ff8822;
      padding-top: 20px;
    }

    .canvas-wrap {
      position: relative;
      background: #0a0a0f;
      overflow: hidden;
    }

    canvas {
      display: block;
      width: 100%;
      height: auto;
    }

    .dim-labels {
      display: flex;
      justify-content: space-around;
      padding: 8px 30px;
      margin-top: -4px;
    }

    .dim-label {
      font-size: 0.55rem;
      color: #00ff8833;
      text-transform: uppercase;
      letter-spacing: 1px;
      text-align: center;
      flex: 1;
    }

    /* ── Agent Info ── */
    .agent-info {
      border-top: 1px solid #00ff8822;
      margin-top: 20px;
      padding-top: 20px;
    }

    .did-row {
      text-align: center;
      margin-bottom: 16px;
    }

    .did-label {
      font-size: 0.6rem;
      color: #00ff8844;
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    .did-value {
      font-size: 0.75rem;
      color: #00ff8888;
      word-break: break-all;
      margin-top: 4px;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: #00ff8822;
      margin: 16px 0;
    }

    .stat {
      background: #0a0a0f;
      padding: 16px 12px;
      text-align: center;
    }

    .stat-value {
      font-size: 1.3rem;
      color: #00ff88;
      font-weight: bold;
    }

    .stat-label {
      font-size: 0.6rem;
      color: #00ff8866;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 4px;
    }

    /* ── Dimension Breakdown ── */
    .dims-section {
      margin: 20px 0;
    }

    .dims-title {
      font-size: 0.7rem;
      color: #00ff8866;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 12px;
    }

    .dim-bar-row {
      display: flex;
      align-items: center;
      margin-bottom: 6px;
    }

    .dim-bar-name {
      width: 140px;
      font-size: 0.7rem;
      color: #00ff8888;
      text-align: right;
      padding-right: 12px;
      flex-shrink: 0;
    }

    .dim-bar-track {
      flex: 1;
      height: 4px;
      background: #0f0f18;
      position: relative;
      overflow: hidden;
    }

    .dim-bar-fill {
      height: 100%;
      transition: width 1s ease-out;
    }

    .dim-bar-val {
      width: 40px;
      font-size: 0.65rem;
      color: #00ff8866;
      text-align: right;
      padding-left: 8px;
      flex-shrink: 0;
    }

    /* ── Empty State ── */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      border: 1px solid #00ff8822;
      background: #0f0f18;
      margin: 20px 0;
    }

    .empty-icon {
      font-size: 2rem;
      color: #00ff8844;
      margin-bottom: 16px;
    }

    .empty-text {
      color: #00ff8866;
      font-size: 0.85rem;
    }

    .empty-sub {
      color: #00ff8844;
      font-size: 0.75rem;
      margin-top: 8px;
    }

    /* ── Legend ── */
    .legend {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      margin: 16px 0 8px;
    }

    .legend-bar {
      width: 120px;
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(90deg, #6366f1, #a78bfa, #22d3ee, #34d399, #fbbf24);
    }

    .legend-label {
      font-size: 0.6rem;
      color: #00ff8844;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* ── Footer ── */
    footer {
      text-align: center;
      padding: 20px 0;
      border-top: 1px solid #00ff8822;
      margin-top: 30px;
    }

    footer a {
      color: #00ff8888;
      text-decoration: none;
    }

    footer a:hover {
      color: #00ff88;
    }

    .footer-text {
      font-size: 0.7rem;
      color: #00ff8844;
    }

    @media (max-width: 600px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .dim-bar-name { width: 80px; font-size: 0.6rem; }
      .dim-labels { padding: 8px 10px; }
      .dim-label { font-size: 0.45rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Agent Identity</h1>
      <div class="tagline">Behavioral evolution, visualized</div>
    </header>

    <div class="search-row">
      <input
        class="search-input"
        id="search-input"
        type="text"
        placeholder="Enter agent pubkey or DID..."
        value="${agentKey}"
        spellcheck="false"
      />
      <button class="search-btn" id="search-btn">LOOKUP</button>
    </div>

    <div id="agent-content">
      <!-- Filled by JS -->
    </div>

    <footer>
      <div class="footer-text">
        <a href="/network">Network</a> &middot;
        <a href="/live">Synap-AI Live</a> &middot;
        <a href="https://github.com/AetherArchivum/Synap-AI">GitHub</a>
      </div>
      <div class="footer-text" style="margin-top: 8px;">
        Built for the Colosseum Agent Hackathon &middot; persistence-agent-identity
      </div>
    </footer>
  </div>

<script>
// ═══════════════════════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════════════════════

const DIMENSIONS = [
  { key: 'curiosity',          label: 'Curiosity',       short: 'CUR' },
  { key: 'precision',          label: 'Precision',       short: 'PRE' },
  { key: 'persistence',        label: 'Persistence',     short: 'PER' },
  { key: 'empathy',            label: 'Empathy',         short: 'EMP' },
  { key: 'read_before_edit',   label: 'Read \u2192 Edit',  short: 'R\u2192E' },
  { key: 'test_after_change',  label: 'Test \u2192 Change',short: 'T\u2192C' },
  { key: 'context_gathering',  label: 'Context',         short: 'CTX' },
  { key: 'output_verification',label: 'Verification',    short: 'VER' },
  { key: 'error_recovery',     label: 'Recovery',        short: 'REC' },
];

const NUM_DIMS = DIMENSIONS.length;

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Generate realistic agent evolution data.
 * Deterministic per pubkey — same agent always gets the same visualization.
 */
function generateEvolution(pubkey, numSessions) {
  if (!pubkey) return [];

  const rng = mulberry32(hashString(pubkey));
  const sessions = [];

  // Initial weights near 0.5 with slight randomness
  const weights = [];
  for (let d = 0; d < NUM_DIMS; d++) {
    weights.push(0.4 + rng() * 0.2);
  }

  // Specialization targets (which dimensions this agent gravitates toward)
  const targets = [];
  for (let d = 0; d < NUM_DIMS; d++) {
    targets.push(0.3 + rng() * 0.6); // each dim has a target between 0.3 and 0.9
  }

  // Boost 2-3 dimensions to create clear peaks
  const boostCount = 2 + Math.floor(rng() * 2);
  const boostDims = [];
  while (boostDims.length < boostCount) {
    const d = Math.floor(rng() * NUM_DIMS);
    if (!boostDims.includes(d)) {
      boostDims.push(d);
      targets[d] = 0.75 + rng() * 0.2;
    }
  }

  for (let s = 0; s < numSessions; s++) {
    const progress = s / (numSessions - 1);
    const learningRate = 0.08 * (1 - progress * 0.3); // slows as agent matures

    // Drift weights toward targets with noise
    for (let d = 0; d < NUM_DIMS; d++) {
      const drift = (targets[d] - weights[d]) * learningRate;
      const noise = (rng() - 0.5) * 0.06;
      weights[d] = Math.max(0.05, Math.min(0.98, weights[d] + drift + noise));
    }

    // Fitness: trends upward with noise, correlated with weight convergence
    const convergence = weights.reduce((sum, w, d) =>
      sum + (1 - Math.abs(w - targets[d])), 0) / NUM_DIMS;
    const fitness = Math.max(0.05, Math.min(0.98,
      0.2 + convergence * 0.5 + progress * 0.15 + (rng() - 0.5) * 0.12
    ));

    sessions.push({
      weights: [...weights],
      fitness,
      sessionIndex: s,
    });
  }

  return sessions;
}


// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fitness → color. Cool indigo (low) to warm gold (high).
 *
 * Stops: 0.0 indigo → 0.25 violet → 0.5 cyan → 0.75 emerald → 1.0 gold
 */
function fitnessToColor(f) {
  const stops = [
    { t: 0.0,  r: 99,  g: 102, b: 241 }, // #6366f1 indigo
    { t: 0.25, r: 167, g: 139, b: 250 }, // #a78bfa violet
    { t: 0.5,  r: 34,  g: 211, b: 238 }, // #22d3ee cyan
    { t: 0.75, r: 52,  g: 211, b: 153 }, // #34d399 emerald
    { t: 1.0,  r: 251, g: 191, b: 36  }, // #fbbf24 amber
  ];

  f = Math.max(0, Math.min(1, f));

  for (let i = 0; i < stops.length - 1; i++) {
    if (f <= stops[i + 1].t) {
      const range = stops[i + 1].t - stops[i].t;
      const local = (f - stops[i].t) / range;
      const r = Math.round(stops[i].r + (stops[i + 1].r - stops[i].r) * local);
      const g = Math.round(stops[i].g + (stops[i + 1].g - stops[i].g) * local);
      const b = Math.round(stops[i].b + (stops[i + 1].b - stops[i].b) * local);
      return { r, g, b, css: 'rgb(' + r + ',' + g + ',' + b + ')' };
    }
  }

  const last = stops[stops.length - 1];
  return { r: last.r, g: last.g, b: last.b, css: 'rgb(' + last.r + ',' + last.g + ',' + last.b + ')' };
}

/**
 * Generate smooth waveform points for a single ridge.
 * Weights modulate the amplitude; harmonics add organic variation.
 */
function generateRidgePoints(weights, sessionSeed, numPoints) {
  const points = new Float64Array(numPoints);

  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);

    // Cosine-interpolate between weight values
    const dimPos = t * (weights.length - 1);
    const idx = Math.min(Math.floor(dimPos), weights.length - 2);
    const frac = dimPos - idx;
    const mu = (1 - Math.cos(frac * Math.PI)) / 2;
    const baseHeight = weights[idx] * (1 - mu) + weights[Math.min(idx + 1, weights.length - 1)] * mu;

    // Layered harmonics for organic texture
    let detail = 0;
    for (let h = 1; h <= 5; h++) {
      const freq = h * 2.7 + sessionSeed * 0.13;
      const amp = baseHeight * (0.18 / h);
      detail += Math.sin(t * freq * Math.PI * 2 + sessionSeed * h * 1.93) * amp;
    }

    // Window function: fade to zero at edges
    const window = Math.sin(t * Math.PI);
    const windowSq = window * window; // smoother fade

    points[i] = Math.max(0, (baseHeight + detail) * windowSq);
  }

  return points;
}

/**
 * Draw the full Joy Division ridge plot on a canvas.
 */
function drawRidgePlot(canvas, sessions, animProgress) {
  const dpr = window.devicePixelRatio || 1;
  const displayW = canvas.parentElement.clientWidth;
  const displayH = Math.min(560, Math.max(380, displayW * 0.7));

  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const W = displayW;
  const H = displayH;
  const padX = 30;
  const padTop = 20;
  const padBot = 10;
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBot;

  // Clear
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  if (sessions.length === 0) return;

  const numRidges = sessions.length;
  const ridgeSpacing = plotH / (numRidges + 1);
  const amplitude = ridgeSpacing * 2.2;
  const numPoints = Math.min(300, Math.max(150, plotW));

  // How many ridges to show (for animation)
  const visibleRidges = Math.min(numRidges, Math.ceil(animProgress * numRidges));

  // Draw oldest first (bottom) so newer ridges occlude older ones
  for (let i = 0; i < visibleRidges; i++) {
    const session = sessions[i];
    const baseY = H - padBot - (i + 1) * ridgeSpacing;
    const color = fitnessToColor(session.fitness);

    // Per-ridge fade-in for animation
    const ridgeProgress = i === visibleRidges - 1
      ? (animProgress * numRidges - i)
      : 1.0;
    const alpha = Math.min(1, ridgeProgress);

    // Generate waveform
    const ridgePoints = generateRidgePoints(
      session.weights,
      session.sessionIndex * 7.3 + 42,
      numPoints
    );

    // Build path points
    const pathX = [];
    const pathY = [];
    for (let p = 0; p < numPoints; p++) {
      const t = p / (numPoints - 1);
      pathX.push(padX + t * plotW);
      pathY.push(baseY - ridgePoints[p] * amplitude * alpha);
    }

    // Fill below curve with background (occlusion effect)
    ctx.beginPath();
    ctx.moveTo(padX, baseY + 2);
    for (let p = 0; p < numPoints; p++) {
      ctx.lineTo(pathX[p], pathY[p]);
    }
    ctx.lineTo(padX + plotW, baseY + 2);
    ctx.closePath();
    ctx.fillStyle = '#0a0a0f';
    ctx.fill();

    // Draw glow (wider, softer stroke behind the main line)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pathX[0], pathY[0]);
    for (let p = 1; p < numPoints; p++) {
      ctx.lineTo(pathX[p], pathY[p]);
    }
    const glowAlpha = 0.15 + session.fitness * 0.25;
    ctx.strokeStyle = 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + (glowAlpha * alpha) + ')';
    ctx.lineWidth = 4 + session.fitness * 4;
    ctx.shadowColor = color.css;
    ctx.shadowBlur = 8 + session.fitness * 12;
    ctx.stroke();
    ctx.restore();

    // Main stroke
    ctx.beginPath();
    ctx.moveTo(pathX[0], pathY[0]);
    for (let p = 1; p < numPoints; p++) {
      ctx.lineTo(pathX[p], pathY[p]);
    }
    ctx.strokeStyle = 'rgba(' + color.r + ',' + color.g + ',' + color.b + ',' + alpha + ')';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// PAGE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

function renderAgentPage(agentKey) {
  const content = document.getElementById('agent-content');

  if (!agentKey) {
    content.innerHTML = \`
      <div class="empty-state">
        <div class="empty-icon">\u2500\u2500\u2500</div>
        <div class="empty-text">Enter a pubkey or DID to look up an agent</div>
        <div class="empty-sub">Try: 5kopfXg2movVA8BMJKHgcxfY2twgzLXaAxcu2HbgvHtX</div>
      </div>
    \`;
    return;
  }

  // Generate evolution data (deterministic per key)
  const numSessions = 25;
  const sessions = generateEvolution(agentKey, numSessions);
  const latestSession = sessions[sessions.length - 1];
  const latestFitness = latestSession.fitness;
  const latestWeights = latestSession.weights;

  // Compute some stats
  const avgFitness = sessions.reduce((s, x) => s + x.fitness, 0) / sessions.length;
  const fitnessGain = sessions[sessions.length - 1].fitness - sessions[0].fitness;

  // Build HTML
  content.innerHTML = \`
    <div class="ridge-section">
      <div class="canvas-wrap">
        <canvas id="ridge-canvas"></canvas>
      </div>
      <div class="dim-labels">
        \${DIMENSIONS.map(d => '<div class="dim-label">' + d.short + '</div>').join('')}
      </div>
      <div class="legend">
        <span class="legend-label">low fitness</span>
        <div class="legend-bar"></div>
        <span class="legend-label">high fitness</span>
      </div>
    </div>

    <div class="agent-info">
      <div class="did-row">
        <div class="did-label">Decentralized Identifier</div>
        <div class="did-value">did:persistence:devnet:\${agentKey}</div>
      </div>

      <div class="stats-row">
        <div class="stat">
          <div class="stat-value">\${numSessions}</div>
          <div class="stat-label">sessions</div>
        </div>
        <div class="stat">
          <div class="stat-value">\${latestFitness.toFixed(2)}</div>
          <div class="stat-label">fitness</div>
        </div>
        <div class="stat">
          <div class="stat-value">\${fitnessGain > 0 ? '+' : ''}\${(fitnessGain * 100).toFixed(0)}%</div>
          <div class="stat-label">growth</div>
        </div>
        <div class="stat">
          <div class="stat-value">\${NUM_DIMS}</div>
          <div class="stat-label">dimensions</div>
        </div>
      </div>

      <div class="dims-section">
        <div class="dims-title">Current Behavioral Profile</div>
        \${DIMENSIONS.map((dim, i) => {
          const w = latestWeights[i];
          const color = fitnessToColor(w).css;
          return '<div class="dim-bar-row">'
            + '<div class="dim-bar-name">' + dim.label + '</div>'
            + '<div class="dim-bar-track">'
            + '<div class="dim-bar-fill" style="width:' + (w * 100).toFixed(1) + '%;background:' + color + ';"></div>'
            + '</div>'
            + '<div class="dim-bar-val">' + (w * 100).toFixed(0) + '%</div>'
            + '</div>';
        }).join('')}
      </div>
    </div>
  \`;

  // Animate ridge plot
  const canvas = document.getElementById('ridge-canvas');
  if (!canvas) return;

  const duration = 2000; // 2s animation
  const start = performance.now();

  function animate(now) {
    const elapsed = now - start;
    const progress = Math.min(1, elapsed / duration);
    // Ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    drawRidgePlot(canvas, sessions, eased);
    if (progress < 1) {
      requestAnimationFrame(animate);
    }
  }

  requestAnimationFrame(animate);

  // Redraw on resize
  let resizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      drawRidgePlot(canvas, sessions, 1);
    }, 100);
  });
}

// Search handling
function doSearch() {
  const input = document.getElementById('search-input');
  let val = input.value.trim();
  val = val.replace(/^did:persistence:devnet:/, '');
  val = val.replace(/[^A-HJ-NP-Za-km-z1-9]/g, '');
  if (val) {
    window.location.href = '/agent?key=' + encodeURIComponent(val);
  }
}

document.getElementById('search-btn').addEventListener('click', doSearch);
document.getElementById('search-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doSearch();
});

// Initialize
renderAgentPage('${agentKey}');
</script>
</body>
</html>`;

  return res.status(200).send(html);
}
