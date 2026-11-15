'use strict';

// Shared page chrome for source reports. Source-specific tables and evidence
// stay in their own renderers; this module owns the common header, coverage
// funnel, and navigation contract.

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderSourceHeader(source = {}) {
  const capabilities = (source.capabilities || []).map((item) => `<span class="source-capability">${escapeHtml(item)}</span>`).join('');
  return `<header class="source-hero" style="--source-accent:${escapeHtml(source.accent || '#b34e2d')}">
    <div><p class="source-kicker">SOURCE RESEARCH / ${escapeHtml(source.id || 'catalog')}</p>
      <h1>${escapeHtml(source.label || 'Source dashboard')}</h1>
      <p class="source-description">${escapeHtml(source.description || '')}</p></div>
    <aside class="source-meta"><span>Updated</span><strong>${escapeHtml(source.updatedAt || 'unknown')}</strong>
      <div class="source-capabilities">${capabilities}</div></aside>
  </header>`;
}

function renderCoverage(coverage = []) {
  const rows = coverage.map((stage) => {
    const count = stage.count === null || stage.count === undefined ? 'Unknown' : Number(stage.count).toLocaleString('en-US');
    const denominator = stage.denominator === null || stage.denominator === undefined
      ? '' : ` / ${Number(stage.denominator).toLocaleString('en-US')}`;
    const status = stage.status || 'unknown';
    return `<li class="coverage-stage status-${escapeHtml(status)}">
      <span class="coverage-stage-name">${escapeHtml(stage.stage)}</span>
      <strong>${count}<small>${denominator}</small></strong>
      <span class="coverage-status">${escapeHtml(status.replace(/_/g, ''))}</span>
      ${stage.reason ? `<small class="coverage-reason">${escapeHtml(stage.reason)}</small>` : ''}
    </li>`;
  }).join('');
  return `<section id="coverage" class="source-coverage" aria-labelledby="coverage-heading">
    <div class="section-heading"><p class="source-kicker">DATA PROVENANCE</p><h2 id="coverage-heading">Coverage at a glance</h2></div>
    <ol class="coverage-stages">${rows || '<li>Coverage has not been measured.</li>'}</ol>
  </section>`;
}

const SOURCE_SHELL_CSS = `
  :root { --paper:#f4f1e9; --ink:#1e2829; --muted:#69716f; --rule:#d8d4c9; --panel:#fbfaf6; }
  body { margin:0 auto; max-width:1440px; padding:2rem clamp(1rem,4vw,4rem) 5rem; background:var(--paper); color:var(--ink); font-family:Georgia,'Iowan Old Style',serif; }
  .source-hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(13rem,20rem); gap:2rem; align-items:end; padding:1.4rem 0 1.8rem; border-top:5px solid var(--source-accent); border-bottom:1px solid var(--rule); }
  .source-kicker { margin:0 0 .5rem; color:var(--source-accent,#b34e2d); font:700 .68rem/1.2 ui-monospace,Consolas,monospace; letter-spacing:.16em; }
  .source-hero h1 { margin:.2rem 0 .45rem; font-size:clamp(2rem,4vw,3.8rem); letter-spacing:-.045em; }
  .source-description { max-width:54rem; color:var(--muted); font:1rem/1.5 Georgia,serif; }
  .source-meta { border-left:1px solid var(--rule); padding-left:1rem; color:var(--muted); font: .8rem/1.5 ui-monospace,Consolas,monospace; }
  .source-meta strong { display:block; color:var(--ink); font-size:.9rem; }
  .source-capabilities { display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.7rem; }
  .source-capability { border:1px solid var(--rule); padding:.18rem .4rem; font-size:.68rem; }
  .source-nav { display:flex; gap:1.2rem; border-bottom:1px solid var(--rule); margin:1.2rem 0 2rem; }
  .source-nav a { padding:.7rem .1rem; color:var(--muted); text-decoration:none; font:700 .78rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.08em; border-bottom:2px solid transparent; }
  .source-nav a:hover,.source-nav a:focus { color:var(--ink); border-color:var(--source-accent,#b34e2d); }
  .source-section { padding:1rem 0 2rem; border-bottom:1px solid var(--rule); scroll-margin-top:1rem; }
  .source-section h2,.source-coverage h2 { font-size:1.35rem; letter-spacing:-.02em; }
  .source-coverage { padding:1.5rem; margin:1.5rem 0; background:var(--panel); border:1px solid var(--rule); }
  .coverage-stages { list-style:none; padding:0; margin:1rem 0 0; display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); border:1px solid var(--rule); }
  .coverage-stage { min-height:6.3rem; padding:.8rem; border-right:1px solid var(--rule); border-bottom:1px solid var(--rule); display:flex; flex-direction:column; gap:.3rem; }
  .coverage-stage-name,.coverage-status { color:var(--muted); font: .68rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.06em; }
  .coverage-stage strong { font-size:1.5rem; font-variant-numeric:tabular-nums; }
  .coverage-stage strong small { color:var(--muted); font-size:.8rem; font-weight:400; }
  .coverage-reason { color:var(--muted); font: .72rem/1.35 ui-monospace,Consolas,monospace; }
  .status-unknown .coverage-status,.status-not_started .coverage-status { color:#8c6c31; }
  .status-blocked .coverage-status { color:#a84234; }
  @media(max-width:700px) { .source-hero { grid-template-columns:1fr; } .source-meta { border-left:0; border-top:1px solid var(--rule); padding:1rem 0 0; } }
`;

function renderCoverageRows(coverage = []) {
  return coverage.map((stage) => ({
    stage: stage.stage,
    count: stage.count ?? null,
    denominator: stage.denominator ?? null,
    status: stage.status || 'unknown',
    reason: stage.reason || '',
  }));
}

module.exports = { SOURCE_SHELL_CSS, renderCoverage, renderCoverageRows, renderSourceHeader };
