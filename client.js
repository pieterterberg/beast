const {
  CELL_PX: CELL,
  BASE_COLS,
  BASE_ROWS,
  TILE,
  HEARTBEAT_MS,
  PLAYER_TIMEOUT_MS,
} = window.BEAST_CONSTANTS;

const EMPTY = TILE.EMPTY;
const WALL = TILE.WALL;
const BLOCK = TILE.BLOCK;

const GLYPHS = ['H','X','Y','Z','★','◆','●','▲','♥','♣','♠','☼','Δ','Ω','Φ','Ψ','§','π','µ','∞','Ж','♪','¥','&'];
const COLORS = ['#6dff8a','#ff4040','#5ac8ff','#ffb000','#c879ff','#ff79c6','#50fa7b','#f1fa8c','#ff9500','#a0f0ff'];

let myId = null;
let myGlyph = null;
let myColor = null;
let myAlive = false;
let state = null;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let heartbeatTimer = null;
let lastServerSeen = 0;
let moveSeq = 0;
const pendingMoves = new Map();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

function updateJoinError(message = '') {
  const errorEl = document.getElementById('joinError');
  errorEl.textContent = message;
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function safeColor(value) {
  if (typeof value !== 'string') return '#6dff8a';
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#6dff8a';
}

function worldFromSnapshot(snapshot) {
  const players = Object.create(null);
  const fromPlayers = snapshot && snapshot.players && typeof snapshot.players === 'object' ? snapshot.players : {};
  for (const [id, p] of Object.entries(fromPlayers)) {
    if (!isSafeId(id) || !p || typeof p !== 'object') continue;
    players[id] = {
      id,
      glyph: typeof p.glyph === 'string' ? p.glyph : '?',
      color: safeColor(p.color),
      x: Number.isInteger(p.x) ? p.x : 0,
      y: Number.isInteger(p.y) ? p.y : 0,
      alive: !!p.alive,
    };
  }

  const beasts = Array.isArray(snapshot && snapshot.beasts)
    ? snapshot.beasts
      .filter((b) => b && isSafeId(b.id) && Number.isInteger(b.x) && Number.isInteger(b.y))
      .map((b) => ({ id: b.id, x: b.x, y: b.y }))
    : [];

  return {
    grid: Array.isArray(snapshot && snapshot.grid) ? snapshot.grid : [],
    players,
    beasts,
    level: Number.isInteger(snapshot && snapshot.level) ? snapshot.level : 1,
    tick: Number.isInteger(snapshot && snapshot.tick) ? snapshot.tick : 0,
  };
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}`);

  ws.addEventListener('open', () => {
    lastServerSeen = Date.now();
    reconnectDelay = 1000;
    updateJoinError('');
    if (myGlyph) {
      ws.send(JSON.stringify({ t: 'join', glyph: myGlyph, color: myColor }));
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      if (Date.now() - lastServerSeen > PLAYER_TIMEOUT_MS) {
        ws.close();
      }
    }, HEARTBEAT_MS);
  });

  ws.addEventListener('message', (ev) => {
    lastServerSeen = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.t === 'welcome') {
      myId = msg.you;
      state = worldFromSnapshot(msg.world);
      myAlive = !!(state.players[myId] && state.players[myId].alive);
      showGame();
      updateHUD();
      if (!rafId) startRenderLoop();
      return;
    }

    if (msg.t === 'snapshot') {
      state = worldFromSnapshot(msg.world);
      myAlive = !!(state.players[myId] && state.players[myId].alive);
      updateHUD();
      if (!myAlive && myId) showDeath();
      return;
    }

    if (msg.t === 'delta' && state) {
      for (const c of msg.changes || []) {
        if (!c) continue;
        const x = Number(c.x);
        const y = Number(c.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        if (String(x) !== String(c.x) || String(y) !== String(c.y)) continue;
        if (y < 0 || y >= state.grid.length) continue;
        const row = state.grid[y];
        if (!Array.isArray(row) || x < 0 || x >= row.length) continue;
        row[x] = c.v;
      }
      for (const p of msg.players || []) {
        if (!p || !isSafeId(p.id)) continue;
        if (p.removed) {
          delete state.players[p.id];
        } else {
          const prev = state.players[p.id] || {};
          state.players[p.id] = {
            ...prev,
            ...p,
            glyph: p.glyph || prev.glyph,
            color: safeColor(p.color || prev.color),
          };
        }
      }
      for (const b of msg.beasts || []) {
        const idx = state.beasts.findIndex((x) => x.id === b.id);
        if (b.removed) {
          if (idx >= 0) state.beasts.splice(idx, 1);
        } else if (idx >= 0) {
          state.beasts[idx] = b;
        } else {
          state.beasts.push(b);
        }
      }
      if (Number.isInteger(msg.level) && msg.level > 0) state.level = msg.level;
      if (typeof msg.tick === 'number') state.tick = msg.tick;
      updateHUD();
      const me = state.players[myId];
      if (me && !me.alive && myAlive) {
        myAlive = false;
        showDeath();
      }
      return;
    }

    if (msg.t === 'move_ack' && state && myId) {
      pendingMoves.delete(msg.seq);
      const me = state.players[myId];
      const ackX = Number(msg.x);
      const ackY = Number(msg.y);
      if (me && Number.isFinite(ackX) && Number.isFinite(ackY) && (me.x !== ackX || me.y !== ackY)) {
        me.x = ackX;
        me.y = ackY;
      }
      return;
    }

    if (msg.t === 'you_died') {
      myAlive = false;
      showDeath();
      return;
    }

    if (msg.t === 'error') {
      updateJoinError(msg.message || 'Failed to join.');
    }
  });

  ws.addEventListener('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    ws = null;
    if (myGlyph) {
      const delay = reconnectDelay;
      reconnectDelay = Math.min(10000, reconnectDelay * 2);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
      updateJoinError(`Disconnected. Reconnecting in ${Math.round(delay / 1000)}s...`);
    }
  });
}

function showGame() {
  document.getElementById('joinOverlay').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('controls').classList.remove('hidden');
  document.getElementById('playerList').classList.remove('hidden');
}

function showDeath() {
  document.getElementById('deathOverlay').classList.remove('hidden');
}

function applyMove(localState, playerId, dx, dy) {
  const player = localState.players[playerId];
  if (!player || !player.alive) return false;
  if (!Array.isArray(localState.grid) || localState.grid.length === 0 || !Array.isArray(localState.grid[0])) return false;
  const cols = localState.grid[0].length;
  const rows = localState.grid.length;
  const nx = player.x + dx;
  const ny = player.y + dy;
  if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return false;

  const tile = localState.grid[ny][nx];
  const beastAt = localState.beasts.find((b) => b.x === nx && b.y === ny);
  const playerAt = Object.values(localState.players).find((p) => p.id !== playerId && p.alive && p.x === nx && p.y === ny);

  if (beastAt) {
    player.alive = false;
    return true;
  }
  if (playerAt) return false;

  if (tile === EMPTY) {
    player.x = nx;
    player.y = ny;
    return true;
  }
  if (tile === WALL) return false;

  if (tile === BLOCK) {
    let ex = nx;
    let ey = ny;
    while (true) {
      const cx = ex + dx;
      const cy = ey + dy;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
      const next = localState.grid[cy][cx];
      const beastBeyond = localState.beasts.find((b) => b.x === cx && b.y === cy);
      const playerBeyond = Object.values(localState.players).find((p) => p.alive && p.x === cx && p.y === cy);

      if (next === EMPTY && !beastBeyond && !playerBeyond) {
        localState.grid[cy][cx] = BLOCK;
        localState.grid[ny][nx] = EMPTY;
        player.x = nx;
        player.y = ny;
        return true;
      }
      if (next === BLOCK) {
        ex = cx;
        ey = cy;
        continue;
      }
      if (beastBeyond) {
        const bx = cx + dx;
        const by = cy + dy;
        let crush = false;
        if (bx < 0 || by < 0 || bx >= cols || by >= rows) crush = true;
        else {
          const beyond = localState.grid[by][bx];
          const beastBehind = localState.beasts.find((b) => b.x === bx && b.y === by);
          const playerBehind = Object.values(localState.players).find((p) => p.alive && p.x === bx && p.y === by);
          if (beyond === WALL || beyond === BLOCK || beastBehind || playerBehind) crush = true;
        }
        if (!crush) return false;
        localState.beasts = localState.beasts.filter((b) => !(b.x === cx && b.y === cy));
        localState.grid[cy][cx] = BLOCK;
        localState.grid[ny][nx] = EMPTY;
        player.x = nx;
        player.y = ny;
        return true;
      }
      return false;
    }
  }
  return false;
}

function tryMove(dx, dy) {
  if (!state || !myId || !state.players[myId] || !state.players[myId].alive) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const seq = ++moveSeq;
  if (applyMove(state, myId, dx, dy)) {
    pendingMoves.set(seq, { dx, dy });
  }
  ws.send(JSON.stringify({ t: 'move', dx, dy, seq }));
}

const keyMap = {
  ArrowUp:[0,-1], w:[0,-1], W:[0,-1], k:[0,-1],
  ArrowDown:[0,1], s:[0,1], S:[0,1], j:[0,1],
  ArrowLeft:[-1,0], a:[-1,0], A:[-1,0], h:[-1,0],
  ArrowRight:[1,0], d:[1,0], D:[1,0], l:[1,0],
};
document.addEventListener('keydown', (e) => {
  const m = keyMap[e.key];
  if (m) {
    e.preventDefault();
    tryMove(m[0], m[1]);
  }
});

const dirMap = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
document.querySelectorAll('.btn[data-dir]').forEach((btn) => {
  let t;
  const fire = () => tryMove(...dirMap[btn.dataset.dir]);
  const start = (e) => {
    e.preventDefault();
    fire();
    clearInterval(t);
    t = setInterval(fire, 170);
  };
  const stop = () => clearInterval(t);
  btn.addEventListener('touchstart', start, { passive: false });
  btn.addEventListener('touchend', stop);
  btn.addEventListener('touchcancel', stop);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
});

let selectedGlyph = null;
let selectedColor = COLORS[0];

function renderGlyphPicker() {
  const c = document.getElementById('glyphPicker');
  c.innerHTML = '';
  GLYPHS.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'glyph-btn';
    b.textContent = g;
    if (g === selectedGlyph) b.classList.add('selected');
    b.onclick = () => {
      selectedGlyph = g;
      renderGlyphPicker();
      document.getElementById('joinBtn').disabled = false;
    };
    c.appendChild(b);
  });
}

function renderColorPicker() {
  const c = document.getElementById('colorPicker');
  c.innerHTML = '';
  COLORS.forEach((col) => {
    const b = document.createElement('button');
    b.className = 'color-btn';
    b.style.background = col;
    if (col === selectedColor) b.classList.add('selected');
    b.onclick = () => {
      selectedColor = col;
      renderColorPicker();
    };
    c.appendChild(b);
  });
}

function updateHUD() {
  if (!state) return;
  document.getElementById('level').textContent = state.level || 1;
  document.getElementById('beasts').textContent = state.beasts.length;
  const alive = Object.values(state.players).filter((p) => p.alive);
  document.getElementById('players').textContent = alive.length;
  const list = document.getElementById('playerList');
  list.innerHTML = '';
  for (const p of alive) {
    const span = document.createElement('span');
    const color = safeColor(p.color);
    span.style.color = color;
    if (p.id === myId) span.style.textShadow = `0 0 4px ${color}`;
    span.textContent = typeof p.glyph === 'string' ? p.glyph : '?';
    list.appendChild(span);
  }
}

let cameraX = 0;
let cameraY = 0;

function drawTile(v, px, py) {
  if (v === WALL) {
    ctx.fillStyle = '#5ac8ff';
    ctx.fillRect(px, py, CELL, CELL);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (let dy = 0; dy < CELL; dy += 4) {
      const offset = (Math.floor(dy / 4) % 2 === 0) ? 0 : 2;
      for (let dx = offset; dx < CELL; dx += 4) {
        ctx.fillRect(px + dx, py + dy, 2, 2);
      }
    }
  } else if (v === BLOCK) {
    ctx.fillStyle = '#7a7a7a';
    ctx.fillRect(px, py, CELL, CELL);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let dy = 0; dy < CELL; dy += 3) {
      const offset = (Math.floor(dy / 3) % 2 === 0) ? 0 : 1;
      for (let dx = offset; dx < CELL; dx += 3) {
        ctx.fillRect(px + dx, py + dy, 1, 1);
      }
    }
  }
}

function render() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!state) return;

  const grid = state.grid;
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) return;
  const cols = grid[0].length;
  const rows = grid.length;
  const me = state.players[myId];
  const targetX = me ? me.x : cols / 2;
  const targetY = me ? me.y : rows / 2;
  cameraX = targetX * CELL - w / 2 + CELL / 2;
  cameraY = targetY * CELL - h / 2 + CELL / 2;

  const sx = Math.max(0, Math.floor(cameraX / CELL));
  const sy = Math.max(0, Math.floor(cameraY / CELL));
  const ex = Math.min(cols, Math.ceil((cameraX + w) / CELL) + 1);
  const ey = Math.min(rows, Math.ceil((cameraY + h) / CELL) + 1);

  for (let y = sy; y < ey; y++) {
    for (let x = sx; x < ex; x++) {
      const v = grid[y][x];
      if (v === EMPTY) continue;
      const px = Math.round(x * CELL - cameraX);
      const py = Math.round(y * CELL - cameraY);
      drawTile(v, px, py);
    }
  }

  ctx.font = `${CELL - 2}px VT323, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff4040';
  for (const b of state.beasts) {
    if (b.x < sx - 1 || b.x > ex || b.y < sy - 1 || b.y > ey) continue;
    const px = Math.round(b.x * CELL - cameraX);
    const py = Math.round(b.y * CELL - cameraY);
    ctx.fillText('♦', px + CELL / 2, py + CELL / 2 + 1);
  }

  ctx.font = `bold ${CELL - 4}px VT323, monospace`;
  for (const id in state.players) {
    const p = state.players[id];
    if (p.x < sx - 1 || p.x > ex || p.y < sy - 1 || p.y > ey) continue;
    const px = Math.round(p.x * CELL - cameraX);
    const py = Math.round(p.y * CELL - cameraY);
    ctx.fillStyle = p.alive ? p.color : 'rgba(120,120,120,0.5)';
    ctx.fillText(p.glyph, px + CELL / 2, py + CELL / 2 + 1);
    if (id === myId && p.alive) {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
    }
  }
}

let rafId = null;
function startRenderLoop() {
  const loop = () => {
    render();
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

function doJoin() {
  if (!selectedGlyph) return;
  myGlyph = selectedGlyph;
  myColor = selectedColor;
  myAlive = true;
  updateJoinError('Connecting...');
  connect();
}

document.getElementById('joinBtn').addEventListener('click', doJoin);

document.getElementById('rejoinBtn').addEventListener('click', () => {
  document.getElementById('deathOverlay').classList.add('hidden');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'join', glyph: myGlyph, color: myColor }));
    return;
  }
  connect();
});

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'leave' }));
  }
});

renderGlyphPicker();
renderColorPicker();
