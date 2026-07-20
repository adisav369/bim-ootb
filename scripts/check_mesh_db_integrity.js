#!/usr/bin/env node
// GUARDRAIL — mesh.db is FROZEN. Any change to it must be deliberate, reviewed, and re-baselined.
//
// # ⚠ DO NOT REMOVE — SCOPE
// mesh.db is the SHARED geometry substrate for ALL 8 Modeller residents (str_walker_outliner.js
// RESIDENTS). One edit silently changes what every building renders, and — as the 2026-07-01 scar
// proved — a degraded mesh substrate is INVISIBLE to the rest of the suite: every witness stays
// green because counts, bboxes and pixel-diffs are all satisfied by a box just as well as by a real
// mesh. mesh.db is also LFS-tracked and 120MB, so a bad edit is expensive to undo.
//
// WHY THIS EXISTS (user directive 2026-07-20): "SC was never blocky, investigate what broke it
// during mesh.db formulation" + "have a dedicated guardrail against any future mesh.db edit".
// The investigation CLEARED mesh.db (the ~45% box fraction is present identically in the original
// SampleCastle_ARC_extracted.db, so consolidation did not introduce it) — but the question could
// only be answered because the original extraction still existed to compare against. This guardrail
// makes that comparison permanent instead of luck.
//
// WHAT IT PROTECTS: per-building geometry counts AND the box fraction (geometries whose faces blob
// is <=144 bytes = 12 triangles). The box fraction is the load-bearing number: a dedup/consolidation
// pass that silently replaces real meshes with box proxies changes it while leaving the row COUNT
// plausible. Counts alone would not have caught the failure mode this project actually suffered.
//
// Usage:
//   node scripts/check_mesh_db_integrity.js            → verify against the committed baseline; exit 1 on drift
//   node scripts/check_mesh_db_integrity.js --baseline → RE-BASELINE (only after a reviewed, intended change)
//
// Re-baselining is a DELIBERATE act: it rewrites the frozen fingerprint. Do it only alongside a
// commit that explains WHY mesh.db changed and what re-verified the affected buildings.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MESH = path.join(ROOT, 'modeller', 'mesh.db');
const BASELINE = path.join(ROOT, 'modeller', 'mesh_db_baseline.json');
const BOX_BYTES = 144;   // 12 triangles x 3 uint32 indices x 4 bytes

function sql(q) {
  return execFileSync('sqlite3', [MESH, q], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
}

function fingerprint() {
  if (!fs.existsSync(MESH)) throw new Error('mesh.db not found at ' + MESH);
  const rows = sql(
    `SELECT building, COUNT(*), SUM(CASE WHEN length(faces)<=${BOX_BYTES} THEN 1 ELSE 0 END) ` +
    `FROM component_geometries GROUP BY building ORDER BY building;`
  );
  const buildings = {};
  for (const line of rows.split('\n')) {
    if (!line.trim()) continue;
    const [b, n, box] = line.split('|');
    buildings[b] = { geometries: +n, boxGeometries: +box, boxPct: +(100 * box / n).toFixed(2) };
  }
  return {
    _spec: 'GEOMETRY_TRUTH_CHAIN.md — mesh.db is FROZEN. Regenerate ONLY via --baseline with a reviewed reason.',
    total: +sql('SELECT COUNT(*) FROM component_geometries;'),
    sizeBytes: fs.statSync(MESH).size,
    buildings
  };
}

const fp = fingerprint();

if (process.argv.includes('--baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(fp, null, 2) + '\n');
  console.log('§MESH_BASELINE written — total=' + fp.total + ' buildings=' + Object.keys(fp.buildings).length);
  console.log('⚠ You have re-frozen mesh.db. Commit this with the REASON it changed.');
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('§MESH_GUARD FAIL — no baseline at ' + BASELINE + ' (run with --baseline once to establish it)');
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const problems = [];

if (base.total !== fp.total) problems.push(`total geometries ${base.total} → ${fp.total}`);
if (base.sizeBytes !== fp.sizeBytes) problems.push(`file size ${base.sizeBytes} → ${fp.sizeBytes} bytes`);

for (const b of Object.keys(base.buildings)) {
  const was = base.buildings[b], now = fp.buildings[b];
  if (!now) { problems.push(`building ${b} DISAPPEARED (had ${was.geometries} geometries)`); continue; }
  if (was.geometries !== now.geometries) problems.push(`${b} geometries ${was.geometries} → ${now.geometries}`);
  // The load-bearing check: real meshes silently degraded into box proxies.
  if (was.boxGeometries !== now.boxGeometries) {
    const dir = now.boxGeometries > was.boxGeometries ? 'MORE BOXES (real meshes degraded?)' : 'fewer boxes';
    problems.push(`${b} box geometries ${was.boxGeometries} → ${now.boxGeometries} [${dir}]`);
  }
}
for (const b of Object.keys(fp.buildings)) {
  if (!base.buildings[b]) problems.push(`building ${b} ADDED (${fp.buildings[b].geometries} geometries)`);
}

for (const b of Object.keys(fp.buildings)) {
  const x = fp.buildings[b];
  console.log(`§MESH_GUARD building=${b} geometries=${x.geometries} box=${x.boxGeometries} boxPct=${x.boxPct}%`);
}

if (problems.length) {
  console.error('\n§MESH_GUARD FAIL — mesh.db CHANGED against its frozen baseline:');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error('\nmesh.db is the shared substrate for all 8 residents; a degraded mesh renders as');
  console.error('12-tri boxes that NO other witness detects (§GEOM-HARDFAIL and §BLOB_MISS both stay 0).');
  console.error('If this change was intended: re-run witness_render_fidelity.js on the affected');
  console.error('buildings, then re-baseline with --baseline and commit the REASON.');
  process.exit(1);
}

console.log('\n§MESH_GUARD OK — mesh.db matches its frozen baseline (total=' + fp.total + ')');
process.exit(0);
