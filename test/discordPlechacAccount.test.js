'use strict';

// The book a message is about.
//
// The rule is "the risky book is the one the message calls a RISKY
// PORTFOLIO", and it is not the same as "the message mentions the word
// risky". His 2025-12-22 message publishes his ONE PUBLIC INVESTMENT
// ACCOUNT and mentions the risky book in passing, on another account --
// so the naive test filed an 84-holding book under the risky account.

const assert = require('node:assert/strict');
const test = require('node:test');

const { accountOfMessage } = require('../src/discord/plechac/sources');

test('a message that publishes his PUBLIC account is the MAIN book', () => {
  // "Nize najdete me portfolio ke dni 21. 12. 2025 ... Jedna se o muj
  // jeden investicni ucet, ktery je od zacatku veden jako verejny ... a
  // 'rizky pozice' na dalsim XTB uctu".
  const message = [
    'Níže najdete mé portfolio ke dni 21. 12. 2025, kdy jsem stahoval data z XTB.',
    'Jedná se o můj jeden investiční účet, který je od začátku veden jako veřejný',
    'pro určitou transparentnost a možnost edukovat ostatní.',
    '„risky pozice“ na dalším XTB účtu, kde jsem posledně přidával RACE a UBER ✅',
  ].join(' ');
  assert.equal(accountOfMessage(message), 'main');
});

test('a message that publishes the RISKY portfolio is the risky book', () => {
  // "Tohle je moje male RISKY portfolio na XTB".
  assert.equal(
    accountOfMessage('Tohle je moje malé RISKY portfolio na XTB, které jsem založil pro sdílení investic/tradů.'),
    'risky',
  );
  // "neco malo k RISKY portfoliu a aktualizoval pozice".
  assert.equal(
    accountOfMessage('Sepsal jsem něco málo k RISKY portfoliu a aktualizoval pozice 🚨'),
    'risky',
  );
});

test('a message that says nothing about the risky book is the MAIN book', () => {
  assert.equal(accountOfMessage('Tahouni jsou pozadu, Earnings to bude další týdny hodně míchat...'), 'main');
  assert.equal(accountOfMessage(''), 'main');
});
