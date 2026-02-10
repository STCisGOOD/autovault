/**
 * Persistence Network Dashboard
 *
 * "Your agent forgets everything between sessions. Ours don't."
 *
 * A live proof of concept: N agents getting measurably better every session.
 * The counter, the trend line, and the health dot.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Persistence Network — Agents That Learn</title>
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
      max-width: 740px;
      margin: 0 auto;
    }

    header {
      text-align: center;
      padding: 40px 0 30px;
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

    /* ── Big Counter ── */
    .hero {
      text-align: center;
      padding: 40px 0;
      border-top: 1px solid #00ff8822;
      border-bottom: 1px solid #00ff8822;
      margin: 20px 0;
    }

    .hero-number {
      font-size: 4rem;
      color: #00ff88;
      font-weight: bold;
      line-height: 1;
    }

    .hero-label {
      font-size: 0.8rem;
      color: #00ff8866;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-top: 8px;
    }

    /* ── Stats Row ── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: #00ff8822;
      margin: 20px 0;
    }

    .stat {
      background: #0a0a0f;
      padding: 20px 15px;
      text-align: center;
    }

    .stat-value {
      font-size: 1.4rem;
      color: #00ff88;
      font-weight: bold;
    }

    .stat-label {
      font-size: 0.65rem;
      color: #00ff8866;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 4px;
    }

    .stat-value.negative { color: #ff4444; }
    .stat-value.neutral { color: #888; }

    /* ── Health Dot ── */
    .health {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 15px;
      margin: 20px 0;
    }

    .health-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    .health-dot.green { background: #00ff88; box-shadow: 0 0 10px #00ff8844; }
    .health-dot.yellow { background: #ffaa00; box-shadow: 0 0 10px #ffaa0044; }
    .health-dot.red { background: #ff4444; box-shadow: 0 0 10px #ff444444; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .health-text {
      font-size: 0.8rem;
      color: #00ff8888;
    }

    /* ── Trend Chart ── */
    .chart-section {
      margin: 30px 0;
    }

    .chart-title {
      font-size: 0.7rem;
      color: #00ff8866;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 10px;
    }

    .chart-container {
      background: #0f0f18;
      border: 1px solid #00ff8822;
      padding: 20px;
      height: 160px;
      position: relative;
      overflow: hidden;
    }

    .chart-bar {
      display: inline-block;
      width: 8px;
      margin-right: 2px;
      position: absolute;
      bottom: 20px;
      transition: height 0.3s;
    }

    .chart-bar.positive { background: #00ff88; }
    .chart-bar.negative { background: #ff4444; }
    .chart-bar.zero { background: #333; }

    .chart-baseline {
      position: absolute;
      bottom: 20px;
      left: 20px;
      right: 20px;
      height: 1px;
      background: #00ff8844;
    }

    .chart-baseline-label {
      position: absolute;
      bottom: 4px;
      right: 20px;
      font-size: 0.6rem;
      color: #00ff8844;
    }

    .chart-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #00ff8844;
      font-size: 0.8rem;
    }

    /* ── CTA ── */
    .cta {
      text-align: center;
      padding: 30px 20px;
      margin: 30px 0;
      border: 1px solid #00ff8833;
      background: #0f0f18;
    }

    .cta-headline {
      color: #00ff88;
      font-size: 0.9rem;
      margin-bottom: 10px;
    }

    .cta-code {
      background: #0a0a0f;
      border: 1px solid #00ff8822;
      padding: 12px 20px;
      display: inline-block;
      margin: 10px 0;
      color: #00ff88cc;
      font-size: 0.8rem;
    }

    .cta-sub {
      color: #00ff8844;
      font-size: 0.7rem;
      margin-top: 8px;
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

    /* ── Anomaly Warning ── */
    .anomaly-banner {
      display: none;
      background: #1a1000;
      border: 1px solid #ffaa0066;
      padding: 12px 20px;
      margin: 15px 0;
      text-align: center;
      font-size: 0.75rem;
      color: #ffaa00cc;
    }

    .anomaly-banner.visible { display: block; }

    /* ── Loading ── */
    .loading {
      color: #00ff8844;
      text-align: center;
      padding: 20px;
    }

    @media (max-width: 600px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .hero-number { font-size: 3rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Persistence Network</h1>
      <div class="tagline">Your agent forgets everything between sessions. Ours don't.</div>
    </header>

    <div class="hero">
      <div class="hero-number" id="session-count">-</div>
      <div class="hero-label">verified sessions</div>
    </div>

    <div class="stats-row">
      <div class="stat">
        <div class="stat-value" id="improvement">-</div>
        <div class="stat-label">improvement</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="sessions">-</div>
        <div class="stat-label">total sessions</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="fitness">-</div>
        <div class="stat-label">mean fitness</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="errors">-</div>
        <div class="stat-label">errors</div>
      </div>
    </div>

    <div class="health" id="health-bar">
      <div class="health-dot green" id="health-dot"></div>
      <span class="health-text" id="health-text">Loading...</span>
    </div>

    <div class="anomaly-banner" id="anomaly-banner"></div>

    <div class="chart-section">
      <div class="chart-title">Performance improvement over baseline</div>
      <div class="chart-container" id="chart">
        <div class="chart-empty">Collecting data...</div>
      </div>
    </div>

    <div class="cta">
      <div class="cta-headline">Add your agent to the network</div>
      <div class="cta-code">npm install persistence-agent-identity@latest</div>
      <div class="cta-sub">5 numbers, nonce-bound sessions, proof-of-work verified. Zero private data.</div>
    </div>

    <footer>
      <div class="footer-text">
        <a href="https://github.com/AetherArchivum/autovault">GitHub</a> &middot;
        <a href="/agent">Agent Lookup</a> &middot;
        <a href="/api/network">Raw Stats</a> &middot;
        <a href="/live">AutoVault Live</a>
      </div>
      <div class="footer-text" style="margin-top: 8px;">
        Built for the Colosseum Agent Hackathon &middot; persistence-agent-identity
      </div>
    </footer>
  </div>

  <script>
    let chartHistory = [];

    async function refresh() {
      try {
        const res = await fetch('/api/network');
        const data = await res.json();
        const s = data.stats;

        // Hero counter — totalSessions is nonce-bound and honest
        document.getElementById('session-count').textContent = s.totalSessions || 0;

        // Stats row
        const impEl = document.getElementById('improvement');
        if (s.improvementPct > 0) {
          impEl.textContent = '+' + s.improvementPct + '%';
          impEl.className = 'stat-value';
        } else if (s.improvementPct < 0) {
          impEl.textContent = s.improvementPct + '%';
          impEl.className = 'stat-value negative';
        } else {
          impEl.textContent = '0%';
          impEl.className = 'stat-value neutral';
        }

        document.getElementById('sessions').textContent = s.totalSessions || 0;
        document.getElementById('fitness').textContent = s.meanFitness ? s.meanFitness.toFixed(2) : '-';
        document.getElementById('errors').textContent = s.totalErrors || 0;

        // Health dot
        const dot = document.getElementById('health-dot');
        dot.className = 'health-dot ' + s.health;
        const healthText = document.getElementById('health-text');
        if (s.health === 'green') {
          healthText.textContent = s.activeLastHour > 0
            ? s.activeLastHour + ' sessions in the last hour'
            : 'Network healthy — waiting for sessions';
        } else if (s.health === 'yellow') {
          healthText.textContent = s.failedLastHour + ' incomplete sessions detected';
        } else {
          healthText.textContent = 'High failure rate — ' + s.failedLastHour + ' sessions failed';
        }

        // Anomaly detection — show warning if data is unreliable
        const banner = document.getElementById('anomaly-banner');
        if (s.anomaly && !s.anomaly.dataReliable) {
          const reasons = [];
          if (s.anomaly.volumeSpike) reasons.push('unusual volume spike detected');
          if (s.anomaly.uniformData) reasons.push('suspiciously uniform data pattern');
          banner.textContent = 'Data under review — ' + reasons.join(', ');
          banner.className = 'anomaly-banner visible';
        } else {
          banner.className = 'anomaly-banner';
        }

        // Chart — append improvement data point
        chartHistory.push(s.improvementPct || 0);
        if (chartHistory.length > 60) chartHistory.shift();
        renderChart();

      } catch (e) {
        document.getElementById('health-text').textContent = 'Failed to reach network';
      }
    }

    function renderChart() {
      const container = document.getElementById('chart');
      if (chartHistory.length === 0) {
        container.innerHTML = '<div class="chart-empty">Collecting data...</div>';
        return;
      }

      const maxAbs = Math.max(1, ...chartHistory.map(v => Math.abs(v)));
      const barWidth = 8;
      const gap = 2;
      const chartHeight = 120;
      const midY = chartHeight / 2;

      let html = '<div class="chart-baseline"></div>';
      html += '<div class="chart-baseline-label">baseline (no persistence)</div>';

      chartHistory.forEach((val, i) => {
        const height = Math.max(2, Math.abs(val / maxAbs) * midY);
        const isPositive = val >= 0;
        const bottom = isPositive ? midY : midY - height;
        const cls = val > 0 ? 'positive' : val < 0 ? 'negative' : 'zero';

        html += '<div class="chart-bar ' + cls + '" style="'
          + 'left:' + (20 + i * (barWidth + gap)) + 'px;'
          + 'bottom:' + (20 + bottom) + 'px;'
          + 'height:' + height + 'px;'
          + '"></div>';
      });

      container.innerHTML = html;
    }

    // Initial load + refresh every 30s
    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;

  return res.status(200).send(html);
}
