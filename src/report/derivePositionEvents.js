const { extractActionSignals, findBestCorrection } = require('../normalize/repairHoldings');

function derivePositionEvents(rows) {
  const trustedEvents = [];
  const reviewEvents = [];

  for (const portfolioKey of ['gro', 'turbo']) {
    const portfolioRows = rows.filter((row) => Array.isArray(row[`${portfolioKey}_holdings`]) && row[`${portfolioKey}_holdings`].length > 0);

    for (let index = 1; index < portfolioRows.length; index += 1) {
      const previousRow = portfolioRows[index - 1];
      const currentRow = portfolioRows[index];
      const previousHoldings = new Set(previousRow[`${portfolioKey}_holdings`]);
      const currentHoldings = new Set(currentRow[`${portfolioKey}_holdings`]);
      const previousSuspicious = new Set(previousRow[`${portfolioKey}_suspicious_tickers`] || []);
      const currentSuspicious = new Set(currentRow[`${portfolioKey}_suspicious_tickers`] || []);
      const actionSignals = extractActionSignals(currentRow[`${portfolioKey}_action_text`] || '');
      const buyLikeTickers = new Set([...actionSignals.BUY, ...actionSignals.ADD]);
      const sellLikeTickers = new Set(actionSignals.SELL);
      const hasDirectionalSignals = buyLikeTickers.size > 0 || sellLikeTickers.size > 0;
      const currentNoChanges = currentRow[`${portfolioKey}_no_changes`] === 'true';

      const currentOnly = currentRow[`${portfolioKey}_holdings`].filter((ticker) => !previousHoldings.has(ticker));
      const previousOnly = previousRow[`${portfolioKey}_holdings`].filter((ticker) => !currentHoldings.has(ticker));
      const usedCurrentOnly = new Set();
      const usedPreviousOnly = new Set();

      for (const ticker of currentOnly) {
        const event = buildEvent({
          actionContext: currentRow[`${portfolioKey}_action_text`] || '',
          eventDate: currentRow.as_of_date,
          eventType: 'ENTER',
          portfolioKey,
          previousSourceFile: previousRow.source_file,
          repairBasis: 'holdings_diff',
          sequence: currentRow.sequence,
          sourceFile: currentRow.source_file,
          ticker
        });

        const trusted = !currentSuspicious.has(ticker)
          && !currentNoChanges
          && (buyLikeTickers.has(ticker)
            || (!hasDirectionalSignals && previousSuspicious.size === 0 && currentSuspicious.size === 0));
        if (trusted) {
          event.repair_basis = buyLikeTickers.has(ticker) ? 'action_match' : 'holdings_diff';
          trustedEvents.push(event);
          usedCurrentOnly.add(ticker);
          continue;
        }

        event.event_status = 'review';
        event.repair_basis = currentNoChanges
          ? 'no_changes_conflict'
          : (hasDirectionalSignals ? 'action_conflict' : 'suspicious_holdings');
        reviewEvents.push(event);
      }

      for (const ticker of previousOnly) {
        const event = buildEvent({
          actionContext: currentRow[`${portfolioKey}_action_text`] || '',
          eventDate: currentRow.as_of_date,
          eventType: 'EXIT',
          portfolioKey,
          previousSourceFile: previousRow.source_file,
          repairBasis: 'holdings_diff',
          sequence: currentRow.sequence,
          sourceFile: currentRow.source_file,
          ticker
        });

        const trusted = !previousSuspicious.has(ticker)
          && !currentNoChanges
          && (sellLikeTickers.has(ticker)
            || (!hasDirectionalSignals && currentSuspicious.size === 0 && previousSuspicious.size === 0));
        if (trusted) {
          event.repair_basis = sellLikeTickers.has(ticker) ? 'action_match' : 'holdings_diff';
          trustedEvents.push(event);
          usedPreviousOnly.add(ticker);
          continue;
        }

        event.event_status = 'review';
        event.repair_basis = currentNoChanges
          ? 'no_changes_conflict'
          : (hasDirectionalSignals ? 'action_conflict' : 'suspicious_holdings');
        reviewEvents.push(event);
      }

      reconcileActionSignals({
        actionContext: currentRow[`${portfolioKey}_action_text`] || '',
        actionTickers: buyLikeTickers,
        candidateEvents: trustedEvents,
        currentOnly,
        currentRow,
        currentSuspicious,
        eventType: 'ENTER',
        portfolioKey,
        previousSourceFile: previousRow.source_file,
        reviewEvents,
        sequence: currentRow.sequence,
        sourceFile: currentRow.source_file,
        usedTokens: usedCurrentOnly
      });

      reconcileActionSignals({
        actionContext: currentRow[`${portfolioKey}_action_text`] || '',
        actionTickers: sellLikeTickers,
        candidateEvents: trustedEvents,
        currentOnly: previousOnly,
        currentRow,
        currentSuspicious: previousSuspicious,
        eventType: 'EXIT',
        portfolioKey,
        previousSourceFile: previousRow.source_file,
        reviewEvents,
        sequence: currentRow.sequence,
        sourceFile: currentRow.source_file,
        usedTokens: usedPreviousOnly
      });
    }
  }

  sortEvents(trustedEvents);
  sortEvents(reviewEvents);

  return {
    reviewEvents,
    trustedEvents
  };
}

