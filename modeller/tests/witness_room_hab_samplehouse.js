#!/usr/bin/env node
/**
 * # ⚠ DO NOT REMOVE — W-ROOM-HAB-SH scope (READ THE LOG after every run)
 * SCOPE: bim-compiler prompts/Modeller/DISC_Walker/ROOM_INJECTION_HYBRID.md §3 Task 6 — SampleHouse
 * extraction-gap repair. Root cause (verified directly, not assumed): NOT the same cause as Task 4's
 * b93ca13 ARC-only strip cascade — diffing modeller/SampleHouse_extracted.db across b93ca13 shows its
 * spatial_structure table UNCHANGED (7 rows before AND after: 1 IfcBuilding + 2 IfcBuildingStorey +
 * 4 IfcSpace). The real cause is the LATER commit 6068fab ("embed 8 ARC-only buildings + shared mesh.db
 * resident registry", 2026-07-10) — its consolidation pipeline (embed8_scripts/finalize_all_8.js, fed
 * by an unpreserved /tmp merge step per commit 74c27b371's own note "working files lived only in /tmp")
 * produced every shipped `*_ARC.db` WITHOUT a spatial_structure table at all. Confirmed general, not
 * SampleHouse-specific: `main`'s Duplex_ARC.db has the identical gap (0 rows) — same as this doc's own
 * §2 table already recorded for Duplex before Task 1 ported it back in. So this is Task 6's OWN
 * classification: a genuine embed/consolidation-pipeline bug, not Task 4's cascade — fixing Task 4
 * (making spatial_structure survive the discipline-strip cascade) would NOT have fixed this, since the
 * table was intact well past that cascade and only vanished one commit later in a completely different
 * step (the ARC.db *schema definition* itself, which never included spatial_structure as a survivor).
 *
 * ISSUES THIS WITNESS EXPOSES:
 *   P  PORT          — SampleHouse_ARC.db has 0 spatial_structure rows before; after porting the table
 *                      verbatim from SampleHouse_extracted.db (the intact source), it has all 7.
 *   H1 PRECISION/RECALL — spaceHabitable() on the known-4 (3 genuine rooms + "4 - Roof") → exactly 3 ok,
 *                      exactly 1 excluded, and it must be the Roof space.
 *   H2 FALSIFIER     — with the exclude-list emptied, the label signal must vanish. UNLIKE Duplex, this
 *                      building's independent zband signal does NOT also fire (measured, not assumed:
 *                      SampleHouse_ARC.db's own element_transforms envelope tops out at z1=4.50 from real
 *                      ARC roof members/plates — taller than the Roof space's z1=3.50), so with list=[]
 *                      the Roof space classifies HABITABLE. This is reported honestly, not forced to match
 *                      Duplex's pattern — it shows Roof's exclusion here rests on the label signal alone.
 *   H3 GUID-OVERLAP  — no duplicate guids inside spatial_structure; no collisions with elements_meta guids.
 *   H4 COORD-OVERLAP — every habitable room bbox intersects the ARC.db's own substrate bbox in x,y,z.
 *   H5 STRIP         — after --strip: exactly 3 IfcSpace rows, 0 Roof spaces, storey/building rows intact
 *                      (the IfcBuildingStorey named "Roof" survives — it's a storey, not a space).
 * RUN: node modeller/tests/witness_room_hab_samplehouse.js [--strip]   (from the worktree root)
 * PASS bar: all chk() green. --port + --strip mutate modeller/SampleHouse_ARC.db — worktree only.
 */
'use strict';
const path = require('path');
const Database = require(path.join(process.env.HOME, 'bim-compiler', 'node_modules', 'better-sqlite3'));
const DW = require(path.join(__dirname, '..', 'disc_walker.js'));

const ARC_PATH = path.join(__dirname, '..', 'SampleHouse_ARC.db');
const SRC_PATH = path.join(__dirname, '..', 'SampleHouse_extracted.db');
const STRIP = process.argv.includes('--strip');
let pass = 0, fail = 0;
const chk = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };

const db = new Database(ARC_PATH);

