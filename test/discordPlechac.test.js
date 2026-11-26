'use strict';

// The plechac parser: a Czech trade statement, read out of one Discord
// message.
//
// Every rule here exists because its absence produced a wrong holding
// somewhere in the corpus (233 of his messages in the trade channel,
// 1,779 in the talk channel).

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseTradeMessage } = require('../src/discord/plechac/parser');
const { findHoldings } = require('../src/discord/plechac/symbols');
const { loadLexicon } = require('../src/discord/symbols');

const KNOWN = loadLexicon();

function read(content, kind = 'trades') {
  return parseTradeMessage(content, { known: KNOWN, kind });
}

function tickers(content, kind = 'trades') {
  return read(content, kind).map((row) => `${row.action}:${row.ticker}`);
}

test('the verb of a LINE is the verb of that line', () => {
  // Two statements, one message, two verbs.
  const rows = read('Prodal jsem celý SentimelOne\nProdal jsem skoro polovinu PayPal');
  assert.equal(rows.length, 2);
  // "skoro polovinu" is a PART of the position, so the position stays open.
  assert.deepEqual(rows.map((row) => `${row.action}:${row.ticker}`), ['exit:S', 'trim:PYPL']);
  assert.equal(rows[1].fraction, 0.5);
});

test('a line of names CONTINUES the verb above it', () => {
  const rows = read('Dobral jsem akcie, které dneska trpí\nRollsRoyce\nSamsung\nLEU\nBABA');
  assert.deepEqual(rows.map((row) => `${row.action}:${row.ticker}`), [
    'open:RR.L', 'open:005930.KS', 'open:LEU', 'open:BABA',
  ]);
});

test('"beru" with a profit is a REDUCTION, not a purchase', () => {
  // The measured rule: twelve messages pair "beru" or "vzal jsem" with
  // "zisk" or "profit", and every one of them is a reduction.
  assert.deepEqual(tickers('Beru zisk na Citi Group částečný'), ['trim:C']);
  assert.deepEqual(tickers('Vzal jsem menší zisk na Intelu - podle mě je to úlet.'), ['trim:INTC']);
  assert.deepEqual(tickers('Beru další menší profity na OXY, ONEOK, CNRL'), ['trim:OXY', 'trim:OKE', 'trim:CNQ']);
  // And the whole of it is a close.
  assert.deepEqual(tickers('Beru celý profit na Groupon - byl to jen swing trade'), ['exit:GRPN']);
});

test('"beru" on its own is a purchase', () => {
  assert.deepEqual(tickers('Beru SLB a HAL - ropa, services'), ['open:SLB', 'open:HAL']);
  assert.deepEqual(tickers('Beru PYPL, BRK, MSFT'), ['open:PYPL', 'open:BRK-B', 'open:MSFT']);
});

test('a close of a PART is a trim, and the position stays open', () => {
  assert.deepEqual(tickers('Zavřel jsem trochu Samsung, OXY, DELL'), ['trim:005930.KS', 'trim:OXY', 'trim:DELL']);
  assert.deepEqual(tickers('Prodal jsem skoro polovinu PayPal'), ['trim:PYPL']);
  // The whole of it is a close.
  assert.deepEqual(tickers('Prodal jsem komplet BlackBerry'), ['exit:BB']);
});

test('the book a statement belongs to', () => {
  const risky = read('Dobral jsem na RISKY portfoliu minimální pozice HOOD a CRCL');
  assert.deepEqual(risky.map((row) => row.account), ['risky', 'risky']);

  // The book is a property of the LINE, not of the message.
  const both = read('Dobírám na risky portfoliu Uber a Circle\nNa hlavním jsem kosmeticky doplnil (LEU, Meta, RR)');
  assert.deepEqual(
    both.map((row) => `${row.account}:${row.ticker}`),
    ['risky:UBER', 'risky:CRCL', 'main:LEU', 'main:META', 'main:RR.L'],
  );
});

test('a name behind a dash is not the subject of the trade', () => {
  // The subject is B; "barrick mining" says what B is.
  assert.deepEqual(tickers('Zavřel jsem opět trochu B - barrick mining'), ['trim:B']);
  // The subject is the ETF, and the names behind the dash are its
  // contents, not four separate positions.
  assert.deepEqual(
    tickers('prodal jsem celé ETF SP500 Financials Sector - je tam BRK, JPM, Visa, Mastercard'),
    [],
  );
});

test('a CZECH word boundary: "dokupů" is not a verb and "celé" is a word', () => {
  // "\b" is ASCII, so /\bdokup\b/ MATCHES "dokupů" and /\bcelé\b/ NEVER
  // MATCHES. Both were live defects in the first version.
  assert.deepEqual(tickers('Beru půlku z MU a TSM... koukám se po Samsungu, DELL, Intelu'), ['trim:MU', 'trim:TSM']);
  assert.deepEqual(tickers('Prodal jsem komplet BlackBerry'), ['exit:BB']);
});

test('the trade channel reads a present-tense verb as a trade, the talk channel does not', () => {
  // "beru" is a trade in the trade channel and an opinion in the talk one.
  assert.deepEqual(tickers('Beru trochu MU', 'trades'), ['open:MU']);
  assert.deepEqual(tickers('Beru trochu MU', 'talk'), []);
  // A realized past-tense verb is a trade in both.
  assert.deepEqual(tickers('Dobral jsem trochu MU', 'talk'), ['open:MU']);
});

