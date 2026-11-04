'use strict';

// Survey the Czech trading vocabulary in the fetched transcripts.
//
// WHY THIS TOOL EXISTS
//
// The question "how far should the Czech glossary go?" cannot be answered
// from a dictionary. It can only be answered from the CORPUS: which words
// does this speaker actually use to state a direction, a level, a
// probability and a confidence?
//
// So this tool reads every fetched transcript and reports, per category,
// the exact phrases that occur -- with the segment they came from. The
// output is the evidence a glossary is built from, and it is measured
// rather than assumed.
//
// WHAT IT REPORTS
//
//   * the phrases that carry a DIRECTION (long, short, ...)
//   * the phrases that carry a LEVEL or a ZONE (úroveň, zóna, odraz, ...)
//   * the phrases that carry a PROBABILITY or CONFIDENCE
//   * the phrases that carry a PRICE ROLE (cíl, stop, vstup, ...)
//   * the COMPANY NAMES that were spoken, and whether each one resolves
//     to a ticker -- and the ones that do NOT
//
// The last category is the important one: a spoken company name that
// matches no ticker is a MISSING ENTRY, and it is what the table has to
// grow. It is also how a non-US ticker shows up -- the speaker said
// "RHM, neboli Rheinmetall", and Rheinmetall is a German company that
// the SEC's US list does not carry.
//
// Usage:
//   node tools/surveySevcikVocabulary.js
//   node tools/surveySevcikVocabulary.js --json
//   node tools/surveySevcikVocabulary.js --limit 5
//   node tools/surveySevcikVocabulary.js --unknown-only

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSeedLexiconSync } = require('../src/normalize/tickerScan');
const { matchCompanyName } = require('../src/sevcik/companyNames');
const { SEVCIK_CHANNEL } = require('../src/sevcik/channel');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