// ── PORT: SampleHouse_ARC.db has no spatial_structure table at all — create + populate it verbatim
//    from the intact source (SampleHouse_extracted.db), idempotent (skip if already ported). ──
const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='spatial_structure'`).get();
const before = hasTable ? db.prepare(`SELECT COUNT(*) n FROM spatial_structure`).get().n : 0;
if (!hasTable) {
  const src = new Database(SRC_PATH, { readonly: true });
  const schema = src.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='spatial_structure'`).get();
  db.exec(schema.sql);
  const rows = src.prepare(`SELECT * FROM spatial_structure`).all();
  const cols = Object.keys(rows[0]);
  const ins = db.prepare(`INSERT INTO spatial_structure (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  rows.forEach(r => ins.run(cols.map(c => r[c])));
  src.close();
}
const after = db.prepare(`SELECT COUNT(*) n FROM spatial_structure`).get().n;
console.log(`§ROOM-HAB-SH PORT before=${before} after=${after} freshPort=${!hasTable}`);
chk('P PORT SampleHouse_ARC.db carries all 7 spatial_structure rows (1 building + 2 storeys + 4 spaces)' +
  (hasTable ? ' [already ported by an earlier run, idempotent skip]' : ' [fresh port, was 0 before]'),
  after === 7 && (hasTable || before === 0), `before=${before} after=${after}`);

// same envelope SQL as disc_walker._substrateEnv, node-side — computed from THIS db (ARC.db), the
// exact substrate spacesOf() would walk against at runtime.
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

console.log(`§ROOM-HAB-SH spaces=${spaces.length} env.z1=${env.z1.toFixed(2)}`);
const verdicts = spaces.map(sp => ({ sp, v: DW.spaceHabitable(sp, env) }));
verdicts.filter(x => !x.v.ok).forEach(x =>
  console.log(`§ROOM-HAB-SH NONHAB ${x.sp.room_no}|${x.sp.label} (${x.sp.guid}) — ${x.v.why}`));

const roof = spaces.find(s => s.room_no === '4 - Roof');
if (roof) {
  // ── Phase 1: PROOF on the pre-strip known-4 ──
  const ok = verdicts.filter(x => x.v.ok), bad = verdicts.filter(x => !x.v.ok);
  chk('H1 PRECISION/RECALL known-4 → 3 ok + exactly "4 - Roof" excluded',
    spaces.length === 4 && ok.length === 3 && bad.length === 1 && bad[0].sp.room_no === '4 - Roof',
    `${ok.length} ok, excluded: ${bad.map(x => x.sp.room_no + '(' + x.v.why + ')').join(',') || 'none'}`);
  const noList = DW.spaceHabitable(roof, env, []);
  const disarmed = DW.spaceHabitable(roof, null, []);
  const zbandIndependentlyFires = !noList.ok && /^zband:/.test(noList.why || '');
  chk('H2 FALSIFIER list=[] → label signal gone; report (not assume) whether zband independently fires',
    disarmed.ok === true && (zbandIndependentlyFires ? !noList.ok : noList.ok === true),
    zbandIndependentlyFires
      ? `zband INDEPENDENTLY fires: ${noList.why}`
      : `zband silent for this building (roof.z1=${roof.z1.toFixed(2)} <= env.z1+0.25=${(env.z1+0.25).toFixed(2)}, real ARC roof members reach higher) — label is the ONLY signal excluding Roof here`);
} else {
  console.log('  §ROOM-HAB-SH Phase-1 proof SKIPPED — Roof already stripped (post-strip rerun)');
}

// ── H3 GUID-OVERLAP ──
const dup = db.prepare(`SELECT guid, COUNT(*) n FROM spatial_structure GROUP BY guid HAVING n > 1`).all();
const coll = db.prepare(`SELECT COUNT(*) n FROM spatial_structure ss
  JOIN elements_meta m ON m.guid = ss.guid`).get();
chk('H3 GUID-OVERLAP zero dup guids, zero elements_meta collisions',
  dup.length === 0 && coll.n === 0, `dup=${dup.length} coll=${coll.n}`);

// ── H4 COORD-OVERLAP: every HABITABLE room bbox ∩ substrate bbox in x, y AND z ──
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
  console.log(`§ROOM-HAB-SH STRIP deleted=${doomed.length} guids=${doomed.join(',')}`);
}
if (STRIP || !roof) {
  const post = db.prepare(`SELECT
    SUM(type='IfcSpace') spaces, SUM(type='IfcSpace' AND name='4 - Roof') roofSpaces,
    SUM(type='IfcBuildingStorey') storeys, SUM(type='IfcBuilding') bldg FROM spatial_structure`).get();
  chk('H5 STRIP post-state 3 IfcSpace, 0 Roof spaces, 2 storeys + 1 building intact',
    post.spaces === 3 && post.roofSpaces === 0 && post.storeys === 2 && post.bldg === 1,
    `spaces=${post.spaces} roofSpaces=${post.roofSpaces} storeys=${post.storeys} bldg=${post.bldg}`);
}
db.close();

console.log(`§ROOM-HAB-SH DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