test('the talk channel is a channel of other people', () => {
  // A message with no first-person marker in it is about somebody else,
  // and it reads exactly like his own trades.
  assert.deepEqual(tickers('LEO končně nakoupil taky NBIS', 'talk'), []);
  assert.deepEqual(
    tickers('Podle dokumentu Schedule 13G fond koupil 12,41 milionu akcií čímž se Nebius stal velkou investicí', 'talk'),
    [],
  );
  // His own trade in the same channel is read.
  assert.deepEqual(tickers('Prodal jsem zbytek KB akcií po časovém testu', 'talk'), ['exit:KB']);
});

test('the jargon is not a holding', () => {
  // Each of these was read in the message it came from.
  assert.deepEqual(tickers('Doplňuji METU a GRAB'), ['add:GRAB']); // METU is ambiguous
  assert.deepEqual(tickers('Zobnul jsem si Samsung - AI boom pokračuje'), ['open:005930.KS']);
  assert.deepEqual(tickers('Beru PYPL a držím na Bitpandě u XTB'), ['open:PYPL']);
});

test('a single capital is a holding only on the measured list, and only when the line says what it is', () => {
  // "S" is SentinelOne and "B" is Barrick Mining.
  assert.deepEqual(tickers('Moje první pozice v S - Sentinel One'), ['open:S']);
  assert.deepEqual(tickers('Zavřel jsem opět trochu B - barrick mining'), ['trim:B']);
  // The head of a Czech word is not a ticker.
  assert.deepEqual(tickers('Cítím zradu, dokupuji také Samsung'), ['add:005930.KS']);
  // The Czech conjunction "A" is not a ticker either.
  assert.deepEqual(
    findHoldings('A trochu AMZN', { known: KNOWN }).map((row) => row.ticker),
    ['AMZN'],
  );
});

test('the names and the symbols the market wants are different things', () => {
  // A name is what he said; a symbol is what the price is made of.
  assert.deepEqual(tickers('Beru Samsung, XIAOMI, BYD'), ['open:005930.KS', 'open:1810.HK', 'open:1211.HK']);
  assert.deepEqual(tickers('Beru BRK, KLA, ONEOK, RR'), ['open:BRK-B', 'open:KLAC', 'open:OKE', 'open:RR.L']);
  assert.deepEqual(tickers('Dokoupil jsem CSU'), ['add:CSU.TO']);
});

test('a company name carries its Czech case ending', () => {
  assert.deepEqual(tickers('Beru menší profit na Intelu'), ['trim:INTC']);
  assert.deepEqual(tickers('Dobral jsem akcie\nSamsung\nLEU'), ['open:005930.KS', 'open:LEU']);
});

test('the fill, the size and the result he states', () => {
  const rows = read('Dokoupil jsem ENPH za 100$');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 100);
  assert.equal(rows[0].action, 'add');

  // A qualitative size is a NOTE, not a figure.
  const sized = read('Přikoupil jsem ještě drobně Adobe');
  assert.equal(sized[0].size_pct, null);
  assert.equal(sized[0].size_note, 'drobně');

  // A result is not a size.
  const result = read('Prodej NEM za ro 177 % (zlato)');
  assert.equal(result[0].stated_result_pct, 177);
});

test('a hypothesis is not a trade', () => {
  assert.deepEqual(tickers('Možná bude první nákup MELI', 'talk'), []);
  assert.deepEqual(tickers('Co teď sleduji na dokup, tak UUUU a EPNH', 'talk'), []);
  assert.deepEqual(tickers('Uber nic moc, ale přikoupil bych až níž', 'talk'), []);
});

test('two statements in one clause are two statements', () => {
  // A trim of one position and a sale of another.
  assert.deepEqual(tickers('Zavřel jsem třetinu ZETA a prodal jsem zbytek Gitlab'), ['trim:ZETA', 'exit:GTLB']);
  // A trim of one and a purchase of another.
  assert.deepEqual(tickers('Zavírám 1/4 na CRM a nakupuji za to MCD'), ['trim:CRM', 'add:MCD']);
});

test('an unresolved capitals token is reported, not guessed', () => {
  // The table grows from what the corpus says, so the survey has to be
  // able to see what it does not know.
  const unknown = findHoldings('Beru ZZZZ a QQQQ', { known: KNOWN });
  assert.deepEqual(unknown.map((row) => row.ticker), []);
});

test('the broker\'s exchange suffix is PART of the ticker', () => {
  // "IGLN.UK" is one instrument, and a token that stopped at the dot
  // read only the TAIL -- so the holding was published as "UK", which
  // Yahoo resolves to Ucommune International.
  assert.deepEqual(tickers('P\u0159ikoupil jsem IGLN.UK - ETF na zlato'), ['add:IGLN.L']);
  assert.deepEqual(tickers('Zalo\u017eil jsem prvn\u00ed long pozice na NGAS.UK na XTB'), ['open:NGAS.L']);
});

test('a bare ticker that Yahoo resolves to ANOTHER company is spelled out', () => {
  // Measured 2026-11-26: every ticker in the table was probed against
  // Yahoo, and these three resolve to a different company than the one
  // he means. A wrong instrument is a wrong price on a real holding.
  assert.deepEqual(tickers('P\u0159ikoupil jsem EVO'), ['add:EVO.ST']);       // EVOTEC SE otherwise
  assert.deepEqual(tickers('Dob\u00edr\u00e1m BTC cel\u00fd den'), ['add:BTC-USD']); // a closed-end fund otherwise
  assert.deepEqual(tickers('Beru po dlouh\u00e9 dobe dal\u0161\u00ed pozici LVMH'), ['open:MC.PA']);
  // And a symbol with a dash is still one token.
  assert.deepEqual(tickers('Beru BRK-B a TQQQ'), ['open:BRK-B', 'open:TQQQ']);
});
