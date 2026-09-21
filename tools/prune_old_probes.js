#!/usr/bin/env node
'use strict';

const path = require("node:path");
const fs2 = require("node:fs");

const ROOT = path.resolve(__dirname, "..", "data");
const LARGE_DIR_THRESHOLD_MB = 10;

function getDirSizeMB(dir) {
  let size = 0;
  try {
    const stat = fs2.statSync(dir);
    if (!stat.isDirectory()) return 0;
    const entries = fs2.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { size += getDirSizeMB(full); }
      else { try { size += fs2.statSync(full).size; } catch { /* skip */ } }
    }
  } catch { return 0; }
  return size / (1024 * 1024);
}

function directoryAgeMs(dir) {
  try { return fs2.statSync(dir).mtimeMs; } catch { return 0; }
}

function groupByFamily(dirs) {
  const groups = new Map();
  for (const dir of dirs) {
    const base = path.basename(dir);
    const family = base.replace(/-d+$/, "").replace(/([a-z]+)d+$/i, "$1");
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(dir);
  }
  return groups;
}

function sortNewest(dirs) {
  return dirs.slice().sort((a, b) => directoryAgeMs(b) - directoryAgeMs(a));
}

function scanProbeDir(keepCount) {
  const probeRoot = path.join(ROOT, "video_ocr_probe");
  if (!fs2.existsSync(probeRoot)) return [];
  const subdirs = fs2.readdirSync(probeRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(probeRoot, e.name));
  const groups = groupByFamily(subdirs);
  const toDelete = [];
  for (const [family, dirs] of groups) {
    const sorted = sortNewest(dirs);
    const kept = sorted.slice(0, keepCount);
    const old = sorted.slice(keepCount);
    if (old.length) {
      console.log("  family [" + family + "] (video_ocr_probe): keeping [" + kept.map(d => path.basename(d)).join(", ") + "]");
      toDelete.push(...old);
    }
  }
  return toDelete;
}

function scanVideoScans(keepCount) {
  const entries = fs2.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^video_scan_d{8}$/.test(e.name));
  const toDelete = [];
  for (const entry of entries) {
    const scanRoot = path.join(ROOT, entry.name);
    const subdirs = fs2.readdirSync(scanRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(scanRoot, e.name));
    if (!subdirs.length) continue;
    const groups = groupByFamily(subdirs);
    for (const [family, dirs] of groups) {
      const sorted = sortNewest(dirs);
      const kept = sorted.slice(0, keepCount);
      const old = sorted.slice(keepCount);
      if (old.length) {
        console.log("  family [" + family + "] (" + entry.name + "/): keeping [" + kept.map(d => path.basename(d)).join(", ") + "]");
        toDelete.push(...old);
      }
    }
  }
  return toDelete;
}

function reportLargeDirs() {
  const dirs = [];
  const probeRoot = path.join(ROOT, "video_ocr_probe");
  if (fs2.existsSync(probeRoot)) {
    for (const e of fs2.readdirSync(probeRoot, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(probeRoot, e.name));
    }
  }
  const scanRoots = fs2.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^video_scan_d{8}$/.test(e.name))
    .map(e => path.join(ROOT, e.name));
  for (const scanRoot of scanRoots) {
    for (const e of fs2.readdirSync(scanRoot, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(scanRoot, e.name));
    }
  }
  const large = [];
  for (const d of dirs) { const size = getDirSizeMB(d); if (size > LARGE_DIR_THRESHOLD_MB) large.push({ dir: d, sizeMB: size }); }
  if (large.length) {
    console.log("  Large directories (>10 MB):");
    large.sort((a, b) => b.sizeMB - a.sizeMB);
    for (const { dir, sizeMB } of large) { console.log("    " + String(sizeMB.toFixed(0)).padStart(5) + " MB  " + path.relative(ROOT, dir)); }
  }
}

function deleteDirs(dirs) {
  let reclaimed = 0;
  for (const dir of dirs) {
    const size = getDirSizeMB(dir);
    try { fs2.rmSync(dir, { recursive: true, force: true }); reclaimed += size; console.log("  DELETED " + String(size.toFixed(1)).padStart(6) + " MB  " + path.relative(ROOT, dir)); }
    catch (err) { console.error("  FAILED: " + dir + ": " + err.message); }
  }
  return reclaimed;
}

const args = process.argv.slice(2);
const mode = args.includes("--execute") ? "execute" : "dry-run";
const keepCount = (() => { const idx = args.indexOf("--keep"); return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 3; })();
const scopeProbe = args.includes("--probe");
const scopeScans = args.includes("--scans");
const scanAll = !scopeProbe && !scopeScans;

console.log("Prune old probes (" + mode + ", keep " + keepCount + ")");

const toDelete = [];
if (scanAll || scopeProbe) toDelete.push(...scanProbeDir(keepCount));
if (scanAll || scopeScans) toDelete.push(...scanVideoScans(keepCount));

if (toDelete.length === 0) { console.log("Nothing to prune."); }
else {
  const totalSize = toDelete.reduce((s, d) => s + getDirSizeMB(d), 0);
  console.log(toDelete.length + " dirs to delete (" + totalSize.toFixed(1) + " MB):");
  if (mode === "execute") { const r = deleteDirs(toDelete); console.log("Reclaimed: " + r.toFixed(1) + " MB"); }
  else { toDelete.forEach(d => { console.log("    " + getDirSizeMB(d).toFixed(1) + " MB  " + path.relative(ROOT, d)); }); }
}

reportLargeDirs();
