#!/usr/bin/env node
/**
 * # ⚠ DO NOT REMOVE — W-ROOM-HAB scope (READ THE LOG after every run)
 * SCOPE: bim-compiler prompts/Modeller/DISC_Walker/ROOM_INJECTION_HYBRID.md §6 (Task 1 + Task 5) —
 * the room HABITABILITY classifier (real-vs-non-habitable-real IfcSpace) proven on Duplex's
 * hand-verified known-21 (20 genuine rooms + R301 Roof void), then the Roof strip from the shipped
 * Duplex_ARC.db, selected BY the classifier's verdicts (never a hand-coded guid).
 * ISSUES THIS WITNESS EXPOSES (each named, per the test doctrine):
 *   H1 PRECISION/RECALL — does spaceHabitable() reproduce the hand-verified answer on the known-21
 *                         (exactly 20 ok, exactly R301 excluded)? A miss either way = classifier wrong.
 *   H2 FALSIFIER        — with the exclude-list emptied, R301's label signal must VANISH (only the
 *                         independent zband signal may still fire); with both signals disarmed R301
 *                         must classify ok. Proves H1's pass depends on the real list, not harness bias.
 *   H3 GUID-OVERLAP     — (Task 1d) duplicate guids inside spatial_structure, or collisions with
 *                         elements_meta guids, would corrupt walks/joins silently.
 *   H4 COORD-OVERLAP    — (Task 1d) a habitable room bbox that misses the substrate bbox in x, y or z
 *                         would silently starve schedule placement (frame mismatch).
 *   H5 STRIP            — after --strip: exactly 20 IfcSpace rows, zero Roof spaces, storey/building
 *                         rows intact (the IfcBuildingStorey named "Roof" must SURVIVE — it's a storey).
 * RUN: node modeller/tests/witness_room_hab.js [--strip]   (from the worktree root)
 * PASS bar: all chk() green. --strip mutates modeller/Duplex_ARC.db — run only in a worktree.
 */
'use strict';
const path = require('path');
const Database = require(path.join(process.env.HOME, 'bim-compiler', 'node_modules', 'better-sqlite3'));
const DW = require(path.join(__dirname, '..', 'disc_walker.js'));

const DB_PATH = path.join(__dirname, '..', 'Duplex_ARC.db');
const STRIP = process.argv.includes('--strip');
let pass = 0, fail = 0;
const chk = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };

const db = new Database(DB_PATH);
// same envelope SQL as disc_walker._substrateEnv, node-side
const env = db.prepare(`SELECT MIN(center_x-bbox_x/2) x0, MAX(center_x+bbox_x/2) x1,
  MIN(center_y-bbox_y/2) y0, MAX(center_y+bbox_y/2) y1, MIN(center_z-bbox_z/2) z0,
  MAX(center_z+bbox_z/2) z1 FROM element_transforms`).get();
// same real-space query shape as spacesOf()'s spatial_structure path
const spaces = db.prepare(`SELECT guid, COALESCE(NULLIF(object_type,''), name) label, name room_no,
  center_x cx, center_y cy, center_z cz, COALESCE(size_x,0) bx, COALESCE(size_y,0) by_,
  COALESCE(size_z,0) bz FROM spatial_structure WHERE type='IfcSpace'
  AND guid NOT LIKE 'RM\\_%' ESCAPE '\\' AND name NOT LIKE '%≈%'`).all()
  .filter(s => s.bx > 0.1 && s.by_ > 0.1)
  .map(s => ({ guid: s.guid, label: s.label, room_no: s.room_no,
    x0: s.cx - s.bx / 2, x1: s.cx + s.bx / 2, y0: s.cy - s.by_ / 2, y1: s.cy + s.by_ / 2,
    z0: s.cz - s.bz / 2, z1: s.cz + s.bz / 2 }));