const argv = process.argv.slice(2);
const options = {
  json: argv.includes('--json'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  unknownOnly: argv.includes('--unknown-only'),
};

/**
 * The phrase categories, and the words that belong to each.
 *
 * The words are the ones MEASURED in the corpus, and each carries a note
 * on what it means in Czech trading language.
 */
const CATEGORIES = {
  direction_long: {
    label: 'direction: bullish / long',
    patterns: [
      /\blong\b/gi,
      /\brostoucí\b/gi,
      /\bdo long(?:u)?\b/gi,
      /\bv long(?:u)?\b/gi,
      /\bbullish\b/gi,
      /\bdo longa\b/gi,
    ],
  },
  direction_short: {
    label: 'direction: bearish / short',
    patterns: [
      /\bshort\b/gi,
      /\bklesoucí\b/gi,
      /\bdo short(?:u)?\b/gi,
      /\bv short(?:u)?\b/gi,
      /\bbearish\b/gi,
      /\bpokles(?:ový|ového|ovému)\b/gi,
    ],
  },
  level_zone: {
    label: 'level or zone',
    patterns: [
      /\búrov(?:eň|ně|ni|ň|ňe)\b/gi,
      /\bz[oó]na\b/gi,
      /\bn[aá]kupní z[oó]na\b/gi,
      /\bprodejní z[oó]na\b/gi,
      /\bodraz\w*\b/gi,
      /\bkan[aá]l\b/gi,
      /\bhran(?:a|ice|ici|icí)\b/gi,
      /\bhranice\b/gi,
    ],
  },
  probability: {
    label: 'probability',
    patterns: [
      /\bpravděpodobnost\w*\b/gi,
      /\bprocent\w*\b/gi,
      /\bšance\b/gi,
      /\bsanepravděpodobn\w*\b/gi,
    ],
  },
  confidence: {
    label: 'confidence / verdict',
    patterns: [
      /\bsiln\w*\b/gi,
      /\bsignal\w*\b/gi,
      /\bpredikc\w*\b/gi,
      /\bverdikt\w*\b/gi,
      /\bjasn\w*\b/gi,
      /\bjasně\b/gi,
    ],
  },
  price_role: {
    label: 'price role (target / stop / entry)',
    patterns: [
      /\bcíl\w*\b/gi,
      /\bstop\b/gi,
      /\bstop loss\b/gi,
      /\bzastavení\b/gi,
      /\bvstup\w*\b/gi,
      /\bprofit\w*\b/gi,
      /\bzisk\w*\b/gi,
      /\bvýnos\w*\b/gi,
    ],
  },
  neutral: {
    label: 'neutral / no call',
    patterns: [
      /\bneutr[aá]ln\w*\b/gi,
      /\bpatov\w*\b/gi,
      /\bnevím\b/gi,
      /\bbudeme čekat\b/gi,
    ],
  },
};

/**
 * A spoken name that is NOT a known ticker, a known company, or a noise
 * token.
 *
 * The point is to find the names that would be MISSED. A capitalised
 * word in Czech prose is often a name, and often not -- so the noise
 * words are listed explicitly rather than by a general rule.
 */
const NOISE_WORDS = new Set([
  'AI', 'IT', 'EU', 'USA', 'OK', 'AMD', 'ETF', 'USB', 'CBS', 'MU', 'EET',
  'BS', 'UBS', 'UPS', 'SPY', 'AB', 'CD', 'AMI', 'EZ', 'XY', 'XAA', 'BTC',
  'USD', 'IS', 'RHM', 'STR', 'SDA', 'TSX', 'TNZ', 'GR', 'GRAB', 'CVSHL',
  'CVS', 'TV', 'PDF', 'ANDROID', 'APPLE', 'GOOGLE', 'META', 'TESLA',
  'AMAZON', 'MICROSOFT', 'NETFLIX', 'NVIDIA', 'MSFT', 'NFLX', 'AMZN', 'NVDA',
]);

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}.`);
    process.exit(1);
  }

  const lexicon = new Set(loadSeedLexiconSync().tickers);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const sql = 'SELECT t.video_id AS video_id, v.upload_date AS upload_date, t.transcript_path AS transcript_path '
    + 'FROM video_transcripts t JOIN videos v ON v.video_id = t.video_id '
    + 'WHERE v.channel = ? ORDER BY v.upload_date DESC';
  let rows = db.prepare(sql).all(SEVCIK_CHANNEL);
  db.close();

  if (options.limit) rows = rows.slice(0, options.limit);

  const phrases = {};
  for (const key of Object.keys(CATEGORIES)) {
    phrases[key] = { label: CATEGORIES[key].label, total: 0, forms: new Map(), samples: [] };
  }

  const unknownNames = new Map();
  const knownNames = new Map();
  let segmentCount = 0;

  for (const row of rows) {
    const filePath = row.transcript_path;
    if (!filePath || !fs.existsSync(filePath)) continue;

    let transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      continue;
    }

    for (const segment of transcript.segments || []) {
      segmentCount += 1;
      const text = String(segment.text || '');

      for (const [key, category] of Object.entries(CATEGORIES)) {
        for (const pattern of category.patterns) {
          const regex = new RegExp(pattern.source, pattern.flags);
          let match;
          while ((match = regex.exec(text)) !== null) {
            const form = match[0].toLowerCase();
            const entry = phrases[key];
            entry.total += 1;
            if (!entry.forms.has(form)) {
              entry.forms.set(form, { count: 0, firstSeen: segment.text });
            }
            entry.forms.get(form).count += 1;
            if (entry.samples.length < 4) {
              entry.samples.push({ video_id: row.video_id, start_ts: segment.start_ts, text: segment.text });
            }
          }
        }
      }

      // The spoken names. A capitalised word, not a noise token.
      const nameRegex = /\b[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]{2,}\b/g;
      let nameMatch;
      while ((nameMatch = nameRegex.exec(text)) !== null) {
        const spoken = nameMatch[0];
        if (NOISE_WORDS.has(spoken.toUpperCase())) continue;

        const match = matchCompanyName(spoken, { lexicon });
        if (match.ticker) {
          if (!knownNames.has(spoken)) knownNames.set(spoken, { ticker: match.ticker, count: 0, video_id: row.video_id });
          knownNames.get(spoken).count += 1;
        } else {
          if (!unknownNames.has(spoken)) unknownNames.set(spoken, { count: 0, videos: new Set(), sample: segment.text });
          const entry = unknownNames.get(spoken);
          entry.count += 1;
          entry.videos.add(row.video_id);
          entry.sample = segment.text;
        }
      }
    }
  }

  const report = {
    transcripts: rows.length,
    segments: segmentCount,
    phrases: {},
    unknown_names: [...unknownNames.entries()]
      .map(([name, entry]) => ({ name, count: entry.count, videos: entry.videos.size, sample: entry.sample }))
      .sort((a, b) => b.count - a.count),
    known_names: [...knownNames.entries()]
      .map(([name, entry]) => ({ name, ticker: entry.ticker, count: entry.count }))
      .sort((a, b) => b.count - a.count),
  };

  for (const [key, entry] of Object.entries(phrases)) {
    report.phrases[key] = {
      label: entry.label,
      total: entry.total,
      forms: [...entry.forms.entries()]
        .map(([form, info]) => ({ form, count: info.count, sample: info.firstSeen }))
        .sort((a, b) => b.count - a.count),
    };
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`[sevcik-vocab] transcripts=${report.transcripts} segments=${report.segments}`);
  console.log('');

  for (const [key, entry] of Object.entries(report.phrases)) {
    console.log(`### ${entry.label} -- ${entry.total} occurrences, ${entry.forms.length} distinct forms`);
    for (const form of entry.forms.slice(0, 12)) {
      console.log(`   ${String(form.count).padStart(4)}  ${form.form.padEnd(22)} ${form.sample.slice(0, 80)}`);
    }
    console.log('');
  }

  console.log(`### spoken names that RESOLVE to a ticker -- ${report.known_names.length} distinct`);
  for (const name of report.known_names.slice(0, 30)) {
    console.log(`   ${String(name.count).padStart(4)}  ${name.name.padEnd(20)} -> ${name.ticker}`);
  }
  console.log('');

  console.log(`### spoken names that DO NOT resolve -- ${report.unknown_names.length} distinct`);
  console.log('    (a name here is a missing entry in the table, or a non-US ticker)');
  for (const name of report.unknown_names.slice(0, 40)) {
    console.log(`   ${String(name.count).padStart(4)}  ${name.name.padEnd(22)} ${name.sample.slice(0, 80)}`);
  }
}

/**
 * Read a flag's value.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string}
 */
function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  return String(args[index + 1] || '');
}

if (require.main === module) main();

module.exports = { CATEGORIES, NOISE_WORDS };
