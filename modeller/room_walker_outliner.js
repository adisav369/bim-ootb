// room_walker_outliner.js — "Rooms" Outliner category (ROOM_WALKER_JS_PORT.md Task 4). Follows the
// SAME registered-category / onWalk-dispatch convention as bom_tree_outliner.js / str_walker_outliner.js
// (window.Bonsai.outliner.addCategory — "seam for Room/Phase/ERP", bonsai_outliner.js:70) — NOT the
// passive dw_instances_outliner.js pattern. Closest small-scale template: the `disctrunk` category in
// modeller.html (empty-state placeholder row vs a populated browse-only tree, onWalk forwards to a
// page-level function). §2 guardrail (ROOM_WALKER_JS_PORT.md): NEVER auto-run on open, NEVER recompute
// once spatial_structure has data — only the empty-state row carries `disc`, so a populated category is
// browse-only and can never re-trigger a walk by being clicked/expanded.
(function () {
  'use strict';
  var TAG = '§ROOMWALK';

  // Reopen the session's stashed building buffer read-only (same convention disc_walker.js's own
  // comment documents: "so the disc-walker can re-open this building read-only on a discipline click").
  // Cheap and always-fresh — no separate cache to go stale relative to window.__dwBuf.
  function _readRooms() {
    if (!window.__dwBuf) return null; // no building open yet
    if (!window.SQL) return null;     // sql.js not ready yet
    var db;
    try { db = new window.SQL.Database(new Uint8Array(window.__dwBuf)); }
    catch (e) { console.warn(TAG + ' read failed ' + (e && e.message)); return null; }
    var hasTable = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spatial_structure'").length > 0;
    var rows = hasTable
      ? db.exec("SELECT guid,name,object_type FROM spatial_structure WHERE type='IfcSpace' ORDER BY name")
      : [];
    db.close();
    return rows.length ? rows[0].values : [];
  }

  function tree() {
    var rows = _readRooms();
    if (rows === null) {
      return [{ id: 'rw-empty', label: 'Open a resident (▾) or local .db (🏗) first', sub: '', kind: 'group', children: [] }];
    }
    if (!rows.length) {
      // Empty state: the ONLY row that carries `disc` — this is what renders the ▶ walk glyph and
      // wires onWalk through bonsai_outliner.js's dispatch chokepoint (data-disc -> cat.onWalk(disc)).
      return [{ id: 'rw-trigger', label: 'Rooms — not walked yet', sub: '▶ walk', kind: 'disc', disc: 'ROOM', children: [] }];
    }
    // Has data already (real IfcSpace from extraction, or a prior Room Walker run) — browse-only, no
    // `disc` field on this row, so clicking/expanding it can NEVER re-trigger a recompute.
    var children = rows.map(function (v) {
      var guid = v[0], name = v[1], objType = v[2];
      var synthetic = String(guid).indexOf('RM_') === 0;
      return { id: 'rw-' + guid, label: name + (synthetic ? ' (≈)' : ''), kind: 'element', sub: objType || '' };
    });
    return [{ id: 'rw-root', label: 'Rooms (' + children.length + ')', kind: 'group', sub: '', children: children }];
  }

  function category() {
    return {
      key: 'roomwalk', label: 'Rooms',
      tree: tree,
      // Thin forwarder to the page-level dispatch function (same separation-of-concerns convention as
      // bom_tree_outliner.js's onWalk -> window.discWalk) — actual compute lives in modeller.html.
      onWalk: function (disc) { if (window.roomWalk) window.roomWalk(); }
    };
  }

  function onClear() {
    // No local state stashed by this file (tree() always re-derives from window.__dwBuf) — nothing to
    // reset here, kept as an explicit no-op for parity with str_walker_outliner.js's onClear convention
    // (documented lesson from the §GRID-CLEAR-LEAK bug class: state-leak bugs come from state that
    // LOOKS like it needs no clearing and then does).
  }

  window.RoomWalkerOutliner = {
    register: function () {
      if (window.Bonsai && window.Bonsai.outliner) window.Bonsai.outliner.addCategory(category());
      console.log(TAG + ' registered — Rooms category (explicit "Room Walker" trigger when empty, browse-only once populated)');
    },
    onClear: onClear, _category: category, _readRooms: _readRooms
  };
})();
