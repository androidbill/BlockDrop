'use strict';
// BlockDrop — BRIX/Puzznic clone
// Controls: Arrow keys = move cursor | Z = push left | X = push right | R = retry | ESC = menu

// ── Constants ─────────────────────────────────────────────────────────────
const CELL  = 36;
const GCOLS = 10;
const GROWS = 18;

// Tile types
const T_EMPTY = 0, T_WALL = 1, T_BARRIER = 2, T_ELEV = 3,
      T_LASER_H = 4, T_LASER_V = 5, T_TELE = 6, T_HG = 7,
      T_ACID_S = 8, T_ACID_K = 9;

// Block colors / patterns index 1-6
const BTYPE = 6;

// Animation durations (ms)
const SLIDE_DUR  = 180;
const FALL_SPEED = 18; // rows per second during fall
const ELIM_DUR   = 500;

// ── State ─────────────────────────────────────────────────────────────────
let canvas, ctx;
let tilemap  = [];
let bGrid    = [];
let bList    = [];
let elevs    = [];
let teles    = [];
let laserBeams = new Set();
let cursor = { row:5, col:3 };
let gravity  = 1;     // +1 down, -1 up
let timeLeft = 90;
let retries  = 2;
let score    = 0;
let hiScore  = 0;
let levelIdx = 0;
let phase    = 'menu'; // menu|idle|animating|won|lost|levelcomplete
let phaseTimer = 0;    // general countdown (ms)
let hgTimer  = 0;
let hgActive = false;
let timerID  = null;
let pendingPhysics = false;  // physics resolve needed after animation
let fallTimer  = -1;         // countdown (ms) before post-fall physics check
let slideBlock = null;       // block currently sliding
let slideFrom  = 0;          // starting col
let slideTo    = 0;          // target col
let slideT     = 0;          // progress 0-1
let elimBlocks = [];         // blocks being eliminated
let elimT      = 0;          // 0-1 progress
let flashOn    = true;       // for blink
let flashTimer = 0;

// ── Init ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('gc');
  ctx    = canvas.getContext('2d');

  canvas.width  = GCOLS * CELL;
  canvas.height = GROWS * CELL;

  hiScore = parseInt(localStorage.getItem('bd_hi') || '0');

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('click',    onCanvasClick);
  canvas.addEventListener('touchend', e => { e.preventDefault(); onCanvasClick(e.changedTouches[0]); }, { passive: false });

  document.getElementById('btnLeft').addEventListener('click',  () => tryPush(-1));
  document.getElementById('btnRight').addEventListener('click', () => tryPush(1));
  document.getElementById('btnRetry').addEventListener('click', retryLevel);
  document.getElementById('btnMenu').addEventListener('click',  () => goMenu());

  requestAnimationFrame(gameLoop);
});

// ── Game loop ──────────────────────────────────────────────────────────────
let lastTS = 0;
function gameLoop(ts) {
  const dt = Math.min(ts - lastTS, 50);
  lastTS = ts;
  update(dt);
  render();
  updateHUD();
  requestAnimationFrame(gameLoop);
}

function update(dt) {
  if (phase === 'animating') {
    if (slideBlock) {
      slideT += dt / SLIDE_DUR;
      if (slideT >= 1) {
        slideT = 1;
        finalizeSlide();
      }
    } else if (elimBlocks.length > 0) {
      elimT += dt / ELIM_DUR;
      flashTimer += dt;
      if (flashTimer > 80) { flashOn = !flashOn; flashTimer = 0; }
      if (elimT >= 1) finalizeElim();
    } else if (fallTimer > 0) {
      fallTimer -= dt;
      if (fallTimer <= 0) { fallTimer = -1; pendingPhysics = true; }
    } else if (pendingPhysics) {
      stepPhysics();
    }
  }

  if (hgActive) {
    hgTimer -= dt;
    if (hgTimer <= 0) flipGravity();
  }

  // Animate elevators
  if (elevs) {
    elevs.forEach(e => {
      e.curRow += e.dir * e.speed * dt * 0.06;
      if (e.curRow >= e.maxRow) { e.curRow = e.maxRow; e.dir = -1; }
      if (e.curRow <= e.minRow) { e.curRow = e.minRow; e.dir = 1; }
    });
  }

  if (phaseTimer > 0) {
    phaseTimer -= dt;
    if (phaseTimer <= 0) {
      if (phase === 'levelcomplete') startLevel(levelIdx + 1);
      else if (phase === 'won' || phase === 'lost') phase = 'menu';
    }
  }
}

