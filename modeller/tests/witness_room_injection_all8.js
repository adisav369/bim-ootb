#!/usr/bin/env node
/**
 * # ⚠ DO NOT REMOVE — W-ROOM-INJECT-ALL8 scope (READ THE LOG after every run)
 * SCOPE: bim-compiler prompts/Modeller/DISC_Walker/ROOM_INJECTION_HYBRID.md §1 — the hybrid rule says
 * EVERY shipped ARC.db gets rooms, split by source reliability: real IfcSpace where the source has it
 * (feeds schedule placement), compile_rooms.py's wall-enclosure flood-fill otherwise (display-only,
 * NEVER feeds placement). This witness proves that state now holds across all 8 residents, not just the
 * 2 (Duplex, SampleHouse) that had real IfcSpace to port.
 * ISSUES THIS WITNESS EXPOSES:
 *   I1 COVERAGE   — all 8 *_ARC.db carry a spatial_structure table with >0 IfcSpace rows. A building
 *                   left at 0 would silently violate §1's "always, every ARC" rule.
 *   I2 TAG-PURITY — every COMPILED (synthetic) building's rows are ALL RM_-guid + ≈-name + COMPILED
 *                   object_type, together (never a partial/mixed tag — a partial tag would let a
 *                   synthetic row slip past spacesOf()'s exclusion filter undetected).
 *   I3 NO-COLLISION — no spatial_structure guid collides with an elements_meta guid, any building.
 *   I4 PLACEMENT-GATE — spacesOf() (the actual runtime filter schedule-placement calls) returns 0
 *                   candidates for every synthetic-only building (display rows must never reach
 *                   placement) and the correct real count for Duplex(20)/SampleHouse(3).
 * RUN: node modeller/tests/witness_room_injection_all8.js   (from the worktree root, read-only)
 */
'use strict';
const path = require('path'), fs = require('fs');
const Database = require(path.join(process.env.HOME, 'bim-compiler', 'node_modules', 'better-sqlite3'));
const initSqlJs = require(path.join(process.env.HOME, 'bim-compiler', 'node_modules', 'sql.js'));
const DW = require(path.join(__dirname, '..', 'disc_walker.js'));

let pass = 0, fail = 0;
const chk = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };

const BUILDINGS = [
  { name: 'SampleHouse', kind: 'real',      expectSpace: 3 },
  { name: 'Duplex',      kind: 'real',      expectSpace: 20 },
  { name: 'Terminal',    kind: 'synthetic', expectSpace: 43 },
  { name: 'SampleCastle',kind: 'synthetic', expectSpace: 25 },
  { name: 'HHS',         kind: 'synthetic', expectSpace: 2 },
  { name: 'Clinic',      kind: 'synthetic', expectSpace: 113 },
  { name: 'Garage',      kind: 'synthetic', expectSpace: 5 },
  { name: 'Hospital',    kind: 'synthetic', expectSpace: 142 },
];

(async () => {
  const SQL = await initSqlJs();
  const summary = [];
  for (const b of BUILDINGS) {
    const dbPath = path.join(__dirname, '..', b.name + '_ARC.db');
    const db = new Database(dbPath, { readonly: true });

    const cnt = db.prepare(`SELECT COUNT(*) n FROM spatial_structure WHERE type='IfcSpace'`).get().n;
    chk(`I1 COVERAGE ${b.name}: spatial_structure IfcSpace rows > 0`, cnt > 0, `rows=${cnt} (expect ${b.expectSpace})`);

    if (b.kind === 'synthetic') {
      const tag = db.prepare(`SELECT COUNT(*) n, SUM(guid LIKE 'RM\\_%' ESCAPE '\\') rm,
        SUM(name LIKE '%≈%') tilde, SUM(object_type='COMPILED') comp
        FROM spatial_structure WHERE type='IfcSpace'`).get();
      chk(`I2 TAG-PURITY ${b.name}: all ${tag.n} rows are RM_+≈+COMPILED together`,
        tag.n === tag.rm && tag.n === tag.tilde && tag.n === tag.comp,
        `n=${tag.n} rm=${tag.rm} tilde=${tag.tilde} comp=${tag.comp}`);
    } else {
      chk(`I2 TAG-PURITY ${b.name}: real rows carry no RM_/≈ synthetic tag`,
        db.prepare(`SELECT COUNT(*) n FROM spatial_structure WHERE type='IfcSpace' AND
          (guid LIKE 'RM\\_%' ESCAPE '\\' OR name LIKE '%≈%')`).get().n === 0, 'ok');
    }

    const coll = db.prepare(`SELECT COUNT(*) n FROM spatial_structure ss JOIN elements_meta m ON m.guid=ss.guid`).get().n;
    chk(`I3 NO-COLLISION ${b.name}: 0 guid collisions with elements_meta`, coll === 0, `coll=${coll}`);

    // I4 PLACEMENT-GATE — run the REAL spacesOf() (sql.js path, same engine disc_walker.js runs on)
    const sqlDb = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    const eligible = DW.spacesOf(sqlDb);
    const expectEligible = b.kind === 'real' ? b.expectSpace : 0;
    chk(`I4 PLACEMENT-GATE ${b.name}: spacesOf() eligible=${eligible.length} (expect ${expectEligible})`,
      eligible.length === expectEligible, b.kind === 'synthetic' ? 'display-only, correctly excluded' : 'real, correctly included');
    sqlDb.close();

    summary.push({ name: b.name, kind: b.kind, rooms: cnt, eligible: eligible.length });
    db.close();
  }

  console.log('\n§ROOM-INJECT-ALL8 SUMMARY');
  summary.forEach(s => console.log(`  ${s.name.padEnd(14)} kind=${s.kind.padEnd(9)} rooms=${String(s.rooms).padEnd(4)} placement-eligible=${s.eligible}`));
  console.log(`\n§ROOM-INJECT-ALL8 DONE pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
