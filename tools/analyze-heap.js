#!/usr/bin/env node
// Stream-parse heap snapshots to identify retainers.
// Two passes:
//   1) Parse nodes integer array → counts and sizes by type
//   2) Stream strings array → find big duplicated strings

const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node analyze-heap.js <snapshot>'); process.exit(1); }

const stat = fs.statSync(file);
console.log(`\n=== ${file} ===`);
console.log(`Size on disk: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

const fd = fs.openSync(file, 'r');

// Find sentinels
function findStr(needle, from) {
  const target = Buffer.from(needle);
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let pos = from;
  while (pos < stat.size) {
    const len = Math.min(buf.length, stat.size - pos);
    fs.readSync(fd, buf, 0, len, pos);
    const idx = buf.subarray(0, len).indexOf(target);
    if (idx !== -1) return pos + idx;
    pos += len - target.length;
  }
  return -1;
}

const nodesKey = findStr('"nodes":[', 0);
const edgesKey = findStr('"edges":[', nodesKey);
const stringsKey = findStr('"strings":[', edgesKey);
console.log(`nodes at ${nodesKey}, edges at ${edgesKey}, strings at ${stringsKey}`);

// Parse header (everything before "nodes":[)
const headerBuf = Buffer.alloc(nodesKey);
fs.readSync(fd, headerBuf, 0, nodesKey, 0);
const header = JSON.parse(headerBuf.toString('utf8') + '"_eof":0}');
const meta = header.snapshot.meta;
const FIELDS = meta.node_fields;
const NTYPES = meta.node_types[0];
const F = FIELDS.length;
const TYPE_IDX = FIELDS.indexOf('type');
const NAME_IDX = FIELDS.indexOf('name');
const SIZE_IDX = FIELDS.indexOf('self_size');
const DETACH_IDX = FIELDS.indexOf('detachedness');
const NODE_COUNT = header.snapshot.node_count;
console.log(`Declared nodes: ${NODE_COUNT}, fields: ${FIELDS.join(',')}`);

// ── pass 1: parse nodes integer stream ──
const nodesStart = nodesKey + '"nodes":['.length;
const nodesEnd = edgesKey - 2; // strip "],"

const typeCounts = new Uint32Array(NTYPES.length);
const typeSizes = new Float64Array(NTYPES.length);
let detachedN = 0, detachedSize = 0;
const nodeTypeArr = new Uint8Array(NODE_COUNT);
const nodeSizeArr = new Float64Array(NODE_COUNT);
const nodeNameArr = new Uint32Array(NODE_COUNT);

{
  const BUF = 32 * 1024 * 1024;
  const buf = Buffer.alloc(BUF);
  let pos = nodesStart;
  let cur = 0;
  let hasDigit = false;
  let nodeIdx = 0;
  let fieldIdx = 0;
  while (pos < nodesEnd) {
    const len = Math.min(BUF, nodesEnd - pos);
    fs.readSync(fd, buf, 0, len, pos);
    for (let i = 0; i < len; i++) {
      const c = buf[i];
      if (c >= 48 && c <= 57) { cur = cur * 10 + (c - 48); hasDigit = true; }
      else if (hasDigit) {
        // commit field
        if (fieldIdx === TYPE_IDX) nodeTypeArr[nodeIdx] = cur;
        else if (fieldIdx === SIZE_IDX) nodeSizeArr[nodeIdx] = cur;
        else if (fieldIdx === NAME_IDX) nodeNameArr[nodeIdx] = cur;
        if (fieldIdx === TYPE_IDX) typeCounts[cur]++;
        if (fieldIdx === SIZE_IDX) typeSizes[nodeTypeArr[nodeIdx]] += cur;
        if (DETACH_IDX !== -1 && fieldIdx === DETACH_IDX && cur === 2) {
          detachedN++; detachedSize += nodeSizeArr[nodeIdx];
        }
        fieldIdx++;
        if (fieldIdx === F) { fieldIdx = 0; nodeIdx++; }
        cur = 0; hasDigit = false;
      }
    }
    pos += len;
  }
  if (hasDigit) {
    if (fieldIdx === TYPE_IDX) nodeTypeArr[nodeIdx] = cur;
    else if (fieldIdx === SIZE_IDX) nodeSizeArr[nodeIdx] = cur;
    else if (fieldIdx === NAME_IDX) nodeNameArr[nodeIdx] = cur;
    if (fieldIdx === TYPE_IDX) typeCounts[cur]++;
    if (fieldIdx === SIZE_IDX) typeSizes[nodeTypeArr[nodeIdx]] += cur;
  }
  console.log(`Parsed ${nodeIdx} node records`);
}

console.log('\n── Nodes by type ──');
const totalsByType = NTYPES.map((name, i) => ({ name, count: typeCounts[i], mb: typeSizes[i]/1048576, avg: typeSizes[i] / Math.max(typeCounts[i], 1) }));
totalsByType.sort((a, b) => b.mb - a.mb);
for (const r of totalsByType) {
  if (r.count === 0) continue;
  console.log(`  ${r.name.padEnd(22)} ${String(r.count).padStart(10)} ${r.mb.toFixed(1).padStart(10)} MB  avg=${r.avg.toFixed(0)}B`);
}
console.log(`\nDetached DOM nodes: ${detachedN}, ${(detachedSize/1048576).toFixed(1)} MB`);

// ── pass 2: stream strings, accumulate lengths ──
const strLens = new Uint32Array(1 << 24); // up to 16M strings
let strCount = 0;
{
  const BUF = 32 * 1024 * 1024;
  const buf = Buffer.alloc(BUF);
  let pos = stringsKey + '"strings":['.length;
  let inStr = false;
  let escape = false;
  let curLen = 0;
  while (pos < stat.size) {
    const len = Math.min(BUF, stat.size - pos);
    fs.readSync(fd, buf, 0, len, pos);
    for (let i = 0; i < len; i++) {
      const ch = buf[i];
      if (!inStr) {
        if (ch === 0x22) { inStr = true; curLen = 0; }
        else if (ch === 0x5D) { pos = stat.size; break; }
      } else {
        if (escape) { escape = false; curLen++; }
        else if (ch === 0x5C) { escape = true; curLen++; }
        else if (ch === 0x22) {
          if (strCount < strLens.length) strLens[strCount] = curLen;
          strCount++;
          inStr = false;
        } else curLen++;
      }
    }
    pos += len;
  }
  console.log(`\nStrings parsed: ${strCount}`);
}

let totalStrBytes = 0;
for (let i = 0; i < strCount; i++) totalStrBytes += strLens[i];
console.log(`Total string bytes: ${(totalStrBytes/1048576).toFixed(1)} MB`);

// ── pass 3: top names by total self_size referenced ──
const nameStats = new Map();
const STRING_TYPE_BITS = new Uint8Array(NTYPES.length);
NTYPES.forEach((n, i) => { if (n === 'string' || n === 'concatenated string' || n === 'sliced string') STRING_TYPE_BITS[i] = 1; });

for (let i = 0; i < NODE_COUNT; i++) {
  const name = nameNameArrSafe(i);
  const t = nodeTypeArr[i];
  const sz = nodeSizeArr[i];
  let ent = nameStats.get(name);
  if (!ent) { ent = { count: 0, selfSz: 0, strLen: 0, type: t }; nameStats.set(name, ent); }
  ent.count++; ent.selfSz += sz;
  if (STRING_TYPE_BITS[t] && name < strCount) ent.strLen += strLens[name];
}
function nameNameArrSafe(i) { return nodeNameArr[i]; }

const ranked = [...nameStats.entries()].map(([idx, v]) => ({ idx, ...v }));
ranked.sort((a, b) => b.selfSz - a.selfSz);

// Load top N string names by index (read file with strings extracted on demand)
console.log('\n── Top 40 names (by sum self_size) ──');
const topIndices = new Set(ranked.slice(0, 40).map(r => r.idx));
const stringTable = loadStringsByIndices(topIndices);
for (let i = 0; i < 40; i++) {
  const r = ranked[i];
  if (!r) break;
  const s = (stringTable[r.idx] || '').substring(0, 80).replace(/\n/g, '\\n');
  console.log(`  [${String(r.idx).padStart(8)}] ${NTYPES[r.type].substring(0,8).padEnd(8)} count=${String(r.count).padStart(8)} self=${(r.selfSz/1048576).toFixed(2).padStart(8)}MB str=${(r.strLen/1048576).toFixed(2).padStart(6)}MB | "${s}"`);
}

console.log('\n── Top 40 names by total string-len contribution ──');
const rankedStr = ranked.filter(r => r.strLen > 0).sort((a, b) => b.strLen - a.strLen);
const topStrIndices = new Set(rankedStr.slice(0, 40).map(r => r.idx));
const stringTable2 = loadStringsByIndices(topStrIndices);
for (let i = 0; i < 40; i++) {
  const r = rankedStr[i];
  if (!r) break;
  const s = (stringTable2[r.idx] || '').substring(0, 100).replace(/\n/g, '\\n');
  console.log(`  [${String(r.idx).padStart(8)}] count=${String(r.count).padStart(7)} totalStr=${(r.strLen/1048576).toFixed(2).padStart(8)}MB avg=${(r.strLen/r.count).toFixed(0).padStart(7)}B | "${s}"`);
}

function loadStringsByIndices(idxSet) {
  const out = {};
  const BUF = 32 * 1024 * 1024;
  const buf = Buffer.alloc(BUF);
  let pos = stringsKey + '"strings":['.length;
  let inStr = false, escape = false;
  let curChars = [];
  let strIdx = 0;
  outer:
  while (pos < stat.size) {
    const len = Math.min(BUF, stat.size - pos);
    fs.readSync(fd, buf, 0, len, pos);
    for (let i = 0; i < len; i++) {
      const ch = buf[i];
      if (!inStr) {
        if (ch === 0x22) { inStr = true; curChars = []; }
        else if (ch === 0x5D) { break outer; }
      } else {
        if (escape) { escape = false; if (idxSet.has(strIdx) && curChars.length < 200) curChars.push(ch); }
        else if (ch === 0x5C) { escape = true; if (idxSet.has(strIdx) && curChars.length < 200) curChars.push(ch); }
        else if (ch === 0x22) {
          if (idxSet.has(strIdx)) out[strIdx] = Buffer.from(curChars).toString('utf8');
          strIdx++;
          inStr = false;
          if (Object.keys(out).length >= idxSet.size) break outer;
        } else if (idxSet.has(strIdx) && curChars.length < 200) curChars.push(ch);
      }
    }
    pos += len;
  }
  return out;
}

fs.closeSync(fd);

// Save for diff
const outPath = file.replace(/\.heapsnapshot$/, '') + '.analysis.json';
fs.writeFileSync(outPath, JSON.stringify({
  fileSize: stat.size,
  nodeCount: NODE_COUNT,
  strCount,
  totalStrBytes,
  detached: { count: detachedN, bytes: detachedSize },
  totalsByType,
  topByName: ranked.slice(0, 100).map(r => ({ idx: r.idx, type: NTYPES[r.type], count: r.count, selfSz: r.selfSz, strLen: r.strLen, sample: stringTable[r.idx] || stringTable2[r.idx] || '' })),
  topByStrLen: rankedStr.slice(0, 100).map(r => ({ idx: r.idx, count: r.count, strLen: r.strLen, sample: stringTable2[r.idx] || stringTable[r.idx] || '' })),
}, null, 2));
console.log(`\nSaved analysis to: ${outPath}`);