// ── Level loading ──────────────────────────────────────────────────────────
function startLevel(idx) {
  if (idx >= LEVELS.length) { phase = 'won'; phaseTimer = 3000; return; }
  levelIdx = idx;
  const lvl = LEVELS[idx];
  gravity  = 1;
  timeLeft = lvl.timeLimit || 90;
  retries  = 2;
  hgActive = false;
  hgTimer  = 0;
  cursor   = { row: GROWS - 3, col: Math.floor(GCOLS / 2) };
  elimBlocks = [];
  slideBlock = null;
  pendingPhysics = false;

  tilemap = Array.from({length: GROWS}, () => new Array(GCOLS).fill(T_EMPTY));
  bGrid   = Array.from({length: GROWS}, () => new Array(GCOLS).fill(null));
  bList   = [];
  elevs   = [];
  teles   = (lvl.teleporters || []).map(t => ({...t}));

  const g = lvl.grid;
  for (let r = 0; r < GROWS; r++) {
    const row = g[r] || '';
    for (let c = 0; c < GCOLS; c++) {
      const ch = row[c] || ' ';
      if      (ch === '#') tilemap[r][c] = T_WALL;
      else if (ch === 'B') tilemap[r][c] = T_BARRIER;
      else if (ch === 'E') tilemap[r][c] = T_ELEV;
      else if (ch === 'L') tilemap[r][c] = T_LASER_H;
      else if (ch === 'V') tilemap[r][c] = T_LASER_V;
      else if (ch === 'T') tilemap[r][c] = T_TELE;
      else if (ch === 'H') tilemap[r][c] = T_HG;
      else if (ch === 'A') tilemap[r][c] = T_ACID_S;
      else if (ch === 'X') tilemap[r][c] = T_ACID_K;
      else if (ch >= '1' && ch <= '6') {
        const b = { type: parseInt(ch), row: r, col: c, vrow: r, vcol: c, alpha: 1 };
        bList.push(b);
        bGrid[r][c] = b;
      }
    }
  }

  (lvl.elevators || []).forEach(e => elevs.push({ ...e, curRow: e.startRow, dir: 1 }));

  resolveAllPhysics(true);
  buildLaserBeams();
  phase = 'idle';
  clearInterval(timerID);
  timerID = setInterval(tickTimer, 1000);
}

function tickTimer() {
  if (phase !== 'idle') return;
  timeLeft--;
  if (timeLeft <= 0) { timeLeft = 0; onTimeUp(); }
}

function onTimeUp() {
  if (retries > 0) {
    retries--;
    timeLeft = LEVELS[levelIdx].timeLimit || 90;
    buildLaserBeams();
  } else {
    phase = 'lost';
    clearInterval(timerID);
    phaseTimer = 3000;
  }
}

function retryLevel() {
  clearInterval(timerID);
  startLevel(levelIdx);
}

function goMenu() {
  clearInterval(timerID);
  phase = 'menu';
}

// ── Physics ────────────────────────────────────────────────────────────────
function isSolid(r, c) {
  if (r < 0 || r >= GROWS || c < 0 || c >= GCOLS) return true;
  const t = tilemap[r][c];
  if (t === T_WALL || t === T_BARRIER) return true;
  if (bGrid[r][c]) return true;
  // elevator platform
  if (elevs.some(e => c === e.col && Math.round(e.curRow) === r)) return true;
  return false;
}

