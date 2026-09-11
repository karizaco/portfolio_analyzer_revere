function compareDateSequence(leftDate, leftSequence, rightDate, rightSequence) {
  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  return (leftSequence || 0) - (rightSequence || 0);
}

function sortSnapshots(rows) {
  return [...rows].sort((left, right) => compareDateSequence(left.as_of_date, left.sequence, right.as_of_date, right.sequence));
}

function sortEvents(rows) {
  return [...rows].sort((left, right) => {
    const byDate = compareDateSequence(left.event_date, left.sequence, right.event_date, right.sequence);
    if (byDate !== 0) {
      return byDate;
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

function sortActions(rows) {
  return [...rows].sort((left, right) => {
    const byDate = compareDateSequence(left.action_date, left.sequence, right.action_date, right.sequence);
    if (byDate !== 0) {
      return byDate;
    }

    if (left.portfolio !== right.portfolio) {
      return left.portfolio.localeCompare(right.portfolio);
    }

    if (left.action_type !== right.action_type) {
      return left.action_type.localeCompare(right.action_type);
    }

    return left.ticker.localeCompare(right.ticker);
  });
}

function formatDecimal(value) {
  if (!Number.isFinite(value)) {
    return '';
  }

  return String(Number(value.toFixed(6)));
}

function isUsablePriceStatus(status) {
  return String(status || '').startsWith('ok');
}

function buildEventId(event) {
  return [
    event.portfolio,
    event.event_date,
    event.sequence,
    event.event_type,
    event.ticker,
    event.source_file
  ].join('|');
}

function buildPositionId(row) {
  return [
    row.portfolio,
    row.ticker,
    row.entry_date,
    row.entry_sequence,
    row.entry_source_file
  ].join('|');
}

function buildActionKey(actionRow, actionType) {
  return [
    actionRow.portfolio,
    actionRow.action_date,
    actionRow.sequence,
    actionType,
    actionRow.ticker
  ].join('|');
}

function buildActionLookup(actionRows) {
  const lookup = new Map();

  for (const row of actionRows) {
    const key = buildActionKey(row, row.action_type);
    const current = lookup.get(key) || [];
    current.push(row);
    lookup.set(key, current);
  }

  return lookup;
}

function findAvailableAction(actionLookup, event, preferredTypes) {
  for (const actionType of preferredTypes) {
    const key = [event.portfolio, event.event_date, event.sequence, actionType, event.ticker].join('|');
    const candidates = actionLookup.get(key) || [];
    const available = candidates.find((row) => !row._consumed);
    if (available) {
      return available;
    }
  }

  return null;
}

function buildEntrySizingPlan(events, actionLookup) {
  const plan = new Map();
  const groups = new Map();

  for (const event of events.filter((row) => row.event_type === 'ENTER')) {
    const groupKey = [event.portfolio, event.event_date, event.sequence].join('|');
    const current = groups.get(groupKey) || [];
    current.push(event);
    groups.set(groupKey, current);
  }

  for (const groupEvents of groups.values()) {
    for (const event of groupEvents) {
      const matchedAction = findAvailableAction(actionLookup, event, ['BUY', 'ADD']);
      if (matchedAction && matchedAction.parsed_percent_value !== '') {
        plan.set(buildEventId(event), {
          matchedAction,
          sizingMethod: 'explicit_action_percent',
          weightFraction: Number(matchedAction.parsed_percent_value) / 100
        });
        continue;
      }

      plan.set(buildEventId(event), {
        matchedAction,
        sizingMethod: 'equal_weight_fallback',
        weightFraction: ''
      });
    }
  }

  return plan;
}

function createLifecycleRow({
  entryAction,
  entryDate,
  entryOrigin,
  entrySequence,
  entrySizingMethod,
  entrySourceFile,
  entryWeightFraction,
  portfolio,
  ticker
}) {
  return {
    adjustment_count: 0,
    adjustment_last_date: '',
    adjustment_percent_total: '',
    current_weight_fraction: '',
    entry_action_type: entryAction ? entryAction.action_type : '',
    entry_date: entryDate,
    entry_origin: entryOrigin,
    entry_percent_text: entryAction ? entryAction.parsed_percent_text : '',
    entry_percent_value: entryAction && entryAction.parsed_percent_value !== ''
      ? String(entryAction.parsed_percent_value)
      : '',
    entry_price: '',
    entry_price_date: '',
    entry_sequence: entrySequence,
    entry_sizing_method: entrySizingMethod,
    entry_source_file: entrySourceFile,
    entry_weight_fraction: entryWeightFraction,
    exit_action_type: '',
    exit_date: '',
    exit_percent_text: '',
    exit_percent_value: '',
    exit_price: '',
    exit_price_date: '',
    exit_sequence: '',
    exit_source_file: '',
    is_open: 'true',
    lifecycle_status: 'pending_price',
    mark_date: '',
    mark_price: '',
    mark_price_date: '',
    portfolio,
    price_source: 'none',
    price_status: 'provider_unconfigured',
    return_pct: '',
    ticker
  };
}

function buildReviewRow({
  details,
  portfolio,
  relatedFile = '',
  reviewBasis,
  reviewDate,
  reviewType,
  sequence,
  sourceFile,
  ticker = ''
}) {
  return {
    details,
    portfolio,
    related_file: relatedFile,
    review_basis: reviewBasis,
    review_date: reviewDate,
    review_type: reviewType,
    sequence,
    source_file: sourceFile,
    ticker
  };
}

function compareLifecycleBoundary(actionRow, lifecycleRow) {
  const startComparison = compareDateSequence(
    actionRow.action_date,
    actionRow.sequence,
    lifecycleRow.entry_date,
    lifecycleRow.entry_sequence
  );
  if (startComparison < 0) {
    return false;
  }

  if (!lifecycleRow.exit_date) {
    return true;
  }

  return compareDateSequence(
    actionRow.action_date,
    actionRow.sequence,
    lifecycleRow.exit_date,
    lifecycleRow.exit_sequence
  ) <= 0;
}

function attachMidLifecycleAdjustments(positionRows, actionRows, reviewRows) {
  const appliedAdjustments = [];

  for (const actionRow of actionRows) {
    if (actionRow._consumed) {
      continue;
    }

    if (!['ADD', 'TRIM'].includes(actionRow.action_type)) {
      reviewRows.push(buildReviewRow({
        details: `${actionRow.action_type} ${actionRow.raw_fragment}`.trim(),
        portfolio: actionRow.portfolio,
        reviewBasis: 'unmatched_action_signal',
        reviewDate: actionRow.action_date,
        reviewType: 'unapplied_action',
        sequence: actionRow.sequence,
        sourceFile: actionRow.source_file,
        ticker: actionRow.ticker
      }));
      continue;
    }

    const matchingLifecycle = positionRows.find((row) => row.portfolio === actionRow.portfolio
      && row.ticker === actionRow.ticker
      && compareLifecycleBoundary(actionRow, row));

    if (!matchingLifecycle) {
      reviewRows.push(buildReviewRow({
        details: `${actionRow.action_type} ${actionRow.raw_fragment}`.trim(),
        portfolio: actionRow.portfolio,
        reviewBasis: 'unmatched_adjustment',
        reviewDate: actionRow.action_date,
        reviewType: 'unapplied_adjustment',
        sequence: actionRow.sequence,
        sourceFile: actionRow.source_file,
        ticker: actionRow.ticker
      }));
      continue;
    }

    matchingLifecycle.adjustment_count += 1;
    matchingLifecycle.adjustment_last_date = actionRow.action_date;
    if (actionRow.parsed_percent_value !== '') {
      const currentTotal = Number(matchingLifecycle.adjustment_percent_total || 0);
      matchingLifecycle.adjustment_percent_total = String(currentTotal + Number(actionRow.parsed_percent_value));
      appliedAdjustments.push({
        action_date: actionRow.action_date,
        action_type: actionRow.action_type,
        parsed_percent_value: Number(actionRow.parsed_percent_value),
        portfolio: actionRow.portfolio,
        raw_fragment: actionRow.raw_fragment,
        sequence: actionRow.sequence,
        source_file: actionRow.source_file,
        ticker: actionRow.ticker
      });
    } else {
      reviewRows.push(buildReviewRow({
        details: `${actionRow.action_type} ${actionRow.raw_fragment}`.trim(),
        portfolio: actionRow.portfolio,
        reviewBasis: 'adjustment_missing_percent',
        reviewDate: actionRow.action_date,
        reviewType: 'unapplied_adjustment',
        sequence: actionRow.sequence,
        sourceFile: actionRow.source_file,
        ticker: actionRow.ticker
      }));
    }

    actionRow._consumed = true;
  }

  return appliedAdjustments;
}

function buildTransactions(positionRows, appliedAdjustments) {
  const transactions = new Map();

  function pushTransaction(portfolio, date, sequence, transaction) {
    const key = [portfolio, date, sequence].join('|');
    const current = transactions.get(key) || [];
    current.push(transaction);
    transactions.set(key, current);
  }

  for (const row of positionRows) {
    if (row.entry_origin === 'event') {
      pushTransaction(row.portfolio, row.entry_date, row.entry_sequence, {
        positionId: buildPositionId(row),
        portfolio: row.portfolio,
        sequence: row.entry_sequence,
        ticker: row.ticker,
        type: 'ENTER'
      });
    }

    if (row.exit_date) {
      pushTransaction(row.portfolio, row.exit_date, row.exit_sequence, {
        positionId: buildPositionId(row),
        portfolio: row.portfolio,
        sequence: row.exit_sequence,
        ticker: row.ticker,
        type: 'EXIT'
      });
    }
  }

  for (const adjustment of appliedAdjustments) {
    pushTransaction(adjustment.portfolio, adjustment.action_date, adjustment.sequence, {
      percentage: adjustment.parsed_percent_value / 100,
      portfolio: adjustment.portfolio,
      sequence: adjustment.sequence,
      ticker: adjustment.ticker,
      type: adjustment.action_type
    });
  }

  return transactions;
}

function sumActiveValues(activePositions) {
  let total = 0;
  for (const positionState of activePositions.values()) {
    total += positionState.value;
  }

  return total;
}

function fundAllocation(activePositions, cashValue, requiredValue, excludePositionIds = new Set()) {
  let remainingCash = cashValue;
  if (requiredValue <= remainingCash) {
    return {
      cashValue: remainingCash - requiredValue,
      fundedValue: requiredValue
    };
  }

  let remainingNeed = requiredValue - remainingCash;
  remainingCash = 0;
  const donors = [...activePositions.entries()]
    .filter(([positionId]) => !excludePositionIds.has(positionId));
  const donorTotal = donors.reduce((sum, [, positionState]) => sum + positionState.value, 0);
  if (!donorTotal) {
    return {
      cashValue: remainingCash,
      fundedValue: requiredValue - remainingNeed
    };
  }

  const withdrawal = Math.min(remainingNeed, donorTotal);
  const dilutionRatio = donorTotal > 0 ? withdrawal / donorTotal : 0;
  for (const [, positionState] of donors) {
    positionState.value -= positionState.value * dilutionRatio;
  }

  remainingNeed -= withdrawal;
  return {
    cashValue: remainingCash,
    fundedValue: requiredValue - remainingNeed
  };
}

async function applyIntervalReturns(activePositions, fromDate, toDate, priceProvider) {
  let missingPriceCount = 0;

  for (const positionState of activePositions.values()) {
    const startPoint = await priceProvider.getPricePoint(positionState.ticker, fromDate);
    const endPoint = await priceProvider.getPricePoint(positionState.ticker, toDate);
    const startPrice = Number(startPoint.price);
    const endPrice = Number(endPoint.price);

    if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice === 0) {
      missingPriceCount += 1;
      continue;
    }

    positionState.value *= endPrice / startPrice;
  }

  return missingPriceCount;
}

function collectPortfolioSnapshots(sortedSnapshots, portfolioKey) {
  return sortedSnapshots.filter((row) => {
    const holdings = row[`${portfolioKey}_holdings`] || [];
    const metricsPresent = row[`${portfolioKey}_metric_scalar`] || row[`${portfolioKey}_metric_1`] || row[`${portfolioKey}_metric_2`];
    return holdings.length || metricsPresent;
  });
}

function buildCurveStatus(missingPriceCount) {
  return missingPriceCount ? 'partial_price_data' : 'ok';
}

async function buildCurveRows(sortedSnapshots, positionRows, appliedAdjustments, priceProvider) {
  const curveRows = [];
  const latestStateByPortfolio = new Map();
  const transactions = buildTransactions(positionRows, appliedAdjustments);
  const positionsById = new Map(positionRows.map((row) => [buildPositionId(row), row]));

  for (const portfolioKey of ['gro', 'turbo']) {
    const portfolio = portfolioKey.toUpperCase();
    const portfolioSnapshots = collectPortfolioSnapshots(sortedSnapshots, portfolioKey);
    if (!portfolioSnapshots.length) {
      continue;
    }

    const activePositions = new Map();
    let cashValue = 0;
    let previousSnapshot = null;

    const baselineRows = positionRows.filter((row) => row.portfolio === portfolio
      && row.entry_origin === 'baseline'
      && row.entry_date === portfolioSnapshots[0].as_of_date
      && row.entry_sequence === portfolioSnapshots[0].sequence);
    const rawBaselineTotal = baselineRows.reduce((sum, row) => sum + Number(row.entry_weight_fraction || 0), 0);
    for (const row of baselineRows) {
      const rawWeight = Number(row.entry_weight_fraction || 0);
      const normalizedWeight = rawBaselineTotal > 0 ? rawWeight / rawBaselineTotal : 0;
      row.entry_weight_fraction = formatDecimal(normalizedWeight);
      activePositions.set(buildPositionId(row), {
        ticker: row.ticker,
        value: normalizedWeight
      });
    }

    for (const snapshot of portfolioSnapshots) {
      let missingPriceCount = 0;
      if (previousSnapshot) {
        missingPriceCount = await applyIntervalReturns(
          activePositions,
          previousSnapshot.as_of_date,
          snapshot.as_of_date,
          priceProvider
        );
      }

      let equityValue = cashValue + sumActiveValues(activePositions);
      if (equityValue <= 0) {
        equityValue = 1;
      }

      const transactionKey = [portfolio, snapshot.as_of_date, snapshot.sequence].join('|');
      const currentTransactions = transactions.get(transactionKey) || [];
      const exits = currentTransactions.filter((transaction) => transaction.type === 'EXIT');
      const trims = currentTransactions.filter((transaction) => transaction.type === 'TRIM');
      const explicitEntries = currentTransactions.filter((transaction) => {
        if (transaction.type !== 'ENTER') {
          return false;
        }

        const row = positionsById.get(transaction.positionId);
        return row && row.entry_sizing_method === 'explicit_action_percent';
      });
      const fallbackEntries = currentTransactions.filter((transaction) => {
        if (transaction.type !== 'ENTER') {
          return false;
        }

        const row = positionsById.get(transaction.positionId);
        return row && row.entry_sizing_method === 'equal_weight_fallback';
      });
      const adds = currentTransactions.filter((transaction) => transaction.type === 'ADD');

      for (const exitTransaction of exits) {
        const currentPosition = activePositions.get(exitTransaction.positionId);
        if (!currentPosition) {
          continue;
        }

        cashValue += currentPosition.value;
        activePositions.delete(exitTransaction.positionId);
        positionsById.get(exitTransaction.positionId).current_weight_fraction = '0';
      }

      equityValue = cashValue + sumActiveValues(activePositions);
      for (const trimTransaction of trims) {
        const matchingEntry = [...activePositions.entries()].find(([positionId]) => {
          const row = positionsById.get(positionId);
          return row && row.portfolio === trimTransaction.portfolio && row.ticker === trimTransaction.ticker;
        });
        if (!matchingEntry) {
          continue;
        }

        const currentPosition = matchingEntry[1];
        const trimValue = Math.min(currentPosition.value, trimTransaction.percentage * equityValue);
        currentPosition.value -= trimValue;
        cashValue += trimValue;
      }

      equityValue = cashValue + sumActiveValues(activePositions);
      for (const explicitEntry of explicitEntries) {
        const row = positionsById.get(explicitEntry.positionId);
        const targetWeight = Number(row.entry_weight_fraction);
        const targetValue = Number.isFinite(targetWeight) ? targetWeight * equityValue : 0;
        const funded = fundAllocation(activePositions, cashValue, targetValue);
        cashValue = funded.cashValue;
        activePositions.set(explicitEntry.positionId, {
          ticker: row.ticker,
          value: funded.fundedValue
        });
      }

      equityValue = cashValue + sumActiveValues(activePositions);
      for (const addTransaction of adds) {
        const matchingEntry = [...activePositions.entries()].find(([positionId]) => {
          const row = positionsById.get(positionId);
          return row && row.portfolio === addTransaction.portfolio && row.ticker === addTransaction.ticker;
        });
        if (!matchingEntry) {
          continue;
        }

        const addValue = addTransaction.percentage * equityValue;
        const funded = fundAllocation(activePositions, cashValue, addValue, new Set([matchingEntry[0]]));
        cashValue = funded.cashValue;
        matchingEntry[1].value += funded.fundedValue;
      }

      equityValue = cashValue + sumActiveValues(activePositions);
      if (fallbackEntries.length) {
        const targetWeight = 1 / (activePositions.size + fallbackEntries.length);
        const targetValue = targetWeight * equityValue;
        const totalTargetValue = targetValue * fallbackEntries.length;
        const funded = fundAllocation(activePositions, cashValue, totalTargetValue);
        cashValue = funded.cashValue;
        const valuePerEntry = fallbackEntries.length ? funded.fundedValue / fallbackEntries.length : 0;

        for (const fallbackEntry of fallbackEntries) {
          const row = positionsById.get(fallbackEntry.positionId);
          row.entry_weight_fraction = formatDecimal(equityValue > 0 ? valuePerEntry / equityValue : 0);
          activePositions.set(fallbackEntry.positionId, {
            ticker: row.ticker,
            value: valuePerEntry
          });
        }
      }

      equityValue = cashValue + sumActiveValues(activePositions);
      const investedValue = sumActiveValues(activePositions);
      for (const row of positionRows) {
        if (row.portfolio === portfolio && row.is_open === 'true') {
          row.current_weight_fraction = '0';
        }
      }
      for (const [positionId, positionState] of activePositions.entries()) {
        const row = positionsById.get(positionId);
        row.current_weight_fraction = formatDecimal(equityValue > 0 ? positionState.value / equityValue : 0);
      }

      const curveStatus = previousSnapshot ? buildCurveStatus(missingPriceCount) : 'baseline';
      const pricedPositions = previousSnapshot ? Math.max(activePositions.size - missingPriceCount, 0) : activePositions.size;
      const unpricedPositions = previousSnapshot ? missingPriceCount : 0;
      curveRows.push({
        as_of_date: snapshot.as_of_date,
        cash_weight: formatDecimal(equityValue > 0 ? cashValue / equityValue : 0),
        curve_status: curveStatus,
        estimated_equity_index: formatDecimal(equityValue),
        observed_metric_1: snapshot[`${portfolioKey}_metric_1`] || '',
        observed_metric_2: snapshot[`${portfolioKey}_metric_2`] || '',
        observed_metric_scalar: snapshot[`${portfolioKey}_metric_scalar`] || '',
        open_positions: activePositions.size,
        portfolio,
        priced_positions: pricedPositions,
        unpriced_positions: unpricedPositions,
        weighted_exposure: formatDecimal(equityValue > 0 ? investedValue / equityValue : 0)
      });

      latestStateByPortfolio.set(portfolio, {
        cash_weight: formatDecimal(equityValue > 0 ? cashValue / equityValue : 0),
        estimated_equity_index: formatDecimal(equityValue),
        invested_weight: formatDecimal(equityValue > 0 ? investedValue / equityValue : 0),
        price_status: curveStatus
      });
      previousSnapshot = snapshot;
    }
  }

  return {
    curveRows,
    latestStateByPortfolio
  };
}

function buildSummaryRows(positionRows, reviewRows, snapshots, latestStateByPortfolio) {
  const portfolios = [...new Set(positionRows.map((row) => row.portfolio))];
  return portfolios.map((portfolio) => {
    const relevantSnapshots = snapshots.filter((row) => Array.isArray(row[`${portfolio.toLowerCase()}_holdings`]) && row[`${portfolio.toLowerCase()}_holdings`].length > 0);
    const latestSnapshot = sortSnapshots(relevantSnapshots).at(-1);
    const relevantRows = positionRows.filter((row) => row.portfolio === portfolio);
    const latestState = latestStateByPortfolio.get(portfolio) || {};

    return {
      as_of_date: latestSnapshot ? latestSnapshot.as_of_date : '',
      assumed_equal_weight_entries: relevantRows.filter((row) => row.entry_sizing_method === 'equal_weight_fallback').length,
      baseline_positions: relevantRows.filter((row) => row.entry_origin === 'baseline').length,
      cash_weight: latestState.cash_weight || '',
      closed_positions: relevantRows.filter((row) => row.is_open === 'false').length,
      estimated_equity_index: latestState.estimated_equity_index || '',
      explicit_weight_entries: relevantRows.filter((row) => row.entry_sizing_method === 'explicit_action_percent').length,
      invested_weight: latestState.invested_weight || '',
      open_positions: relevantRows.filter((row) => row.is_open === 'true').length,
      portfolio,
      price_status: latestState.price_status || 'provider_unconfigured',
      review_rows: reviewRows.filter((row) => row.portfolio === portfolio).length,
      total_adjustments: relevantRows.reduce((sum, row) => sum + Number(row.adjustment_count || 0), 0),
      unpriced_positions: relevantRows.filter((row) => !isUsablePriceStatus(row.price_status)).length
    };
  });
}

async function enrichPrices(positionRows, priceProvider) {
  const reviewRows = [];

  for (const row of positionRows) {
    const prices = await priceProvider.getPositionPrices(row);
    row.entry_price = prices.entryPrice === undefined ? '' : prices.entryPrice;
    row.entry_price_date = prices.entryPriceDate === undefined ? '' : prices.entryPriceDate;
    row.exit_price = prices.exitPrice === undefined ? '' : prices.exitPrice;
    row.exit_price_date = prices.exitPriceDate === undefined ? '' : prices.exitPriceDate;
    row.mark_date = prices.markDate === undefined ? row.mark_date : prices.markDate;
    row.mark_price = prices.markPrice === undefined ? '' : prices.markPrice;
    row.mark_price_date = prices.markPriceDate === undefined ? '' : prices.markPriceDate;
    row.price_source = prices.priceSource || 'none';
    row.price_status = prices.priceStatus || 'provider_unconfigured';

    const realizedExit = row.exit_price !== '' ? Number(row.exit_price) : null;
    const markPrice = row.mark_price !== '' ? Number(row.mark_price) : null;
    const entryPrice = row.entry_price !== '' ? Number(row.entry_price) : null;
    const terminalPrice = realizedExit !== null ? realizedExit : markPrice;
    if (entryPrice !== null && terminalPrice !== null && entryPrice !== 0) {
      row.return_pct = formatDecimal(((terminalPrice - entryPrice) / entryPrice) * 100);
      row.lifecycle_status = row.is_open === 'true' ? 'open_priced' : 'closed_priced';
    } else {
      row.lifecycle_status = row.is_open === 'true' ? 'open_unpriced' : 'closed_unpriced';
    }

    if (!isUsablePriceStatus(row.price_status)) {
      reviewRows.push(buildReviewRow({
        details: `Price lookup status: ${row.price_status}`,
        portfolio: row.portfolio,
        reviewBasis: row.price_status,
        reviewDate: row.is_open === 'true' ? row.mark_date : (row.exit_date || row.entry_date),
        reviewType: 'price_lookup_issue',
        sequence: row.is_open === 'true' ? row.entry_sequence : (row.exit_sequence || row.entry_sequence),
        sourceFile: row.is_open === 'true' ? row.entry_source_file : (row.exit_source_file || row.entry_source_file),
        ticker: row.ticker
      }));
    }
  }

  return reviewRows;
}

async function calculatePerformance({ actionReviewRows, actionRows, events, priceProvider, snapshots }) {
  const positionRows = [];
  const reviewRows = [];
  const openPositions = new Map();
  const sortedSnapshots = sortSnapshots(snapshots);
  const sortedEvents = sortEvents(events);
  const trustedActionRows = sortActions(actionRows).map((row) => ({ ...row }));
  const actionLookup = buildActionLookup(trustedActionRows);
  const entrySizingPlan = buildEntrySizingPlan(sortedEvents, actionLookup);

  for (const actionReviewRow of actionReviewRows) {
    reviewRows.push(buildReviewRow({
      details: `${actionReviewRow.action_type} ${actionReviewRow.raw_fragment}`.trim(),
      portfolio: actionReviewRow.portfolio,
      reviewBasis: actionReviewRow.parse_basis,
      reviewDate: actionReviewRow.action_date,
      reviewType: 'action_parse_review',
      sequence: actionReviewRow.sequence,
      sourceFile: actionReviewRow.source_file,
      ticker: actionReviewRow.ticker
    }));
  }

  for (const portfolioKey of ['gro', 'turbo']) {
    const portfolio = portfolioKey.toUpperCase();
    const firstSnapshot = sortedSnapshots.find((row) => Array.isArray(row[`${portfolioKey}_holdings`]) && row[`${portfolioKey}_holdings`].length > 0);
    if (!firstSnapshot) {
      continue;
    }

    const holdings = firstSnapshot[`${portfolioKey}_holdings`];
    const baselineWeight = holdings.length ? String(1 / holdings.length) : '';
    for (const ticker of holdings) {
      const lifecycle = createLifecycleRow({
        entryAction: null,
        entryDate: firstSnapshot.as_of_date,
        entryOrigin: 'baseline',
        entrySequence: firstSnapshot.sequence,
        entrySizingMethod: 'baseline_equal_weight',
        entrySourceFile: firstSnapshot.source_file,
        entryWeightFraction: baselineWeight,
        portfolio,
        ticker
      });
      openPositions.set(`${portfolio}|${ticker}`, lifecycle);
      positionRows.push(lifecycle);
    }
  }

  for (const event of sortedEvents) {
    const positionKey = `${event.portfolio}|${event.ticker}`;
    if (event.event_type === 'ENTER') {
      if (openPositions.has(positionKey)) {
        reviewRows.push(buildReviewRow({
          details: 'Existing open lifecycle prevented a new ENTER event from opening a second position.',
          portfolio: event.portfolio,
          relatedFile: openPositions.get(positionKey).entry_source_file,
          reviewBasis: 'duplicate_enter_open_position',
          reviewDate: event.event_date,
          reviewType: 'lifecycle_mismatch',
          sequence: event.sequence,
          sourceFile: event.source_file,
          ticker: event.ticker
        }));
        continue;
      }

      const sizingPlan = entrySizingPlan.get(buildEventId(event)) || {
        matchedAction: findAvailableAction(actionLookup, event, ['BUY', 'ADD']),
        sizingMethod: 'missing_sizing',
        weightFraction: ''
      };

      if (sizingPlan.matchedAction) {
        sizingPlan.matchedAction._consumed = true;
      }

      const lifecycle = createLifecycleRow({
        entryAction: sizingPlan.matchedAction,
        entryDate: event.event_date,
        entryOrigin: 'event',
        entrySequence: event.sequence,
        entrySizingMethod: sizingPlan.sizingMethod,
        entrySourceFile: event.source_file,
        entryWeightFraction: sizingPlan.weightFraction === '' ? '' : String(sizingPlan.weightFraction),
        portfolio: event.portfolio,
        ticker: event.ticker
      });
      openPositions.set(positionKey, lifecycle);
      positionRows.push(lifecycle);
      continue;
    }

    const lifecycle = openPositions.get(positionKey);
    if (!lifecycle) {
      reviewRows.push(buildReviewRow({
        details: 'EXIT event had no matching open lifecycle.',
        portfolio: event.portfolio,
        relatedFile: event.previous_source_file,
        reviewBasis: 'unmatched_exit_event',
        reviewDate: event.event_date,
        reviewType: 'lifecycle_mismatch',
        sequence: event.sequence,
        sourceFile: event.source_file,
        ticker: event.ticker
      }));
      continue;
    }

    const matchedAction = findAvailableAction(actionLookup, event, ['SELL', 'TRIM']);
    if (matchedAction) {
      matchedAction._consumed = true;
    }

    lifecycle.exit_action_type = matchedAction ? matchedAction.action_type : '';
    lifecycle.exit_date = event.event_date;
    lifecycle.exit_percent_text = matchedAction ? matchedAction.parsed_percent_text : '';
    lifecycle.exit_percent_value = matchedAction && matchedAction.parsed_percent_value !== ''
      ? String(matchedAction.parsed_percent_value)
      : '';
    lifecycle.exit_sequence = event.sequence;
    lifecycle.exit_source_file = event.source_file;
    lifecycle.is_open = 'false';
    openPositions.delete(positionKey);
  }

  const latestDatesByPortfolio = new Map();
  for (const snapshot of sortedSnapshots) {
    for (const portfolioKey of ['gro', 'turbo']) {
      if (Array.isArray(snapshot[`${portfolioKey}_holdings`]) && snapshot[`${portfolioKey}_holdings`].length > 0) {
        latestDatesByPortfolio.set(portfolioKey.toUpperCase(), snapshot.as_of_date);
      }
    }
  }

  for (const row of positionRows) {
    if (row.is_open === 'true') {
      row.mark_date = latestDatesByPortfolio.get(row.portfolio) || '';
    }
  }

  const appliedAdjustments = attachMidLifecycleAdjustments(positionRows, trustedActionRows, reviewRows);
  const priceReviewRows = await enrichPrices(positionRows, priceProvider);
  reviewRows.push(...priceReviewRows);

  const curveState = await buildCurveRows(sortedSnapshots, positionRows, appliedAdjustments, priceProvider);
  const summaryRows = buildSummaryRows(positionRows, reviewRows, sortedSnapshots, curveState.latestStateByPortfolio);

  positionRows.sort((left, right) => {
    const byEntry = compareDateSequence(left.entry_date, left.entry_sequence, right.entry_date, right.entry_sequence);
    if (byEntry !== 0) {
      return byEntry;
    }

    if (left.portfolio !== right.portfolio) {
      return left.portfolio.localeCompare(right.portfolio);
    }

    return left.ticker.localeCompare(right.ticker);
  });

  reviewRows.sort((left, right) => {
    const byDate = compareDateSequence(left.review_date, left.sequence, right.review_date, right.sequence);
    if (byDate !== 0) {
      return byDate;
    }

    if (left.portfolio !== right.portfolio) {
      return left.portfolio.localeCompare(right.portfolio);
    }

    if (left.review_type !== right.review_type) {
      return left.review_type.localeCompare(right.review_type);
    }

    return left.ticker.localeCompare(right.ticker);
  });

  return {
    curveRows: curveState.curveRows,
    positionRows,
    reviewRows,
    summaryRows
  };
}

module.exports = {
  calculatePerformance
};