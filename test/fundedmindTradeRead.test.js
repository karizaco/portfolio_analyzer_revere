'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { instrumentsIn, readSegment, readTrades } = require('../src/fundedmind/tradeRead');
const { extractSignals, PARSER_VERSION } = require('../src/fundedmind/signalExtractor');

test('instruments map spoken CZ/SK names', () => {
  assert.deepEqual(instrumentsIn('Bitcoin target 65 000'), ['BTC']);
  assert.deepEqual(instrumentsIn('co se týče toho zlata'), ['XAUUSD']);
  assert.deepEqual(instrumentsIn('na nasdaqu beru long'), ['NAS100']);
  assert.deepEqual(instrumentsIn('dxy je slabý'), ['DXY']);
  assert.deepEqual(instrumentsIn('shortovat to euro vůči dolaru'), ['EURUSD']);
});

test('first-person open is a trade; intent and coaching are not', () => {
  const hit = readSegment('já tam vstupuju právě z tohodle a beru long na bitcoinu');
  assert.ok(hit);
  assert.equal(hit.action, 'open');

  const intent = readSegment('přemýšlím, že bych si koupil ještě další účet');
  assert.equal(intent, null);

  const coach = readSegment('můžete longovat tuhle zónu klidně');
  assert.equal(coach, null);

  const coach2 = readSegment('očakávate od nazaku, či chcete brať long');
  assert.equal(coach2, null);
});

test('target and stop roles attach prices', () => {
  const t = readSegment('můj target byl 65 000 na bitcoinu');
  assert.ok(t);
  assert.equal(t.action, 'target');
  assert.equal(t.price, 65000);

  const s = readSegment('tím se mě ten stop loss posune někam na 35 000 dolarů');
  assert.ok(s);
  assert.equal(s.action, 'stop_out');
  assert.equal(s.stop_price, 35000);
});

test('readTrades can take ticker from the next segment', () => {
  const trades = readTrades([
    { text: 'já tam vstupuju právě teď', start_sec: 10 },
    { text: 'bitcoin je ready', start_sec: 12 },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].ticker, 'BTC');
  assert.equal(trades[0].ticker_from, 'next_segment');
});

test('extractSignals writes host/kind and drops instrument-less noise', () => {
  const signals = extractSignals(
    [
      { text: 'Bitcoin target 65 000, byli jsme 67', start_sec: 100, end_sec: 105 },
      { text: 'Bitcoin target 65 000, byli jsme 67 a', start_sec: 100, end_sec: 105 },
      { text: 'short. Takže uvidíme, či sem prídeme.', start_sec: 200, end_sec: 205 },
    ],
    { video_id: 'abc', title: 'Live Trading | Oliver Pátek 13.11. 2026' },
  );
  assert.ok(signals.length >= 1);
  assert.equal(PARSER_VERSION, 'fundedmind-10');
  assert.equal(signals[0].parser_version, 'fundedmind-10');
  assert.match(signals[0].rationale, /host=Oliver/);
  assert.match(signals[0].rationale, /kind=live_trading/);
  assert.equal(signals[0].ticker, 'BTC');
  assert.ok(signals.every((s) => s.ticker && s.ticker !== 'UNKNOWN'));
});

test('gold sessions default instrument to XAUUSD when host speaks without naming it', () => {
  const signals = extractSignals(
    [{ text: 'ještě po půlnoci jsem to teda otevřela', start_sec: 50, end_sec: 55 }],
    { video_id: 'g1', title: 'Gold Trading | Sunita Hakimi 10.11. 2026' },
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, 'XAUUSD');
  assert.match(signals[0].rationale, /ticker_from=session_default/);
});

test('SK first-person kupoval som / beriem is an open', () => {
  const a = readSegment('kupoval som to na nasdaqu');
  assert.ok(a);
  assert.equal(a.action, 'open');
  assert.equal(a.side, 'long');

  const b = readSegment('beriem short na eure');
  assert.ok(b);
  assert.equal(b.action, 'open');
  assert.equal(b.side, 'short');
});

test('chart gap open is not a host fill', () => {
  assert.equal(readSegment('pak otevřel třeba gap 50 dolarů'), null);
  assert.equal(readSegment('otvoril gap na zlate'), null);
});

