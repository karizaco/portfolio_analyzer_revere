#!/usr/bin/env bash
# Launch the 2023-era candidate-pool prefilter-resolution sweep.
#
# The sweep is the WIDE measurement CLAUDE.md requires before the prefilter's
# working resolution can change. It needs no OCR: the labels it scores against
# are already in the probe logs (the retained OCR candidate pool).
#
# STRIDE=100000 means "score the labelled frames plus index 0" — i.e. rank the
# frames the prefilter KEPT, which is the question this measurement asks.
set -u

# The repository root is derived from this script's own location, so the
# wrapper runs on any machine and in any clone. A hardcoded "C:/Users/..."
# path would make this file a one-machine artefact.
cd "$(dirname "$0")/.." || exit 1

export PREFILTER_SWEEP_DATES=20230518,20230522,20230523,20230602,20230605,20230608,20230609,20231201,20231215
export PREFILTER_SWEEP_ERA=2023
export PREFILTER_SWEEP_STRIDE=100000
export PREFILTER_SWEEP_OUT=data/prefilter_resolution_sweep_2023.json

node --test test/manual/prefilterResolutionSweep.test.js
