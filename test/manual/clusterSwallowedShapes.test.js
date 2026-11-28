'use strict';

// What does the clusterer build from the frames the swallowed-holding test
// uses?
//
//   node --test test/manual/clusterSwallowedShapes.test.js

const test = require('node:test');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const { clusterRawOcrTokens } = require(path.join(ROOT, 'src', 'parse', 'parseChartStream'));

const SYNTHETIC = {
  tickers: ['AAPL', 'AAL', 'TSLA', 'TSLB', 'NFLX', 'FREY', 'ARQQ', 'ARKG', 'AI', 'LI', 'APLD'],
  tickerSet: new Set(['AAPL', 'AAL', 'TSLA', 'TSLB', 'NFLX', 'FREY', 'ARQQ', 'ARKG', 'AI', 'LI', 'APLD']),
};

test('the shapes the swallowed-holding rule has to handle', () => {
  const shapes = {
    'LI read in 6 frames of its own': (() => {
      const f = [];
      for (let i = 0; i < 6; i++) f.push('AI APLD LI');
      f.push('AI APLD');
      return f;
    })(),
    'LI read in 1 frame': ['AI APLD LI', 'AI APLD', 'AI APLD', 'AI APLD', 'AI APLD'],
    'LI in every frame, AI in one': (() => {
      const f = [];
      for (let i = 0; i < 6; i++) f.push('APLD LI');
      f.push('APLD AI');
      return f;
    })(),
  };

  for (const [name, frames] of Object.entries(shapes)) {
    console.log(`\n--- ${name} ---`);
    console.log(`    frames: ${frames.length}`);
    const off = clusterRawOcrTokens(frames, {
      lexicon: SYNTHETIC, minFrequency: 1,
    });
    console.log('    shipped clusters:');
    for (const c of off.clusters) {
      console.log(`      { canonical: "${c.canonical}", members: [${c.members.join(', ')}], frequency: ${c.frequency} }`);
    }
    console.log(`    shipped merged: ${off.merged_list.join(' ')}`);

    const on = clusterRawOcrTokens(frames, {
      lexicon: SYNTHETIC, minFrequency: 1,
      publishSwallowedHoldings: true,
      swallowedHoldingMinFrames: 4,
    });
    console.log(`    with the rule: ${on.merged_list.join(' ')}`);
    for (const c of on.clusters) {
      if (!c.swallowedEvidence || !c.swallowedEvidence.length) continue;
      console.log(`      ${c.canonical}: ${c.swallowedEvidence.map((e) => `${e.ticker} own=${e.ownFrames} published=${e.published}`).join('  ')}`);
    }
  }
  console.log('');
});
