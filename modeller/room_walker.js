// room_walker.js — JS port of scripts/compile_rooms.py (verbatim algorithm, ported not re-derived).
// COMPILE rooms from wall/door enclosure (deterministic, not invented). Per storey: rasterize
// wall + door footprints into a 2D plan grid, flood-fill the exterior from the border, and treat
// each connected pocket of free space the exterior cannot reach as a ROOM (enclosed by walls).
// Output = spatial_structure IfcSpace rows (guid/name/parent + center_x/y/z, size_x/y/z) +
// rel_contained_in_space (elements whose XY centre falls in a room).
//
// This is COMPILE, not invent: every room is a region enclosed by REAL wall geometry. guid/name
// are deterministic labels for the computed cell. Geometry tables are never touched.
//
// Dual-mode: same sql.js `db.exec()` interface works unmodified in Node (embed8_scripts/
// finalize_all_8.js's own pattern) and in-browser (the Modeller's existing WASM sql.js) — no
// separate DB-access implementation per mode, matching disc_walker.js's own convention.
//
// ROOM_INJECTION_HYBRID.md Task 2/§DOOR-RESCUE/§DOOR-PARTITION (the algorithm's derivation) ·
// ROOM_WALKER_JS_PORT.md Task 2 (this port) · scripts/compile_rooms.py (the Python source of truth).
(function () {
  'use strict';
  var TAG = '§ROOM-WALKER';
  var ROOT = (typeof window !== 'undefined') ? window : {};

  var RES = 0.20;          // grid cell size (m)
  var MIN_AREA = 4.0;      // m^2 — drop slivers / wall cavities
  var MAX_AREA_ABS = 150.0;  // m^2 — drop exterior-leak blobs (a real room is rarely bigger)
  var MAX_AREA_FRAC = 0.92;  // also drop anything ~the whole storey plan
  var SEAL = 2;             // dilate walls this many cells (×RES) to close hairline corner/door gaps
  var WALL_LIKE = ["IfcWall%", "IfcDoor%", "IfcCurtainWall%", "IfcColumn%", "IfcWindow%"];
  // §STAIR-EXCLUDE: a stairwell is a wall-enclosed pocket, so the flood-fill flags it as a "room".
  // It is circulation, NOT a room. Reject any compiled pocket that a stair footprint substantially
  // overlaps. IfcStair% LIKE also covers IfcStairFlight. (User: "staircase is also marked as room".)
  var STAIR_LIKE = ["IfcStair%", "IfcRamp%"];
  var STAIR_OVERLAP_REJECT = 0.35;   // drop a pocket if a stair footprint covers >=35% of its area
  // §DOOR-RESCUE (abstract rule, not a fitted band): the definition of "room" is architectural, not a
  // size threshold — an enclosed pocket is a room IFF it has a DOOR (how a person enters/exits it). A
  // wall cavity, duct or structural void never has one. MIN_AREA alone is a blunt proxy that wrongly
  // drops real small rooms (toilets, risers, store/utility closets). Below MIN_AREA, door presence is
  // the actual test. Two supporting checks are geometry-derived, not observed-data-fitted: the
  // adjacency buffer is each DOOR's OWN extracted footprint (half its real leaf/frame span) plus one
  // grid cell of rasterization slack; NOISE_FLOOR_DIM rejects a pocket narrower than a few grid cells
  // in EITHER axis — a property of the flood-fill's own resolution, not a threshold tuned to one building.
  var NOISE_FLOOR_DIM = 3 * RES;   // m — a pocket narrower than this in x OR y is a grid artefact
  var DOOR_BUFFER_SLACK = RES;     // m — rasterization slack added on top of each door's own real footprint
  // §DOOR-NOT-ROOM: a door that leads to a SHAFT, not a habitable room, must not be used as the
  // §DOOR-RESCUE "this pocket is a room" signal — same shape of problem as §STAIR-EXCLUDE. Found on
  // real data (SampleCastle): 28 IfcDoor rows named 'liftdeur' (Dutch: lift/elevator door), width
  // 0.5m — real doors, but 2 of them were rescuing actual elevator-shaft fragments as fake "rooms".
  var NON_ROOM_DOOR_NAMES = ["liftdeur", "lift", "elevator", "aufzug", "fahrstuhl", "hoist"];
  // §DOOR-PARTITION: on some real buildings (HHS confirmed) wall-enclosure flood-fill structurally
  // can't find rooms — most of the floor floods as one exterior-reachable blob because the walls that
  // would divide individual rooms simply aren't in this extraction. Gate: compare what flood-fill
  // (with door-rescue applied) found against how many real doors this storey has — every door leads
  // to a room, so a storey whose flood-fill result is a small fraction of its door count has failed.
  // Measured before picking the ratio: HHS's floors find 0-11% of their door count via flood-fill;
  // every other building's working floors find 20-100%+ (Garage sparsest: 5/8=62%; Hospital
  // sparsest: 1/5=20%) — DOOR_SHORTFALL_RATIO=0.15 sits below every working floor's ratio and above
  // every HHS one, so it never overrides an already-functioning floor.
  var DOOR_SHORTFALL_RATIO = 0.15;

  function _isRoomDoor(name) {
    var n = (name || '').toLowerCase();
    return !NON_ROOM_DOOR_NAMES.some(function (k) { return n.indexOf(k) >= 0; });
  }

  // §APPROX: these rooms are COMPILED from wall enclosure (flood-fill), NOT extracted IfcSpace.
  // Validated ~5/21 recall on ground-truth Duplex -> treat as APPROXIMATE. Labelled '≈' + COMPILED.

  function _rows(db, sql) {
    var r = db.exec(sql);
    if (!r.length) return [];
    var cols = r[0].columns, vals = r[0].values;
    return vals.map(function (v) { var o = {}; cols.forEach(function (c, i) { o[c] = v[i]; }); return o; });
  }

  function storeyWalls(db) {
    var cond = WALL_LIKE.map(function (p) { return "m.ifc_class LIKE '" + p + "'"; }).join(' OR ');
    var rows = _rows(db, "SELECT m.storey, t.center_x,t.center_y,t.center_z, t.bbox_x,t.bbox_y,t.bbox_z " +
      "FROM elements_meta m JOIN element_transforms t ON t.guid=m.guid " +
      "WHERE (" + cond + ") AND t.center_x IS NOT NULL");
    var by = {};
    rows.forEach(function (r) {
      var st = r.storey || 'Unknown';
      (by[st] = by[st] || []).push([r.center_x, r.center_y, r.center_z, r.bbox_x, r.bbox_y, r.bbox_z]);
    });
    return by;
  }

  // Per-storey stair/ramp footprints (cx,cy,bx,by) — circulation cores to exclude from rooms.
  function storeyStairs(db) {
    var cond = STAIR_LIKE.map(function (p) { return "m.ifc_class LIKE '" + p + "'"; }).join(' OR ');
    var rows = _rows(db, "SELECT m.storey, t.center_x,t.center_y, t.bbox_x,t.bbox_y " +
      "FROM elements_meta m JOIN element_transforms t ON t.guid=m.guid " +
      "WHERE (" + cond + ") AND t.center_x IS NOT NULL");
    var by = {};
    rows.forEach(function (r) {
      var st = r.storey || 'Unknown';
      (by[st] = by[st] || []).push([r.center_x, r.center_y, r.bbox_x, r.bbox_y]);
    });
    return by;
  }

  // Per-storey door (cx,cy,bx,by) — the §DOOR-RESCUE clue for genuine small rooms. Each door's OWN
  // real footprint is carried through so adjacency self-scales to that door, not a guessed metre.
  function storeyDoors(db) {
    var rows = _rows(db, "SELECT m.storey, m.element_name en, t.center_x,t.center_y, " +
      "COALESCE(t.bbox_x,0) bbox_x, COALESCE(t.bbox_y,0) bbox_y " +
      "FROM elements_meta m JOIN element_transforms t ON t.guid=m.guid " +
      "WHERE m.ifc_class LIKE 'IfcDoor%' AND t.center_x IS NOT NULL");
    var by = {};
    rows.forEach(function (r) {
      if (!_isRoomDoor(r.en)) return; // §DOOR-NOT-ROOM: lift/elevator doors aren't room evidence
      var st = r.storey || 'Unknown';
      (by[st] = by[st] || []).push([r.center_x, r.center_y, r.bbox_x, r.bbox_y]);
    });
    return by;
  }

  function doorAdjacent(rx0, ry0, rx1, ry1, doors) {
    for (var k = 0; k < doors.length; k++) {
      var dx = doors[k][0], dy = doors[k][1], dbx = doors[k][2], dby = doors[k][3];
      var buf = Math.max(dbx, dby) / 2 + DOOR_BUFFER_SLACK; // this door's own span, not a fixed guess
      if (rx0 - buf <= dx && dx <= rx1 + buf && ry0 - buf <= dy && dy <= ry1 + buf) return true;
    }
    return false;
  }

  // Largest fraction of room rect [rx0,ry0,rx1,ry1] covered by any single stair footprint.
  function stairOverlapFrac(rx0, ry0, rx1, ry1, stairs) {
    var roomArea = Math.max(1e-6, (rx1 - rx0) * (ry1 - ry0));
    var best = 0.0;
    for (var k = 0; k < stairs.length; k++) {
      var scx = stairs[k][0], scy = stairs[k][1], sbx = stairs[k][2], sby = stairs[k][3];
      var sx0 = scx - sbx / 2, sx1 = scx + sbx / 2, sy0 = scy - sby / 2, sy1 = scy + sby / 2;
      var ox = Math.max(0.0, Math.min(rx1, sx1) - Math.max(rx0, sx0));
      var oy = Math.max(0.0, Math.min(ry1, sy1) - Math.max(ry0, sy0));
      best = Math.max(best, (ox * oy) / roomArea);
    }
    return best;
  }

  function _gridExtent(walls) {
    var xs0 = Infinity, xs1 = -Infinity, ys0 = Infinity, ys1 = -Infinity;
    walls.forEach(function (w) {
      xs0 = Math.min(xs0, w[0] - w[3] / 2); xs1 = Math.max(xs1, w[0] + w[3] / 2);
      ys0 = Math.min(ys0, w[1] - w[4] / 2); ys1 = Math.max(ys1, w[1] + w[4] / 2);
    });
    var pad = RES * 2;
    xs0 -= pad; ys0 -= pad; xs1 += pad; ys1 += pad;
    var nx = Math.max(4, Math.ceil((xs1 - xs0) / RES));
    var ny = Math.max(4, Math.ceil((ys1 - ys0) / RES));
    return { xs0: xs0, ys0: ys0, xs1: xs1, ys1: ys1, nx: nx, ny: ny };
  }

  function _rasterizeWalls(walls, ext) {
    var nx = ext.nx, ny = ext.ny, xs0 = ext.xs0, ys0 = ext.ys0;
    var ix = function (x) { return Math.min(nx - 1, Math.max(0, Math.floor((x - xs0) / RES))); };
    var iy = function (y) { return Math.min(ny - 1, Math.max(0, Math.floor((y - ys0) / RES))); };
    var blocked = new Uint8Array(nx * ny);
    walls.forEach(function (w) {
      var cx = w[0], cy = w[1], bx = w[3], byv = w[4];
      var i0 = ix(cx - bx / 2), i1 = ix(cx + bx / 2);
      var j0 = iy(cy - byv / 2), j1 = iy(cy + byv / 2);
      for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) blocked[i * ny + j] = 1;
    });
    return blocked;
  }

  // Morphological close: dilate walls SEAL cells to seal hairline corner/door-jamb gaps so the
  // exterior flood can't leak into a room through a 1-2 cell crack (it still leaves real ~1m
  // doorways open — by design those connect rooms, handled by the area filter / per-room split).
  function _dilate(blocked, nx, ny, seal) {
    var b = blocked;
    for (var s = 0; s < seal; s++) {
      var d = new Uint8Array(nx * ny);
      for (var i = 0; i < nx; i++) {
        for (var j = 0; j < ny; j++) {
          var k = i * ny + j, v = b[k];
          if (!v && i > 0 && b[k - ny]) v = 1;
          if (!v && i < nx - 1 && b[k + ny]) v = 1;
          if (!v && j > 0 && b[k - 1]) v = 1;
          if (!v && j < ny - 1 && b[k + 1]) v = 1;
          d[k] = v;
        }
      }
      b = d;
    }
    return b;
  }

  // exterior flood from border free cells (4-connectivity, iterative stack) -> returns `enclosed`
  function _floodExterior(free, nx, ny) {
    var ext = new Uint8Array(nx * ny);
    var stack = [];
    for (var i = 0; i < nx; i++) {
      [0, ny - 1].forEach(function (j) {
        var k = i * ny + j;
        if (free[k] && !ext[k]) { ext[k] = 1; stack.push(k); }
      });
    }
    for (var j = 0; j < ny; j++) {
      [0, nx - 1].forEach(function (i) {
        var k = i * ny + j;
        if (free[k] && !ext[k]) { ext[k] = 1; stack.push(k); }
      });
    }
    while (stack.length) {
      var k0 = stack.pop();
      var i0 = Math.floor(k0 / ny), j0 = k0 % ny;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var a = i0 + d[0], b = j0 + d[1];
        if (a >= 0 && a < nx && b >= 0 && b < ny) {
          var k = a * ny + b;
          if (free[k] && !ext[k]) { ext[k] = 1; stack.push(k); }
        }
      });
    }
    var enclosed = new Uint8Array(nx * ny);
    for (var m = 0; m < nx * ny; m++) enclosed[m] = free[m] && !ext[m] ? 1 : 0;
    return enclosed;
  }

  function floodRooms(walls, stairs, doors) {
    stairs = stairs || []; doors = doors || [];
    var ext = _gridExtent(walls);
    var nx = ext.nx, ny = ext.ny, xs0 = ext.xs0, ys0 = ext.ys0;
    var blocked = _rasterizeWalls(walls, ext);
    if (SEAL > 0) blocked = _dilate(blocked, nx, ny, SEAL);
    var free = new Uint8Array(nx * ny);
    for (var m = 0; m < nx * ny; m++) free[m] = blocked[m] ? 0 : 1;
    var enclosed = _floodExterior(free, nx, ny);

    var rooms = [];
    var seen = new Uint8Array(nx * ny);
    var cellArea = RES * RES;
    var planArea = nx * ny * cellArea;
    var cz = walls.reduce(function (s, w) { return s + w[2]; }, 0) / walls.length;
    var bz = walls.reduce(function (s, w) { return s + w[5]; }, 0) / walls.length;

    for (var si = 0; si < nx; si++) {
      for (var sj = 0; sj < ny; sj++) {
        var sk = si * ny + sj;
        if (!enclosed[sk] || seen[sk]) continue;
        var comp = 0, stack = [sk]; seen[sk] = 1;
        var mni = si, mxi = si, mnj = sj, mxj = sj;
        while (stack.length) {
          var k = stack.pop();
          var i = Math.floor(k / ny), j = k % ny;
          comp++;
          if (i < mni) mni = i; if (i > mxi) mxi = i;
          if (j < mnj) mnj = j; if (j > mxj) mxj = j;
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
            var a = i + d[0], b = j + d[1];
            if (a >= 0 && a < nx && b >= 0 && b < ny) {
              var kk = a * ny + b;
              if (enclosed[kk] && !seen[kk]) { seen[kk] = 1; stack.push(kk); }
            }
          });
        }
        var area = comp * cellArea;
        if (area > MAX_AREA_ABS || area > planArea * MAX_AREA_FRAC) continue;
        var wx0 = xs0 + mni * RES, wx1 = xs0 + (mxi + 1) * RES;
        var wy0 = ys0 + mnj * RES, wy1 = ys0 + (mxj + 1) * RES;
        // §DOOR-RESCUE (abstract test, applies uniformly — not a size band): a pocket is a room if
        // it is big enough to obviously be one on its own (area >= MIN_AREA, unchanged) OR it has a
        // real door AND isn't a bare rasterization sliver (NOISE_FLOOR_DIM).
        var doorRescued = false;
        if (area < MIN_AREA) {
          var dimsOk = (wx1 - wx0) >= NOISE_FLOOR_DIM && (wy1 - wy0) >= NOISE_FLOOR_DIM;
          if (!(dimsOk && doorAdjacent(wx0, wy0, wx1, wy1, doors))) continue;
          doorRescued = true;
        }
        // §STAIR-EXCLUDE: a stair/ramp footprint covering this pocket -> it's a circulation shaft,
        // not a room. Drop it.
        var sf = stairOverlapFrac(wx0, wy0, wx1, wy1, stairs);
        if (sf >= STAIR_OVERLAP_REJECT) continue;
        rooms.push({
          cx: (wx0 + wx1) / 2, cy: (wy0 + wy1) / 2, cz: cz,
          sx: wx1 - wx0, sy: wy1 - wy0, sz: Math.max(bz, 2.0), area: area,
          door_rescued: doorRescued
        });
      }
    }
    return rooms;
  }

  function partitionByDoors(walls, doors, stairs) {
    if (!doors.length) return [];
    var ext = _gridExtent(walls);
    var nx = ext.nx, ny = ext.ny, xs0 = ext.xs0, ys0 = ext.ys0;
    var blocked = _rasterizeWalls(walls, ext);
    var free = new Uint8Array(nx * ny);
    for (var m = 0; m < nx * ny; m++) free[m] = blocked[m] ? 0 : 1;
    var cz = walls.reduce(function (s, w) { return s + w[2]; }, 0) / walls.length;
    var bz = walls.reduce(function (s, w) { return s + w[5]; }, 0) / walls.length;
    var ix = function (x) { return Math.min(nx - 1, Math.max(0, Math.floor((x - xs0) / RES))); };
    var iy = function (y) { return Math.min(ny - 1, Math.max(0, Math.floor((y - ys0) / RES))); };

    var owner = new Int32Array(nx * ny).fill(-1);
    var queue = [], head = 0;
    doors.forEach(function (d, di) {
      var ci = ix(d[0]), cj = iy(d[1]);
      var seed = null;
      for (var r = 0; r <= 6 && !seed; r++) { // expand outward (~1.4m) to find a free cell to seed this door from
        for (var da = -r; da <= r && !seed; da++) {
          for (var db = -r; db <= r && !seed; db++) {
            if (Math.max(Math.abs(da), Math.abs(db)) !== r) continue;
            var a = ci + da, b = cj + db;
            if (a >= 0 && a < nx && b >= 0 && b < ny) {
              var k = a * ny + b;
              if (free[k] && owner[k] === -1) seed = k;
            }
          }
        }
      }
      if (seed === null) return;
      owner[seed] = di; queue.push(seed);
    });

    while (head < queue.length) {
      var k0 = queue[head++];
      var i0 = Math.floor(k0 / ny), j0 = k0 % ny;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var a = i0 + d[0], b = j0 + d[1];
        if (a >= 0 && a < nx && b >= 0 && b < ny) {
          var k = a * ny + b;
          if (free[k] && owner[k] === -1) { owner[k] = owner[k0]; queue.push(k); }
        }
      });
    }

    var cellArea = RES * RES, planArea = nx * ny * cellArea;
    var byOwner = {};
    for (var k = 0; k < nx * ny; k++) {
      var o = owner[k];
      if (o === -1) continue;
      (byOwner[o] = byOwner[o] || []).push(k);
    }
    var rooms = [];
    doors.forEach(function (d, di) {
      var cells = byOwner[di];
      if (!cells || !cells.length) return;
      var mni = Infinity, mxi = -Infinity, mnj = Infinity, mxj = -Infinity;
      cells.forEach(function (k) {
        var i = Math.floor(k / ny), j = k % ny;
        if (i < mni) mni = i; if (i > mxi) mxi = i;
        if (j < mnj) mnj = j; if (j > mxj) mxj = j;
      });
      var area = cells.length * cellArea;
      var wx0 = xs0 + mni * RES, wx1 = xs0 + (mxi + 1) * RES;
      var wy0 = ys0 + mnj * RES, wy1 = ys0 + (mxj + 1) * RES;
      if ((wx1 - wx0) < NOISE_FLOOR_DIM || (wy1 - wy0) < NOISE_FLOOR_DIM) return;
      if (area > MAX_AREA_ABS || area > planArea * MAX_AREA_FRAC) return;
      if (stairOverlapFrac(wx0, wy0, wx1, wy1, stairs) >= STAIR_OVERLAP_REJECT) return;
      rooms.push({
        cx: (wx0 + wx1) / 2, cy: (wy0 + wy1) / 2, cz: cz,
        sx: wx1 - wx0, sy: wy1 - wy0, sz: Math.max(bz, 2.0), area: area,
        door_rescued: false, door_partitioned: true
      });
    });
    return rooms;
  }

  // Per-storey compile pass (compile_rooms.py's main() loop, minus DB write). Returns
  // { report: [...], rooms: [...] } — report matches ROOM_WALKER_JS_PORT.md Task 3's required table
  // shape (building/count/method/status/total is assembled by the CALLER, which knows the building
  // name; this function reports per-storey).
  function compileRooms(db) {
    var stGuid = {};
    // compile_rooms.py wraps this in try/except: a never-walked building (fresh import, or this
    // table intentionally dropped) has no spatial_structure table at all yet — that's not an error,
    // just "no known storey guids to reuse for parent_guid" (writeRooms falls back to a synthetic
    // STC_ guid per storey either way, see the `r.parent = stGuid[st] || ('STC_'+st)...` line below).
    if (db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spatial_structure'").length) {
      _rows(db, "SELECT guid, name FROM spatial_structure WHERE type='IfcBuildingStorey'")
        .forEach(function (r) { stGuid[r.name] = r.guid; });
    }

    var wallsBy = storeyWalls(db);
    var stairsBy = storeyStairs(db);
    var doorsBy = storeyDoors(db);
    // §STAIR-EXCLUDE: stair storey is often 'Unknown'/unassigned in the extract, and a stair is a
    // CONTINUOUS vertical shaft anyway — test every room pocket against the UNION of all stair
    // footprints by XY (not per-storey).
    var allStairs = [];
    Object.keys(stairsBy).forEach(function (st) { allStairs = allStairs.concat(stairsBy[st]); });

    var allrooms = [], report = [], stZ = {};
    Object.keys(wallsBy).sort().forEach(function (st) {
      var ws = wallsBy[st];
      if (ws.length < 3) {
        report.push({ storey: st, walls: ws.length, doors: 0, method: 'skip (too few walls)', roomCount: 0 });
        return;
      }
      var doors = doorsBy[st] || [];
      var roomsFlood = floodRooms(ws, allStairs, doors);
      // §DOOR-PARTITION gate: flood-fill found far fewer rooms than this storey has real doors — it
      // has structurally failed here, fall back to nearest-door partitioning.
      var rooms, method;
      if (doors.length && roomsFlood.length < DOOR_SHORTFALL_RATIO * doors.length) {
        rooms = partitionByDoors(ws, doors, allStairs);
        method = 'door-partition (flood-fill only found ' + roomsFlood.length + '/' + doors.length + ' doors)';
      } else {
        rooms = roomsFlood;
        method = 'flood-fill';
      }
      var rescued = rooms.filter(function (r) { return r.door_rescued; }).length;
      var partitioned = rooms.filter(function (r) { return r.door_partitioned; }).length;
      stZ[st] = ws.reduce(function (s, w) { return s + w[2]; }, 0) / ws.length; // storey z = mean wall centre-z
      report.push({
        storey: st, walls: ws.length, doors: doors.length, method: method, roomCount: rooms.length,
        doorRescued: rescued, doorPartitioned: partitioned, areas: rooms.map(function (r) { return Math.round(r.area); })
      });
      rooms.forEach(function (r, k) {
        r.storey = st; r.guid = ('RM_' + st + '_' + (k + 1)).replace(/ /g, '_');
        // §APPROX: '≈' marks the room as compiled/approximate in the lens label. parent_guid -> a
        // compiled storey row (created on write) so the Room lens groups per floor.
        r.name = '≈ ' + st + ' R' + (k + 1);
        r.parent = stGuid[st] || ('STC_' + st).replace(/ /g, '_');
        allrooms.push(r);
      });
    });
    var total = allrooms.length;
    var doorRescuedTotal = allrooms.filter(function (r) { return r.door_rescued; }).length;
    var doorPartitionTotal = allrooms.filter(function (r) { return r.door_partitioned; }).length;
    return { report: report, rooms: allrooms, stZ: stZ, total: total, doorRescuedTotal: doorRescuedTotal, doorPartitionTotal: doorPartitionTotal };
  }

  // Persist a compileRooms() result into spatial_structure + rel_contained_in_space (the --write
  // half of compile_rooms.py's main()). Idempotent: prior compiled rows (RM_%/STC_%) are replaced.
  function writeRooms(db, compiled) {
    var allrooms = compiled.rooms, stZ = compiled.stZ;
    var hasTable = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spatial_structure'").length > 0;
    if (!hasTable) {
      db.run("CREATE TABLE spatial_structure (guid TEXT, type TEXT, name TEXT, parent_guid TEXT, " +
        "object_type TEXT, predefined_type TEXT, center_x REAL, center_y REAL, center_z REAL, " +
        "size_x REAL, size_y REAL, size_z REAL)");
    } else {
      ['center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'object_type', 'predefined_type']
        .forEach(function (col) {
          try { db.run('ALTER TABLE spatial_structure ADD COLUMN ' + col + (col.indexOf('center') === 0 || col.indexOf('size') === 0 ? ' REAL' : ' TEXT')); }
          catch (e) { /* already exists — fine */ }
        });
    }
    // §APPROX: compiled storey rows (only where the DB has none) so the Room lens can group rooms
    // per floor via parent_guid -> IfcBuildingStorey.name. Idempotent on the STC_ prefix.
    db.run("DELETE FROM spatial_structure WHERE type='IfcBuildingStorey' AND guid LIKE 'STC\\_%' ESCAPE '\\'");
    var stStmt = db.prepare("INSERT INTO spatial_structure (guid,type,name,parent_guid,object_type,predefined_type,center_z) VALUES (?,?,?,?,?,?,?)");
    Object.keys(stZ).sort().forEach(function (st) {
      if (!allrooms.some(function (r) { return r.storey === st; })) return;
      stStmt.run([('STC_' + st).replace(/ /g, '_'), 'IfcBuildingStorey', st, null, 'COMPILED', null, stZ[st]]);
    });
    stStmt.free();
    // remove any prior compiled rooms (idempotent)
    db.run("DELETE FROM spatial_structure WHERE type='IfcSpace' AND guid LIKE 'RM\\_%' ESCAPE '\\'");
    var roomStmt = db.prepare("INSERT INTO spatial_structure (guid,type,name,parent_guid,object_type,predefined_type," +
      "center_x,center_y,center_z,size_x,size_y,size_z) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    allrooms.forEach(function (r) {
      // predefined_type distinguishes which compile technique found each room, for traceability —
      // object_type stays 'COMPILED' either way (the tag spacesOf()'s exclusion filter keys on).
      var ptype = r.door_partitioned ? 'INTERNAL_DOORPART' : r.door_rescued ? 'INTERNAL_SMALL' : 'INTERNAL';
      roomStmt.run([r.guid, 'IfcSpace', r.name, r.parent, 'COMPILED', ptype, r.cx, r.cy, r.cz, r.sx, r.sy, r.sz]);
    });
    roomStmt.free();
    // rel_contained_in_space: elements whose XY centre falls inside a room (compiled)
    if (!db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rel_contained_in_space'").length) {
      db.run('CREATE TABLE rel_contained_in_space (space_guid TEXT, element_guid TEXT)');
    }
    db.run("DELETE FROM rel_contained_in_space WHERE space_guid LIKE 'RM\\_%' ESCAPE '\\'");
    var els = _rows(db, "SELECT m.guid g, m.storey st, t.center_x ex, t.center_y ey FROM elements_meta m " +
      "JOIN element_transforms t ON t.guid=m.guid WHERE t.center_x IS NOT NULL");
    var byst = {};
    allrooms.forEach(function (r) { (byst[r.storey] = byst[r.storey] || []).push(r); });
    var relStmt = db.prepare('INSERT INTO rel_contained_in_space (space_guid, element_guid) VALUES (?,?)');
    var rel = 0;
    els.forEach(function (e) {
      var candidates = byst[e.st] || [];
      for (var i = 0; i < candidates.length; i++) {
        var r = candidates[i];
        if (Math.abs(e.ex - r.cx) <= r.sx / 2 && Math.abs(e.ey - r.cy) <= r.sy / 2) {
          relStmt.run([r.guid, e.g]); rel++; break;
        }
      }
    });
    relStmt.free();
    return { roomsWritten: allrooms.length, relWritten: rel };
  }

  // Convenience matching compile_rooms.py's CLI main(): compute, optionally persist. `opts.write`
  // mirrors `--write`; without it this is a dry run (compute + report only, DB untouched).
  function walk(db, opts) {
    opts = opts || {};
    var compiled = compileRooms(db);
    var result = { report: compiled.report, total: compiled.total,
      doorRescuedTotal: compiled.doorRescuedTotal, doorPartitionTotal: compiled.doorPartitionTotal };
    if (opts.write) {
      var w = writeRooms(db, compiled);
      result.roomsWritten = w.roomsWritten; result.relWritten = w.relWritten;
    }
    return result;
  }

  var API = {
    storeyWalls: storeyWalls, storeyStairs: storeyStairs, storeyDoors: storeyDoors,
    doorAdjacent: doorAdjacent, stairOverlapFrac: stairOverlapFrac,
    floodRooms: floodRooms, partitionByDoors: partitionByDoors,
    compileRooms: compileRooms, writeRooms: writeRooms, walk: walk,
    RES: RES, MIN_AREA: MIN_AREA, DOOR_SHORTFALL_RATIO: DOOR_SHORTFALL_RATIO
  };
  ROOT.RoomWalker = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof console !== 'undefined') console.log(TAG + ' module loaded');
})();
