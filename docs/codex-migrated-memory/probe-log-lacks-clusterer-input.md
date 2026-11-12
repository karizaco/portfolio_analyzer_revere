---
name: probe-log-lacks-clusterer-input
description: "The probe log does NOT carry the clusterer's input — re-clustering the log's frames gives a different clustering than production ran"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-03T09:14:42.847Z
---

The QMG probe log records `captures`, `top_candidates` and
`top_rejected_candidates` — each a **summary**. But the clusterer is fed
**every OCR'd candidate frame** (`scanResult.candidates`). Re-clustering the
log's own frames does **not** reproduce the log's own `merged_raw_token_clusters`:

- 0 of 15 logs with frames reproduce their cluster table exactly
- 37 logs carry no frames at all
- e.g. `20220607` keeps 4 frames → 6 clusters, against the 34 production recorded

**Why:** two consequences that silently invalidate measurements.

1. Any measurement that **re-clusters the log's frames** is measuring a
   different clustering than production ran. Use the recorded cluster tables
   instead — they are the only faithful record of what production formed.
2. A rule that needs a **per-token frame count** cannot be measured from the
   logs at all: the tables record a cluster's `frequency` (the SUM over its
   members) and not each member's own count. Such a rule has to be measured
   by a **production scan**, and its evidence has to travel with the cluster
   (the probe log now records `swallowedEvidence` for this reason).

**How to apply:** before measuring a clusterer change over the corpus, check
whether the change can be expressed against the recorded cluster tables. If
it needs per-member counts, run a production scan — and don't trust a
corpus-only number. Related: [[clusterer-measurement-by-log-replay]],
[[cluster-canonical-arithmetic]].
