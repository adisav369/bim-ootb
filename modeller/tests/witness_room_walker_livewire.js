'use strict';
// ⚠ DO NOT REMOVE
// SCOPE: W-ROOM-WALKER-LIVEWIRE — proves the "Rooms" Outliner category (room_walker_outliner.js) is
// wired end-to-end in the real running Modeller: browse-only + zero auto-compute for a building that
// already has room data, and the explicit "▶ walk" trigger → real click → RoomWalker.walk() → matches
// the Node CLI's known count for a building that doesn't. Mirrors witness_dw_livewire.js's harness
// (puppeteer + a bare static server + §-tagged console-log assertions, §-log-first per project
// convention). Read the log after every run — exit code alone is not evidence.
const path = require('path');
const http = require('http');
const fs = require('fs');
const puppeteer = require(path.join(process.env.HOME, 'bim-compiler', 'node_modules', 'puppeteer'));

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.env.LIVEWIRE_OUT || path.join(ROOT, 'logs');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.db': 'application/octet-stream', '.data': 'application/octet-stream' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/modeller/modeller.html';
  fs.readFile(path.join(ROOT, p), (e, b) => { if (e) { r.writeHead(404); r.end('404'); return; } r.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' }); r.end(b); });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  ' + x : '')); } };
const grab = (ls, tag) => ls.filter(l => l.indexOf(tag) >= 0);
const num = (l, k) => { const m = l && l.match(new RegExp(k + '=(-?\\d+)')); return m ? +m[1] : null; };