function isSolidNoBlock(r, c) {
  if (r < 0 || r >= GROWS || c < 0 || c >= GCOLS) return true;
  const t = tilemap[r][c];
  return t === T_WALL || t === T_BARRIER;
}

// Apply one round of gravity — returns true if any block moved
function applyGravity(instant) {
  let moved = false;
  // process in gravity order
  const rows = gravity === 1
    ? Array.from({length: GROWS}, (_, i) => GROWS - 1 - i)
    : Array.from({length: GROWS}, (_, i) => i);

  rows.forEach(r => {
    for (let c = 0; c < GCOLS; c++) {
      const b = bGrid[r][c];
      if (!b) continue;
      const below = r + gravity;
      if (below >= 0 && below < GROWS && !isSolid(below, c)) {
        bGrid[r][c] = null;
        const dest = teleDestination(below, c);
        if (dest && !isSolid(dest.r, dest.c)) {
          bGrid[dest.r][dest.c] = b;
          b.row = dest.r;
          b.col = dest.c;
        } else {
          bGrid[below][c] = b;
          b.row = below;
          b.col = c;
        }
        if (!instant) { b.vrow = r; }
        moved = true;
      }
    }
  });
  return moved;
}

// Match check — find horizontally adjacent groups of same type ≥ 2
function findMatches() {
  const matched = new Set();
  for (let r = 0; r < GROWS; r++) {
    let runType = -1, runStart = -1;
    for (let c = 0; c <= GCOLS; c++) {
      const b = c < GCOLS ? bGrid[r][c] : null;
      const t = b ? b.type : -1;
      if (t === runType && runType !== -1) {
        // still in run
      } else {
        if (runType !== -1 && c - runStart >= 2) {
          for (let k = runStart; k < c; k++) matched.add(bGrid[r][k]);
        }
        runType = t;
        runStart = c;
      }
    }
  }
  // Acid: any block touching acid_s is eliminated (counts as matched)
  for (let r = 0; r < GROWS; r++) {
    for (let c = 0; c < GCOLS; c++) {
      if (tilemap[r][c] === T_ACID_S) {
        // check adjacent blocks
        [[0,1],[0,-1],[1,0],[-1,0]].forEach(([dr,dc]) => {
          const b = bGrid[r+dr]?.[c+dc];
          if (b) matched.add(b);
        });
      }
    }
  }
  return [...matched];
}

// Check laser contact — any block in a laser beam is destroyed → game lost
function checkLaserKill() {
  buildLaserBeams();
  for (const key of laserBeams) {
    const [r, c] = key.split(',').map(Number);
    if (bGrid[r]?.[c]) return true;
  }
  // Killer acid destroys the level when a block touches it.
  for (let r = 0; r < GROWS; r++) {
    for (let c = 0; c < GCOLS; c++) {
      if (tilemap[r][c] !== T_ACID_K) continue;
      if ([[0,1],[0,-1],[1,0],[-1,0]].some(([dr, dc]) => bGrid[r+dr]?.[c+dc])) return true;
    }
  }
  return false;
}

function buildLaserBeams() {
  laserBeams = new Set();
  for (let r = 0; r < GROWS; r++) {
    for (let c = 0; c < GCOLS; c++) {
      if (tilemap[r][c] === T_LASER_H) {
        for (let cc = c + 1; cc < GCOLS; cc++) {
          if (isSolidNoBlock(r, cc)) break;
          laserBeams.add(`${r},${cc}`);
        }
      }
      if (tilemap[r][c] === T_LASER_V) {
        for (let rr = r + 1; rr < GROWS; rr++) {
          if (isSolidNoBlock(rr, c)) break;
          laserBeams.add(`${rr},${c}`);
        }
      }
    }
  }
}