function buildEvent({
  actionContext,
  eventDate,
  eventType,
  portfolioKey,
  previousSourceFile,
  repairBasis,
  sequence,
  sourceFile,
  ticker
}) {
  return {
    action_context: actionContext,
    event_date: eventDate,
    event_status: 'trusted',
    event_type: eventType,
    portfolio: portfolioKey.toUpperCase(),
    previous_source_file: previousSourceFile,
    repair_basis: repairBasis,
    sequence,
    source_file: sourceFile,
    ticker
  };
}

function reconcileActionSignals({
  actionContext,
  actionTickers,
  candidateEvents,
  currentOnly,
  currentRow,
  currentSuspicious,
  eventType,
  portfolioKey,
  previousSourceFile,
  reviewEvents,
  sequence,
  sourceFile,
  usedTokens
}) {
  if (!actionTickers.size || currentRow[`${portfolioKey}_no_changes`] === 'true') {
    return;
  }

  const referenceScores = new Map();
  for (const ticker of actionTickers) {
    referenceScores.set(ticker, 10);
  }

  for (const expectedTicker of actionTickers) {
    if (usedTokens.has(expectedTicker)) {
      continue;
    }

    const exactMatch = currentOnly.find((token) => token === expectedTicker);
    if (exactMatch) {
      usedTokens.add(expectedTicker);
      continue;
    }

    let replacement = null;
    for (const token of currentOnly) {
      if (!currentSuspicious.has(token)) {
        continue;
      }

      const correction = findBestCorrection(token, referenceScores, true);
      if (correction && correction.candidate === expectedTicker) {
        replacement = token;
        break;
      }
    }

    if (!replacement) {
      continue;
    }

    const reviewIndex = reviewEvents.findIndex((event) => event.portfolio === portfolioKey.toUpperCase()
      && event.event_date === currentRow.as_of_date
      && event.event_type === eventType
      && event.ticker === replacement);
    if (reviewIndex >= 0) {
      reviewEvents.splice(reviewIndex, 1);
    }

    candidateEvents.push(buildEvent({
      actionContext,
      eventDate: currentRow.as_of_date,
      eventType,
      portfolioKey,
      previousSourceFile,
      repairBasis: 'action_signal_correction',
      sequence,
      sourceFile,
      ticker: expectedTicker
    }));
    usedTokens.add(expectedTicker);
  }
}

function sortEvents(events) {
  events.sort((left, right) => {
    if (left.event_date !== right.event_date) {
      return left.event_date.localeCompare(right.event_date);
    }

    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    if (left.portfolio !== right.portfolio) {
      return left.portfolio.localeCompare(right.portfolio);
    }

    if (left.event_type !== right.event_type) {
      return left.event_type.localeCompare(right.event_type);
    }

    return left.ticker.localeCompare(right.ticker);
  });
}

module.exports = {
  derivePositionEvents
};