async function openResident(br, key, minChildren, deadlineMs) {
  const pg = await br.newPage(); await pg.setViewport({ width: 1280, height: 850, deviceScaleFactor: 1 });
  const logs = [], errs = [];
  pg.on('console', m => logs.push(m.text()));
  pg.on('pageerror', e => errs.push(String(e).slice(0, 300)));
  await pg.goto(`http://localhost:${server.address().port}/modeller/modeller.html`, { waitUntil: 'load', timeout: 60000 });
  await pg.waitForFunction('window.__sceneReady === true && !!window.Bonsai', { timeout: 30000 }).catch(() => {});
  await pg.click('#b-open'); await sleep(200);
  await pg.click(`#m-open-panel .mo-row[data-key="${key}"]`);
  const deadline = Date.now() + deadlineMs;
  let lastN = -1, stable = 0, n = -1;
  while (Date.now() < deadline) {
    n = await pg.evaluate(() => { const g = window.Bonsai && window.Bonsai.group ? window.Bonsai.group() : null; return g ? g.children.length : -1; }).catch(() => -1);
    if (n === lastN && n > 0) stable++; else stable = 0;
    lastN = n;
    if (stable >= 8 && n >= minChildren) break;
    await sleep(500);
  }
  console.log(`  §LIVEWIRE-OPEN ${key} children=${n}`);
  return { pg, logs, errs };
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  fs.mkdirSync(OUT, { recursive: true });

  // ── Block A: Duplex already has real room data (20 IfcSpace via extraction) — Rooms category must
  // display it browse-only, with ZERO §ROOM-WALK log (no auto-compute on open). ──
  {
    const { pg, logs, errs } = await openResident(br, 'Duplex', 100, 40000);
    await sleep(1500); // let the Outliner categories paint after Open
    const roomState = await pg.evaluate(() => {
      const rows = window.RoomWalkerOutliner ? window.RoomWalkerOutliner._readRooms() : null;
      const nodes = window.RoomWalkerOutliner ? window.RoomWalkerOutliner._category().tree() : null;
      return { rowCount: rows ? rows.length : -1, rootLabel: nodes && nodes[0] ? nodes[0].label : null, rootDisc: nodes && nodes[0] ? nodes[0].disc || null : null };
    });
    chk('duplex-rooms-loaded-module', typeof roomState.rowCount === 'number', JSON.stringify(roomState));
    chk('duplex-has-real-room-data', roomState.rowCount > 0, 'rowCount=' + roomState.rowCount);
    chk('duplex-root-browse-only-no-disc', roomState.rootDisc === null, 'rootDisc=' + roomState.rootDisc + ' (must be unset so clicking can never re-trigger a walk)');
    chk('duplex-zero-auto-compute', grab(logs, '§ROOM-WALK ').length === 0, 'ROOM-WALK log lines=' + grab(logs, '§ROOM-WALK ').length);
    await pg.screenshot({ path: path.join(OUT, 'room_walker_duplex_populated.png') });
    chk('duplex zero pageerror', errs.length === 0, errs[0] || '');
    await pg.close();
  }

  // ── Block B: Garage has synthetic (compile_rooms.py-produced) room data, known answer = 5 rooms
  // (Task 3's report table). Strip it in-page to simulate a never-walked building, confirm the trigger
  // row appears with zero auto-compute, then drive the REAL click path (not calling window.roomWalk()
  // directly) through the Outliner DOM and confirm the recomputed count matches. ──
  {
    const { pg, logs, errs } = await openResident(br, 'HospitalGarage', 20, 40000);
    await sleep(1500);
    const stripResult = await pg.evaluate(async () => {
      const db = new window.SQL.Database(new Uint8Array(window.__dwBuf));
      db.run("DROP TABLE IF EXISTS spatial_structure");
      db.run("DROP TABLE IF EXISTS rel_contained_in_space");
      window.__dwBuf = db.export();
      db.close();
      window.Bonsai.outliner.refresh();
      const nodes = window.RoomWalkerOutliner._category().tree();
      return { rootLabel: nodes[0] && nodes[0].label, rootDisc: nodes[0] && nodes[0].disc, rootSub: nodes[0] && nodes[0].sub };
    });
    chk('garage-stripped-shows-trigger', stripResult.rootDisc === 'ROOM', JSON.stringify(stripResult));
    chk('garage-zero-auto-compute-after-strip', grab(logs, '§ROOM-WALK ').length === 0, 'ROOM-WALK log lines=' + grab(logs, '§ROOM-WALK ').length);

    // Real click path: expand the "Rooms" category header (if collapsed), then click the trigger row.
    await pg.evaluate(() => { window.Bonsai.outliner._collapsed['tcat|roomwalk'] = false; window.Bonsai.outliner.refresh(); });
    await sleep(300);
    const before = logs.length;
    const clicked = await pg.evaluate(() => {
      const el = document.querySelector('[data-tcat="roomwalk"][data-disc="ROOM"]');
      if (!el) return false;
      el.click();
      return true;
    });
    chk('garage-trigger-row-clickable-in-dom', clicked === true, 'clicked=' + clicked);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (logs.slice(before).some(l => l.indexOf('§ROOM-WALK placed=') >= 0)) break;
      await sleep(300);
    }
    const walkLine = grab(logs.slice(before), '§ROOM-WALK placed=')[0];
    chk('garage-walk-completed', !!walkLine, walkLine || '(no §ROOM-WALK placed= line seen within 15s)');
    chk('garage-walk-count-matches-known-answer', walkLine && num(walkLine, 'placed') === 5, walkLine || '');

    const afterState = await pg.evaluate(() => {
      const nodes = window.RoomWalkerOutliner._category().tree();
      return { rootDisc: nodes[0] && nodes[0].disc, rootLabel: nodes[0] && nodes[0].label };
    });
    chk('garage-post-walk-browse-only', afterState.rootDisc === undefined || afterState.rootDisc === null, JSON.stringify(afterState));

    await pg.screenshot({ path: path.join(OUT, 'room_walker_garage_after_walk.png') });
    chk('garage zero pageerror', errs.length === 0, errs[0] || '');
    await pg.close();
  }

  await br.close(); server.close();
  console.log(`\nW-ROOM-WALKER-LIVEWIRE: ${pass}/${pass + fail} PASS`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('W-ROOM-WALKER-LIVEWIRE crashed:', e); process.exit(1); });