// Full physics resolution (instant mode for level init)
function resolveAllPhysics(instant) {
  for (let i = 0; i < 100; i++) {
    const moved = applyGravity(instant);
    if (!moved) break;
  }
  // snap visual positions
  bList.forEach(b => { b.vrow = b.row; b.vcol = b.col; });
}

// Step physics after a slide animation (animated)
function stepPhysics() {
  pendingPhysics = false;
  // Apply gravity repeatedly until settled
  let moved = false;
  for (let i = 0; i < GROWS; i++) {
    if (applyGravity(false)) moved = true;
    else break;
  }
  if (moved) { phase = 'animating'; startFallAnim(); return; }

  // Check laser kill
  buildLaserBeams();
  if (checkLaserKill()) { onLaserKill(); return; }

  // Find matches
  const matches = findMatches();
  if (matches.length > 0) {
    startElimAnim(matches);
    return;
  }

  // Check hourglass pickup
  for (let r = 0; r < GROWS; r++) {
    for (let c = 0; c < GCOLS; c++) {
      if (tilemap[r][c] === T_HG && bGrid[r][c]) {
        const b = bGrid[r][c];
        tilemap[r][c] = T_EMPTY;
        bGrid[r][c] = null;
        b.alpha = 0;
        bList.splice(bList.indexOf(b), 1);
        activateHourglass();
        pendingPhysics = true;
        return;
      }
    }
  }

  // Stable — check win
  if (bList.filter(b => b.alpha > 0).length === 0) {
    onLevelWon();
  } else {
    phase = 'idle';
    buildLaserBeams();
  }
}

function startFallAnim() {
  fallTimer = 250; // wait for visual drop before next physics check
  phase = 'animating';
}

function startElimAnim(matches) {
  elimBlocks = matches;
  elimT = 0;
  flashOn = true;
  flashTimer = 0;
  phase = 'animating';
}

function finalizeSlide() {
  const b = slideBlock;
  slideBlock = null;
  b.col = slideTo;
  b.vcol = slideTo;
  b.vrow = b.row;
  pendingPhysics = true;
}

function finalizeElim() {
  const pts = elimBlocks.length * elimBlocks.length * 100;
  score += pts;
  if (score > hiScore) { hiScore = score; localStorage.setItem('bd_hi', hiScore); }
  elimBlocks.forEach(b => {
    bGrid[b.row][b.col] = null;
    b.alpha = 0;
  });
  // remove from bList
  bList = bList.filter(b => b.alpha > 0);
  elimBlocks = [];
  elimT = 0;
  pendingPhysics = true;
}

function activateHourglass() {
  gravity = -gravity;
  hgActive = true;
  hgTimer = 15000;
}

function flipGravity() {
  gravity = -gravity;
  hgActive = false;
}

function onLaserKill() {
  if (retries > 0) {
    const remaining = retries - 1;
    clearInterval(timerID);
    startLevel(levelIdx);
    retries = remaining;
  }
  else { phase = 'lost'; clearInterval(timerID); phaseTimer = 3000; }
}

function onLevelWon() {
  clearInterval(timerID);
  const bonus = timeLeft * 10;
  score += bonus;
  if (score > hiScore) { hiScore = score; localStorage.setItem('bd_hi', hiScore); }
  phase = 'levelcomplete';
  phaseTimer = 2500;
}

// ── Input ──────────────────────────────────────────────────────────────────
function onKey(e) {
  if (phase === 'menu') { if (e.code === 'Space' || e.code === 'Enter') startLevel(0); return; }
  if (phase === 'won' || phase === 'lost') return;
  if (e.code === 'Escape') { goMenu(); return; }
  if (e.code === 'KeyR') { retryLevel(); return; }
  if (phase !== 'idle') return;
  switch (e.code) {
    case 'ArrowUp':    moveCursor(-1, 0); e.preventDefault(); break;
    case 'ArrowDown':  moveCursor(1,  0); e.preventDefault(); break;
    case 'ArrowLeft':  moveCursor(0, -1); e.preventDefault(); break;
    case 'ArrowRight': moveCursor(0,  1); e.preventDefault(); break;
    case 'KeyZ': case 'KeyA': tryPush(-1); break;
    case 'KeyX': case 'KeyD': tryPush(1);  break;
  }
}