test('stop does not borrow gold from the next segment', () => {
  const trades = readTrades([
    { text: 'dostal jsem stop na 3500', start_sec: 10 },
    { text: 'zlato je slabé', start_sec: 12 },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].action, 'stop_out');
  assert.equal(trades[0].ticker, '');
  assert.equal(trades[0].ticker_from, '');
});

test('open still may take ticker from the next segment', () => {
  const trades = readTrades([
    { text: 'já tam vstupuju právě teď', start_sec: 10 },
    { text: 'zlato je ready', start_sec: 12 },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].ticker, 'XAUUSD');
  assert.equal(trades[0].ticker_from, 'next_segment');
});

test('intent chcel before open is dropped', () => {
  assert.equal(readSegment('som chcel brať short na nazaku'), null);
});

test('nazak maps to NAS100', () => {
  assert.deepEqual(instrumentsIn('na nazaku beriem long'), ['NAS100']);
});

test('gold session default ignores tea buys and bare koupila', () => {
  const tea = extractSignals(
    [{ text: 'já jsem si koupila dneska čajku', start_sec: 10, end_sec: 12 }],
    { video_id: 't1', title: 'Gold Trading | Sunita Hakimi 10.11. 2026' },
  );
  assert.equal(tea.length, 0);

  const desk = extractSignals(
    [{ text: 'ještě po půlnoci jsem to teda otevřela', start_sec: 50, end_sec: 55 }],
    { video_id: 'g1', title: 'Gold Trading | Sunita Hakimi 10.11. 2026' },
  );
  assert.equal(desk.length, 1);
  assert.equal(desk[0].ticker, 'XAUUSD');
});

test('SK Veselovsky desk verbs: bral/nabral/vstupoval/stopka', () => {
  const a = readSegment('A odtiaľto som bral znova short po Vwap');
  assert.ok(a);
  assert.equal(a.action, 'open');
  assert.equal(a.side, 'short');

  const b = readSegment('A nabral som long');
  assert.ok(b);
  assert.equal(b.action, 'open');
  assert.equal(b.side, 'long');

  const c = readSegment('vstupoval som znova na');
  assert.ok(c);
  assert.equal(c.action, 'open');

  const d = readSegment('dostal som stopku na short');
  assert.ok(d);
  assert.equal(d.action, 'stop_out');

  assert.equal(readSegment('krásne, ale nič z toho som nebral'), null);
  assert.equal(readSegment('Zobral by som nejaký krátky long'), null);
  assert.equal(readSegment('takže otvoril som si WhatsApp a hneď to'), null);
  assert.equal(readSegment('kúpil 100k účet s tým kódom'), null);
});

test('Veselovsky live trading defaults unnamed fills to NAS100', () => {
  const signals = extractSignals(
    [
      { text: 'A odtiaľto som bral znova short po Vwap', start_sec: 10, end_sec: 12 },
      { text: 'A nabral som long', start_sec: 20, end_sec: 22 },
    ],
    { video_id: 'v1', title: 'LiveTrading | Michal Veselovský 17.11. 2026' },
  );
  assert.ok(signals.length >= 2);
  assert.ok(signals.every((x) => x.ticker === 'NAS100'));
  assert.equal(PARSER_VERSION, 'fundedmind-10');
});

test('second-person bral is coaching; bare mi stopka is not a fill', () => {
  assert.equal(readSegment('O koľkej si bral short?'), null);
  assert.equal(readSegment('Brali ste dneska nejaký obchod?'), null);
  assert.equal(readSegment('80 bodová stopka. To sa mi moc nechce.'), null);
  assert.ok(readSegment('dostal som stopku na short'));
});

test('Veselovsky chart opens and by-som conditionals are not fills', () => {
  assert.equal(readSegment('Presne táto sviečka ako otvorila, videl'), null);
  assert.equal(readSegment('sa nám otvorila celý deň nejaká RSI'), null);
  assert.equal(readSegment('pozriete, tak on to otvoril a letel'), null);
  assert.equal(readSegment('ho otvoril. Inak inak'), null);
  assert.equal(readSegment('RSI do crossu a tak by som bral short.'), null);
  assert.equal(readSegment('Asi by som dal väčší stopku.'), null);

  const real = readSegment('otvoril som to až na alerte RSI na 15,');
  assert.ok(real);
  assert.equal(real.action, 'open');
});

