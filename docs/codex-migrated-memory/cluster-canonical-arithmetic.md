---
name: cluster-canonical-arithmetic
description: "The clusterer's candidate edit distances must be MEASURED, not assumed — \"ARCO is one edit from ARQQ\" was wrong and cost a whole rule design"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-03T04:00:33.182Z
---

When a rule's correctness depends on an edit distance, **compute it** — don't
reason about it. `ARCO → ARQQ` looks like one substitution (`C→Q`) but is
**two** (`C→Q` and `O→Q`). An entire rule ("prefer the closest correction
across the cluster's members") was designed on that false premise, and the
unit test caught it: the candidates all tied at distance 2, so the rule
changed nothing.

The tie is what made it invisible. Two candidate sets that tie cannot be
ordered by distance, so the rule silently fell back to the shipped behaviour
and looked like "no effect" rather than "wrong premise".

**Why:** the project's own CLAUDE.md rule is that a measurement decides whether
a change ships — but a measurement on a wrong premise is a measurement of the
wrong thing, and it can look like a negative result when it is really a bug in
the reasoning.

**How to apply:** when a rule turns on a distance, a count, or a tie-break,
print the actual numbers (a tiny script over the real corpus) BEFORE designing
the rule. When a rule measures "no change", suspect the premise before
concluding the idea is bad. Related: [[pixel-verified-aliases]] (the same
"locate it on the pixels first" discipline, for alias rows), and
[[qmg-ocr-2023-improvements]] (the clusterer's role in the merged list).