function moveCursor(dr, dc) {
  const nr = cursor.row + dr, nc = cursor.col + dc;
  if (nr >= 0 && nr < GROWS && nc >= 0 && nc < GCOLS) { cursor.row = nr; cursor.col = nc; }
}

function onCanvasClick(e) {
  if (phase === 'menu') { startLevel(0); return; }
  if (phase !== 'idle') return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const y = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const c = Math.floor(x / CELL);
  const r = Math.floor(y / CELL);
  if (r >= 0 && r < GROWS && c >= 0 && c < GCOLS) { cursor.row = r; cursor.col = c; }
}

function teleDestination(r, c) {
  const tp = teles.find(t =>
    (t.r1 === r && t.c1 === c) || (t.r2 === r && t.c2 === c));
  if (!tp) return null;
  return tp.r1 === r && tp.c1 === c
    ? { r: tp.r2, c: tp.c2 }
    : { r: tp.r1, c: tp.c1 };
}

function tryPush(dir) {
  if (phase !== 'idle') return;
  const r = cursor.row, c = cursor.col;
  const b = bGrid[r][c];
  if (!b) return;

  // Find how far block slides
  let nc = c;
  while (true) {
    const next = nc + dir;
    if (next < 0 || next >= GCOLS) break;
    // A horizontal strike breaks a barrier. The block stops immediately
    // before it, so the newly opened lane can be used on the next push.
    if (tilemap[r][next] === T_BARRIER) {
      tilemap[r][next] = T_EMPTY;
      buildLaserBeams();
      break;
    }
    if (isSolid(r, next)) break;
    // Teleporter check
    const dest = teleDestination(r, next);
    if (dest && !isSolid(dest.r, dest.c)) {
      nc = dest.c;
      // teleport block
      bGrid[r][c] = null;
      bGrid[dest.r][dest.c] = b;
      b.row = dest.r; b.col = dest.c;
      b.vrow = r; b.vcol = c;
      cursor.row = dest.r; cursor.col = dest.c;
      phase = 'animating';
      pendingPhysics = true;
      return;
    }
    nc = next;
  }
  if (nc === c) return; // didn't move

  // Begin slide animation
  bGrid[r][c] = null;
  bGrid[r][nc] = b;
  b.row = r; b.col = nc;
  slideBlock = b;
  slideFrom = c;
  slideTo   = nc;
  slideT    = 0;
  cursor.col = nc;
  phase = 'animating';
}

// ── Rendering ─────────────────────────────────────────────────────────────
const BG = [
  ['#081820','#0d3040','#0a2030'],
  ['#180828','#30084A','#200838'],
  ['#1a0808','#38080a','#200808'],
];