console.log(`§ROOM-HAB spaces=${spaces.length} env.z1=${env.z1.toFixed(2)}`);
const verdicts = spaces.map(sp => ({ sp, v: DW.spaceHabitable(sp, env) }));
verdicts.filter(x => !x.v.ok).forEach(x =>
  console.log(`§ROOM-HAB NONHAB ${x.sp.room_no}|${x.sp.label} (${x.sp.guid}) — ${x.v.why}`));

const roof = spaces.find(s => s.room_no === 'R301');
if (roof) {
  // ── Phase 1: PROOF on the pre-strip known-21 ──
  const ok = verdicts.filter(x => x.v.ok), bad = verdicts.filter(x => !x.v.ok);
  chk('H1 PRECISION/RECALL known-21 → 20 ok + exactly R301 excluded',
    spaces.length === 21 && ok.length === 20 && bad.length === 1 && bad[0].sp.room_no === 'R301',
    `${ok.length} ok, excluded: ${bad.map(x => x.sp.room_no + '(' + x.v.why + ')').join(',') || 'none'}`);
  const noList = DW.spaceHabitable(roof, env, []);
  const disarmed = DW.spaceHabitable(roof, null, []);
  chk('H2 FALSIFIER list=[] → label signal gone (zband only); both disarmed → ok',
    !noList.ok && /^zband:/.test(noList.why) && disarmed.ok === true,
    `list=[]: ${noList.why || 'ok'} · disarmed: ${disarmed.ok}`);
} else {
  console.log('  §ROOM-HAB Phase-1 proof SKIPPED — R301 already stripped (post-strip rerun)');
}

// ── H3 GUID-OVERLAP (Task 1d) ──
const dup = db.prepare(`SELECT guid, COUNT(*) n FROM spatial_structure GROUP BY guid HAVING n > 1`).all();
const coll = db.prepare(`SELECT COUNT(*) n FROM spatial_structure ss
  JOIN elements_meta m ON m.guid = ss.guid`).get();
chk('H3 GUID-OVERLAP zero dup guids, zero elements_meta collisions',
  dup.length === 0 && coll.n === 0, `dup=${dup.length} coll=${coll.n}`);

// ── H4 COORD-OVERLAP (Task 1d): every HABITABLE room bbox ∩ substrate bbox in x, y AND z ──
const hab = verdicts.filter(x => x.v.ok).map(x => x.sp);
const outside = hab.filter(s => s.x1 < env.x0 || s.x0 > env.x1 || s.y1 < env.y0 || s.y0 > env.y1 ||
  s.z1 < env.z0 || s.z0 > env.z1);
chk('H4 COORD-OVERLAP all habitable rooms ∩ substrate bbox (x,y,z)', hab.length > 0 && outside.length === 0,
  `${hab.length - outside.length}/${hab.length} intersect` + (outside.length ? ' OUTSIDE: ' + outside.map(s => s.room_no).join(',') : ''));

// ── H5 STRIP (only with --strip; classifier verdicts drive the delete, never a hand-coded guid) ──
if (STRIP && roof) {
  const doomed = verdicts.filter(x => !x.v.ok).map(x => x.sp.guid);
  const del = db.prepare(`DELETE FROM spatial_structure WHERE guid = ?`);
  doomed.forEach(g => del.run(g));
  console.log(`§ROOM-HAB STRIP deleted=${doomed.length} guids=${doomed.join(',')}`);
}
if (STRIP || !roof) {
  const post = db.prepare(`SELECT
    SUM(type='IfcSpace') spaces, SUM(type='IfcSpace' AND object_type='Roof') roofSpaces,
    SUM(type='IfcBuildingStorey') storeys, SUM(type='IfcBuilding') bldg FROM spatial_structure`).get();
  chk('H5 STRIP post-state 20 IfcSpace, 0 Roof spaces, 4 storeys + 1 building intact',
    post.spaces === 20 && post.roofSpaces === 0 && post.storeys === 4 && post.bldg === 1,
    `spaces=${post.spaces} roofSpaces=${post.roofSpaces} storeys=${post.storeys} bldg=${post.bldg}`);
}
db.close();

console.log(`§ROOM-HAB DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