test('Oliver CZ desk verbs and prev-segment ticker', () => {
  const shortovej = readSegment('Já jsem shortovej, takže mi to');
  assert.ok(shortovej);
  assert.equal(shortovej.action, 'open');
  assert.equal(shortovej.side, 'short');

  const naberu = readSegment('Tady naberu ještě jeden Long teda...');
  assert.ok(naberu);
  assert.equal(naberu.action, 'open');
  assert.equal(naberu.side, 'long');

  assert.equal(readSegment('Kdy jsi vstupoval do obchodu při průrazu'), null);
  assert.equal(readSegment('abych vstupoval na hoře a prodával a'), null);
  assert.equal(readSegment('A ok, Nvidia otevřela, tak za mě za mě'), null);

  const stopLos = readSegment('Stop los mám na lehce pod 39 000');
  assert.ok(stopLos);
  assert.equal(stopLos.action, 'stop_out');

  const trades = readTrades([
    { text: 'dolů. Takže ještě to entry není. Gold', start_sec: 10 },
    { text: 'jsem nabral long', start_sec: 12 },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].ticker, 'XAUUSD');
  assert.equal(trades[0].ticker_from, 'prev_segment');
  assert.equal(trades[0].side, 'long');

  const signals = extractSignals(
    [
      { text: 'dolů. Takže ještě to entry není. Gold', start_sec: 10, end_sec: 12 },
      { text: 'jsem nabral long', start_sec: 12, end_sec: 14 },
    ],
    { video_id: 'ol1', title: 'Live Trading | Oliver Pátek 13.11. 2026' },
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, 'XAUUSD');
  assert.equal(PARSER_VERSION, 'fundedmind-10');
});


test('Oliver hold/exit/vezmu verbs and window ticker borrow', () => {
  const hold = readSegment('Já držím short.');
  assert.ok(hold);
  assert.equal(hold.action, 'open');
  assert.equal(hold.side, 'short');

  const exit = readSegment('zavíral jsem to tady v news');
  assert.ok(exit);
  assert.equal(exit.action, 'exit');

  const vezmu = readSegment('ale já vezmu ještě jeden long.');
  assert.ok(vezmu);
  assert.equal(vezmu.action, 'open');
  assert.equal(vezmu.side, 'long');

  const win = readTrades([
    { text: 'zlato je nahoře', start_sec: 10 },
    { text: 'něco mezi', start_sec: 20 },
    { text: 'Já jsem shortovej', start_sec: 30 },
  ]);
  assert.equal(win.length, 1);
  assert.equal(win[0].ticker, 'XAUUSD');
  assert.match(win[0].ticker_from, /prev2_segment|window_unique/);
});

test('Sumny US30 / SP500 instruments and jsem v shortu', () => {
  assert.deepEqual(instrumentsIn('Já jsem v shortu na US30'), ['US30']);
  assert.deepEqual(instrumentsIn('v longu na SP 500'), ['ES']);
  const a = readSegment('Já jsem v shortu na US30. Tak to je');
  assert.ok(a);
  assert.equal(a.action, 'open');
  assert.equal(a.side, 'short');
  const b = readSegment('já jsem teď v longu na SP 500. Co na to');
  assert.ok(b);
  assert.equal(b.action, 'open');
  assert.equal(b.side, 'long');
  const c = readSegment('Včera jsem bral na SP 500 short a');
  assert.ok(c);
  assert.equal(c.action, 'open');
  assert.equal(c.side, 'short');
});

test('Veselovsky NAS100 default skips when gold is nearby', () => {
  const signals = extractSignals(
    [
      { text: 'na zlate to vypada slabe', start_sec: 10, end_sec: 12 },
      { text: 'A nabral som long', start_sec: 15, end_sec: 17 },
    ],
    { video_id: 'v2', title: 'LiveTrading | Michal Veselovský 17.11. 2026' },
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, 'XAUUSD');
  assert.equal(PARSER_VERSION, 'fundedmind-10');
});