function render() {
  const bg = BG[Math.floor(levelIdx / 10)] || BG[2];
  // Background gradient
  const grd = ctx.createRadialGradient(
    GCOLS*CELL/2, GROWS*CELL/2, 30,
    GCOLS*CELL/2, GROWS*CELL/2, GCOLS*CELL*0.8);
  grd.addColorStop(0, bg[1]);
  grd.addColorStop(1, bg[0]);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (phase === 'menu') { drawOverlay('BLOCK DROP', 'Press SPACE or Click to Play', '#00ffcc'); return; }

  // Draw tilemap
  for (let r = 0; r < GROWS; r++) {
    for (let c = 0; c < GCOLS; c++) {
      const t = tilemap[r][c];
      if (t === T_WALL)    drawWall(c*CELL, r*CELL, CELL);
      else if (t === T_BARRIER) drawBarrier(c*CELL, r*CELL, CELL);
      else if (t === T_LASER_H || t === T_LASER_V) drawLaserSrc(c*CELL, r*CELL, CELL, t);
      else if (t === T_TELE) drawTele(c*CELL, r*CELL, CELL);
      else if (t === T_HG)   drawHG(c*CELL, r*CELL, CELL);
      else if (t === T_ACID_S) drawAcid(c*CELL, r*CELL, CELL, false);
      else if (t === T_ACID_K) drawAcid(c*CELL, r*CELL, CELL, true);
    }
  }

  // Draw laser beams
  ctx.strokeStyle = 'rgba(255,40,40,0.7)';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur  = 8;
  for (const key of laserBeams) {
    const [r, c] = key.split(',').map(Number);
    ctx.beginPath();
    ctx.moveTo(c*CELL+2, r*CELL + CELL/2);
    ctx.lineTo(c*CELL + CELL-2, r*CELL + CELL/2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Draw elevators
  elevs.forEach(e => {
    const x = e.col * CELL, y = e.curRow * CELL;
    ctx.fillStyle = '#6688cc';
    ctx.fillRect(x+2, y + CELL-8, CELL-4, 6);
    ctx.fillStyle = '#99aaff';
    ctx.fillRect(x+2, y + CELL-8, CELL-4, 2);
  });

  // Draw blocks
  bList.forEach(b => {
    if (b.alpha <= 0) return;
    // Smooth fall interpolation
    if (b !== slideBlock) {
      b.vrow += (b.row - b.vrow) * 0.35;
      b.vcol += (b.col - b.vcol) * 0.35;
      if (Math.abs(b.vrow - b.row) < 0.01) b.vrow = b.row;
      if (Math.abs(b.vcol - b.col) < 0.01) b.vcol = b.col;
    } else {
      b.vcol = slideFrom + (slideTo - slideFrom) * easeOut(slideT);
      b.vrow = b.row;
    }

    const x = b.vcol * CELL, y = b.vrow * CELL;
    const isElim = elimBlocks.includes(b);
    if (isElim && !flashOn) return; // blink
    ctx.globalAlpha = b.alpha;
    drawBlock(ctx, x, y, CELL, b.type);
    ctx.globalAlpha = 1;
  });

  // Cursor
  if (phase === 'idle' || phase === 'animating') {
    const x = cursor.col * CELL, y = cursor.row * CELL;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur  = 6;
    ctx.strokeRect(x+2, y+2, CELL-4, CELL-4);
    ctx.shadowBlur = 0;
  }

  // Overlay messages
  if (phase === 'levelcomplete') drawOverlay('LEVEL CLEAR!', `+${timeLeft*10} time bonus`, '#ffff44');
  if (phase === 'won')  drawOverlay('YOU WIN!', `Final Score: ${score}`, '#00ff88');
  if (phase === 'lost') drawOverlay('GAME OVER', `Score: ${score}`, '#ff4444');
}

function easeOut(t) { return 1 - (1-t)*(1-t); }

function drawOverlay(title, sub, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 52px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.shadowColor = color;
  ctx.shadowBlur  = 16;
  ctx.fillText(title, canvas.width/2, canvas.height/2 - 20);
  ctx.shadowBlur = 0;
  ctx.font = '22px monospace';
  ctx.fillStyle = '#cccccc';
  ctx.fillText(sub, canvas.width/2, canvas.height/2 + 30);
  ctx.textAlign = 'left';
}

// ── Tile drawing ───────────────────────────────────────────────────────────
function drawWall(x, y, s) {
  ctx.fillStyle = '#7a7a8a';
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = '#aaaabc';
  ctx.fillRect(x, y, s, 4);
  ctx.fillRect(x, y, 4, s);
  ctx.fillStyle = '#444450';
  ctx.fillRect(x, y+s-4, s, 4);
  ctx.fillRect(x+s-4, y, 4, s);
  // X mark
  ctx.strokeStyle = '#55556a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x+6, y+6); ctx.lineTo(x+s-6, y+s-6);
  ctx.moveTo(x+s-6, y+6); ctx.lineTo(x+6, y+s-6);
  ctx.stroke();
}

function drawBarrier(x, y, s) {
  ctx.fillStyle = '#664422';
  ctx.fillRect(x, y+s-10, s, 10);
  ctx.fillStyle = '#aa6633';
  ctx.fillRect(x, y+s-10, s, 3);
  // crack marks
  ctx.strokeStyle = '#332211';
  ctx.lineWidth = 1;
  for (let i = 4; i < s; i += 10) {
    ctx.beginPath();
    ctx.moveTo(x+i, y+s-10);
    ctx.lineTo(x+i+4, y+s);
    ctx.stroke();
  }
}

function drawLaserSrc(x, y, s, type) {
  ctx.fillStyle = '#330000';
  ctx.fillRect(x+4, y+4, s-8, s-8);
  ctx.fillStyle = '#ff2200';
  ctx.fillRect(x+s/2-3, y+s/2-3, 6, 6);
  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 2;
  ctx.strokeRect(x+4, y+4, s-8, s-8);
}

function drawTele(x, y, s) {
  ctx.fillStyle = '#001a33';
  ctx.fillRect(x+3, y+3, s-6, s-6);
  ctx.strokeStyle = '#00aaff';
  ctx.lineWidth = 2;
  ctx.strokeRect(x+3, y+3, s-6, s-6);
  ctx.fillStyle = '#0055aa';
  ctx.beginPath();
  ctx.arc(x+s/2, y+s/2, s/2-8, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = '#00ccff';
  ctx.font = `bold ${s*0.4}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('T', x+s/2, y+s/2+s*0.14);
  ctx.textAlign = 'left';
}

function drawHG(x, y, s) {
  ctx.fillStyle = '#1a0e00';
  ctx.fillRect(x+3, y+3, s-6, s-6);
  ctx.fillStyle = '#ffaa00';
  ctx.font = `${s*0.5}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('⌛', x+s/2, y+s/2+s*0.18);
  ctx.textAlign = 'left';
}

function drawAcid(x, y, s, deadly) {
  const col = deadly ? '#440000' : '#003300';
  const wave = deadly ? '#ff0000' : '#00cc00';
  ctx.fillStyle = col;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = wave;
  const t = Date.now() / 400;
  for (let i = 0; i < s; i += 4) {
    const h = 4 + Math.sin(t + i*0.3) * 3;
    ctx.fillRect(x+i, y+s-h-2, 3, h);
  }
}

// ── Block drawing ──────────────────────────────────────────────────────────
function drawBlock(ctx, x, y, s, type) {
  const p = 2;
  switch (type) {
    case 1: { // Green vertical stripes
      ctx.fillStyle = '#005500';
      ctx.fillRect(x+p, y+p, s-p*2, s-p*2);
      ctx.fillStyle = '#00cc44';
      for (let i = 5; i < s-p; i += 7) ctx.fillRect(x+i, y+p+2, 4, s-p*2-4);
      ctx.strokeStyle = '#003300'; ctx.lineWidth=2;
      ctx.strokeRect(x+p, y+p, s-p*2, s-p*2);
      break;
    }
    case 2: { // Blue grid mesh
      ctx.fillStyle = '#000055';
      ctx.fillRect(x+p, y+p, s-p*2, s-p*2);
      ctx.strokeStyle = '#3366ff'; ctx.lineWidth=1;
      for (let i = 6; i < s-p*2; i += 7) {
        ctx.beginPath(); ctx.moveTo(x+p+i, y+p+2); ctx.lineTo(x+p+i, y+s-p-2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x+p+2, y+p+i); ctx.lineTo(x+s-p-2, y+p+i); ctx.stroke();
      }
      ctx.strokeStyle = '#2244aa'; ctx.lineWidth=2;
      ctx.strokeRect(x+p, y+p, s-p*2, s-p*2);
      break;
    }
    case 3: { // Magenta triangle
      ctx.fillStyle = '#220022';
      ctx.fillRect(x+p, y+p, s-p*2, s-p*2);
      ctx.fillStyle = '#dd00cc';
      ctx.beginPath();
      ctx.moveTo(x+s/2, y+p+4);
      ctx.lineTo(x+s-p-4, y+s-p-4);
      ctx.lineTo(x+p+4, y+s-p-4);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#880066'; ctx.lineWidth=2;
      ctx.strokeRect(x+p, y+p, s-p*2, s-p*2);
      break;
    }
    case 4: { // Yellow diamond
      ctx.fillStyle = '#222200';
      ctx.fillRect(x+p, y+p, s-p*2, s-p*2);
      const cx=x+s/2, cy=y+s/2, r=s/2-7;
      ctx.fillStyle = '#ffcc00';
      ctx.beginPath();
      ctx.moveTo(cx, cy-r); ctx.lineTo(cx+r, cy);
      ctx.lineTo(cx, cy+r); ctx.lineTo(cx-r, cy);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#886600'; ctx.lineWidth=2;
      ctx.strokeRect(x+p, y+p, s-p*2, s-p*2);
      break;
    }
    case 5: { // Orange sphere
      ctx.fillStyle = '#221100';
      ctx.fillRect(x+p, y+p, s-p*2, s-p*2);
      const cx=x+s/2, cy=y+s/2, r=s/2-7;
      const grd = ctx.createRadialGradient(cx-r*.3, cy-r*.3, r*.1, cx, cy, r);
      grd.addColorStop(0, '#ffcc44');
      grd.addColorStop(1, '#cc4400');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#662200'; ctx.lineWidth=2;
      ctx.strokeRect(x+p, y+p, s-p*2, s-p*2);
      break;
    }
    case 6: { // Silver star
      ctx.fillStyle = '#111122';
      ctx.fillRect(x+p, y+p, s-p*2, s-p*2);
      const cx=x+s/2, cy=y+s/2, or=s/2-7, ir=or*.4;
      ctx.fillStyle = '#ccccdd';
      ctx.beginPath();
      for (let i=0; i<10; i++) {
        const a = (i*Math.PI/5) - Math.PI/2;
        const rr = i%2===0 ? or : ir;
        if (i===0) ctx.moveTo(cx+rr*Math.cos(a), cy+rr*Math.sin(a));
        else ctx.lineTo(cx+rr*Math.cos(a), cy+rr*Math.sin(a));
      }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#556677'; ctx.lineWidth=2;
      ctx.strokeRect(x+p, y+p, s-p*2, s-p*2);
      break;
    }
  }
}

// ── HUD update (DOM-based top bar) ────────────────────────────────────────
const BLOCK_COLORS = ['','#00cc44','#3366ff','#dd00cc','#ffcc00','#ff6600','#aaaacc'];

function updateHUD() {
  if (phase === 'menu') return;
  const lvl = LEVELS[levelIdx] || LEVELS[0];

  const el = id => document.getElementById(id);
  const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };

  set('h-score', score.toString().padStart(6,'0'));
  set('h-hi',    hiScore.toString().padStart(6,'0'));
  set('h-level', levelIdx + 1);
  set('h-stage', lvl.name || '');

  const t = timeLeft;
  const timeEl = el('h-time');
  if (timeEl) {
    timeEl.textContent = Math.floor(t/60) + "'" + String(t%60).padStart(2,'0');
    timeEl.style.color = t <= 10 ? '#ff4444' : '';
  }
  set('h-retry', retries);

  const counts = {};
  bList.forEach(b => { if (b.alpha > 0) counts[b.type] = (counts[b.type]||0)+1; });
  const remEl = el('h-remaining');
  if (remEl) {
    remEl.innerHTML = Object.entries(counts).map(([t,n]) =>
      `<span class="rem-dot" style="background:${BLOCK_COLORS[t]}"></span><span class="rem-n">${n}</span>`
    ).join('');
  }
}
