const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const C = require('./shared/constants');

const {
  BASE_COLS,
  BASE_ROWS,
  PER_PLAYER_COLS,
  PER_PLAYER_ROWS,
  MAX_COLS,
  MAX_ROWS,
  TILE,
  WALL_DENSITY,
  BLOCK_DENSITY,
  BEAST_BASE,
  BEAST_PER_PLAYER,
  BEAST_TICK_MIN_MS,
  BEAST_TICK_MAX_MS,
  PLAYER_MOVE_COOLDOWN_MS,
  HEARTBEAT_MS,
  PLAYER_TIMEOUT_MS,
  DEATH_LINGER_MS,
} = C;

const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();

const clients = new Set();

const world = {
  cols: BASE_COLS,
  rows: BASE_ROWS,
  grid: null,
  players: new Map(),
  beasts: new Map(),
  tick: 0,
  nextPlayerId: 1,
  nextBeastId: 1,
  lastBeastTick: Date.now(),
  lastSnapshotAt: 0,
  lastCleanupAt: 0,
};

world.grid = makeGrid(world.cols, world.rows);

const pending = {
  cells: new Map(),
  players: new Map(),
  beasts: new Map(),
};

function cellIndex(x, y) {
  return y * world.cols + x;
}

function getCell(x, y) {
  return world.grid[cellIndex(x, y)];
}

function setCell(x, y, v) {
  world.grid[cellIndex(x, y)] = v;
  pending.cells.set(`${x},${y}`, { x, y, v });
}

function desiredSize(playerCount) {
  return {
    cols: Math.min(MAX_COLS, BASE_COLS + Math.max(0, playerCount - 1) * PER_PLAYER_COLS),
    rows: Math.min(MAX_ROWS, BASE_ROWS + Math.max(0, playerCount - 1) * PER_PLAYER_ROWS),
  };
}

function desiredBeasts(playerCount) {
  return BEAST_BASE + playerCount * BEAST_PER_PLAYER;
}

function alivePlayers() {
  return [...world.players.values()].filter((p) => p.alive);
}

function connectedPlayers() {
  return [...world.players.values()].filter((p) => p.connected && p.alive);
}

function makeGrid(cols, rows) {
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const idx = y * cols + x;
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) {
        grid[idx] = TILE.WALL;
      }
    }
  }

  const wallCount = Math.floor(cols * rows * WALL_DENSITY);
  for (let i = 0; i < wallCount; i++) {
    const x = 2 + Math.floor(Math.random() * Math.max(1, cols - 4));
    const y = 2 + Math.floor(Math.random() * Math.max(1, rows - 4));
    grid[y * cols + x] = TILE.WALL;
  }

  const blockCount = Math.floor((cols - 2) * (rows - 2) * BLOCK_DENSITY);
  let placed = 0;
  let tries = 0;
  while (placed < blockCount && tries < 10000) {
    tries += 1;
    const x = 1 + Math.floor(Math.random() * Math.max(1, cols - 2));
    const y = 1 + Math.floor(Math.random() * Math.max(1, rows - 2));
    const idx = y * cols + x;
    if (grid[idx] === TILE.EMPTY) {
      grid[idx] = TILE.BLOCK;
      placed += 1;
    }
  }
  return grid;
}

function markPlayer(player) {
  pending.players.set(player.id, {
    id: player.id,
    x: player.x,
    y: player.y,
    alive: player.alive,
    glyph: player.glyph,
    color: player.color,
  });
}

function markPlayerRemoved(id) {
  pending.players.set(id, { id, removed: true });
}

function markBeast(beast) {
  pending.beasts.set(beast.id, {
    id: beast.id,
    x: beast.x,
    y: beast.y,
  });
}

function markBeastRemoved(id) {
  pending.beasts.set(id, { id, removed: true });
}

function findEmptyCell() {
  for (let i = 0; i < 2000; i++) {
    const x = 2 + Math.floor(Math.random() * Math.max(1, world.cols - 4));
    const y = 2 + Math.floor(Math.random() * Math.max(1, world.rows - 4));
    if (getCell(x, y) === TILE.WALL) continue;
    if ([...world.beasts.values()].some((b) => b.x === x && b.y === y)) continue;
    if ([...world.players.values()].some((p) => p.alive && p.x === x && p.y === y)) continue;
    setCell(x, y, TILE.EMPTY);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx > 0 && ty > 0 && tx < world.cols - 1 && ty < world.rows - 1 && getCell(tx, ty) === TILE.BLOCK) {
        setCell(tx, ty, TILE.EMPTY);
      }
    }
    return { x, y };
  }
  return { x: 1, y: 1 };
}

function spawnBeast() {
  for (let i = 0; i < 3000; i++) {
    const x = 1 + Math.floor(Math.random() * Math.max(1, world.cols - 2));
    const y = 1 + Math.floor(Math.random() * Math.max(1, world.rows - 2));
    if (getCell(x, y) !== TILE.EMPTY) continue;
    if ([...world.beasts.values()].some((b) => b.x === x && b.y === y)) continue;
    const near = [...world.players.values()].some((p) => p.alive && Math.abs(p.x - x) + Math.abs(p.y - y) < 8);
    if (near) continue;
    const beast = { id: `b${world.nextBeastId++}`, x, y };
    world.beasts.set(beast.id, beast);
    markBeast(beast);
    return true;
  }
  return false;
}

function respawnBlocks(cx, cy, count) {
  let placed = 0;
  let tries = 0;
  while (placed < count && tries < 500) {
    tries += 1;
    const x = Math.max(1, Math.min(world.cols - 2, cx + Math.floor((Math.random() - 0.5) * 14)));
    const y = Math.max(1, Math.min(world.rows - 2, cy + Math.floor((Math.random() - 0.5) * 14)));
    if (getCell(x, y) !== TILE.EMPTY) continue;
    if ([...world.beasts.values()].some((b) => b.x === x && b.y === y)) continue;
    if ([...world.players.values()].some((p) => p.alive && p.x === x && p.y === y)) continue;
    setCell(x, y, TILE.BLOCK);
    placed += 1;
  }
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function buildSnapshot() {
  const grid = [];
  for (let y = 0; y < world.rows; y++) {
    const row = [];
    for (let x = 0; x < world.cols; x++) {
      row.push(getCell(x, y));
    }
    grid.push(row);
  }

  const players = {};
  for (const [id, p] of world.players.entries()) {
    players[id] = {
      id,
      glyph: p.glyph,
      color: p.color,
      x: p.x,
      y: p.y,
      alive: p.alive,
    };
  }

  const beasts = [...world.beasts.values()].map((b) => ({ id: b.id, x: b.x, y: b.y }));
  return {
    cols: world.cols,
    rows: world.rows,
    grid,
    players,
    beasts,
    tick: world.tick,
  };
}

function flushDeltas() {
  if (!pending.cells.size && !pending.players.size && !pending.beasts.size) return;
  broadcast({
    t: 'delta',
    changes: [...pending.cells.values()],
    players: [...pending.players.values()],
    beasts: [...pending.beasts.values()],
    tick: world.tick,
  });
  pending.cells.clear();
  pending.players.clear();
  pending.beasts.clear();
}

function clearPending() {
  pending.cells.clear();
  pending.players.clear();
  pending.beasts.clear();
}

function resizeWorld(newCols, newRows) {
  const oldCols = world.cols;
  const oldRows = world.rows;
  if (newCols === oldCols && newRows === oldRows) return;

  const grow = newCols >= oldCols && newRows >= oldRows;
  let offsetX = 0;
  let offsetY = 0;

  if (grow) {
    offsetX = Math.floor((newCols - oldCols) / 2);
    offsetY = Math.floor((newRows - oldRows) / 2);
    const newGrid = makeGrid(newCols, newRows);
    for (let y = 1; y < oldRows - 1; y++) {
      for (let x = 1; x < oldCols - 1; x++) {
        newGrid[(y + offsetY) * newCols + (x + offsetX)] = world.grid[y * oldCols + x];
      }
    }
    world.cols = newCols;
    world.rows = newRows;
    world.grid = newGrid;
    for (const player of world.players.values()) {
      player.x += offsetX;
      player.y += offsetY;
      markPlayer(player);
    }
    for (const beast of world.beasts.values()) {
      beast.x += offsetX;
      beast.y += offsetY;
      markBeast(beast);
    }
  } else {
    world.cols = newCols;
    world.rows = newRows;
    world.grid = makeGrid(newCols, newRows);
    for (const player of world.players.values()) {
      const pos = findEmptyCell();
      player.x = pos.x;
      player.y = pos.y;
      markPlayer(player);
    }
    world.beasts.clear();
    const target = desiredBeasts(Math.max(1, alivePlayers().length));
    for (let i = 0; i < target; i++) spawnBeast();
  }

  clearPending();
  broadcast({ t: 'world_resized', cols: world.cols, rows: world.rows, offsetX, offsetY });
  broadcast({ t: 'snapshot', world: buildSnapshot() });
}

function beastAt(x, y, exceptId = null) {
  for (const beast of world.beasts.values()) {
    if (beast.id !== exceptId && beast.x === x && beast.y === y) return beast;
  }
  return null;
}

function playerAt(x, y, exceptId = null) {
  for (const player of world.players.values()) {
    if (player.id !== exceptId && player.alive && player.x === x && player.y === y) return player;
  }
  return null;
}

function killPlayer(player, killer) {
  if (!player.alive) return;
  player.alive = false;
  player.deathTime = Date.now();
  markPlayer(player);
  if (player.ws && player.ws.readyState === 1) {
    send(player.ws, { t: 'you_died', killer, respawnIn: DEATH_LINGER_MS });
  }
}

function disconnectPlayer(player) {
  if (!player) return;
  player.connected = false;
  player.ws = null;
  if (player.alive) {
    player.alive = false;
    player.deathTime = Date.now();
    markPlayer(player);
  }
}

function applyMove(player, dx, dy) {
  const nx = player.x + dx;
  const ny = player.y + dy;
  if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) return false;

  const tile = getCell(nx, ny);
  const beast = beastAt(nx, ny);
  const otherPlayer = playerAt(nx, ny, player.id);

  if (beast) {
    killPlayer(player, 'beast');
    return true;
  }
  if (otherPlayer) return false;

  if (tile === TILE.EMPTY) {
    player.x = nx;
    player.y = ny;
    markPlayer(player);
    return true;
  }
  if (tile === TILE.WALL) return false;

  if (tile === TILE.BLOCK) {
    let ex = nx;
    let ey = ny;
    while (true) {
      const cx = ex + dx;
      const cy = ey + dy;
      if (cx < 0 || cy < 0 || cx >= world.cols || cy >= world.rows) return false;

      const next = getCell(cx, cy);
      const beastBeyond = beastAt(cx, cy);
      const playerBeyond = playerAt(cx, cy);

      if (next === TILE.EMPTY && !beastBeyond && !playerBeyond) {
        setCell(cx, cy, TILE.BLOCK);
        setCell(nx, ny, TILE.EMPTY);
        player.x = nx;
        player.y = ny;
        markPlayer(player);
        return true;
      }

      if (next === TILE.BLOCK) {
        ex = cx;
        ey = cy;
        continue;
      }

      if (beastBeyond) {
        const bx = cx + dx;
        const by = cy + dy;
        let crush = false;
        if (bx < 0 || by < 0 || bx >= world.cols || by >= world.rows) {
          crush = true;
        } else {
          const beyond = getCell(bx, by);
          const beastBehind = beastAt(bx, by);
          const playerBehind = playerAt(bx, by);
          if (beyond === TILE.WALL || beyond === TILE.BLOCK || beastBehind || playerBehind) crush = true;
        }
        if (!crush) return false;
        world.beasts.delete(beastBeyond.id);
        markBeastRemoved(beastBeyond.id);
        setCell(cx, cy, TILE.BLOCK);
        setCell(nx, ny, TILE.EMPTY);
        player.x = nx;
        player.y = ny;
        markPlayer(player);
        return true;
      }

      return false;
    }
  }
  return false;
}

function moveBeast(beast) {
  const players = alivePlayers();
  if (!players.length) return;

  let nearest = null;
  let minDist = Infinity;
  for (const p of players) {
    const d = Math.abs(p.x - beast.x) + Math.abs(p.y - beast.y);
    if (d < minDist) {
      minDist = d;
      nearest = p;
    }
  }
  if (!nearest) return;

  const dx = Math.sign(nearest.x - beast.x);
  const dy = Math.sign(nearest.y - beast.y);
  const adx = Math.abs(nearest.x - beast.x);
  const ady = Math.abs(nearest.y - beast.y);
  const tries = adx > ady
    ? [[dx, 0], [0, dy], [dx, dy], [0, dy || 1], [dx || 1, 0]]
    : [[0, dy], [dx, 0], [dx, dy], [dx || 1, 0], [0, dy || 1]];

  for (const [mx, my] of tries) {
    if (mx === 0 && my === 0) continue;
    const nx = beast.x + mx;
    const ny = beast.y + my;
    if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
    if (getCell(nx, ny) !== TILE.EMPTY) continue;
    if (beastAt(nx, ny, beast.id)) continue;
    const pAt = playerAt(nx, ny);
    if (pAt) {
      killPlayer(pAt, 'beast');
      beast.x = nx;
      beast.y = ny;
      markBeast(beast);
      return;
    }
    beast.x = nx;
    beast.y = ny;
    markBeast(beast);
    return;
  }
}

function cleanupPlayers(now) {
  for (const player of [...world.players.values()]) {
    const stale = now - player.lastSeen > PLAYER_TIMEOUT_MS;
    if (stale && player.alive) {
      disconnectPlayer(player);
    }

    if (!player.alive && player.deathTime && now - player.deathTime > DEATH_LINGER_MS) {
      respawnBlocks(player.x, player.y, 10);
      world.players.delete(player.id);
      markPlayerRemoved(player.id);
    }
  }

  const aliveCount = Math.max(1, alivePlayers().length);
  const desired = desiredSize(aliveCount);
  if (desired.cols < world.cols || desired.rows < world.rows) {
    resizeWorld(Math.max(BASE_COLS, desired.cols), Math.max(BASE_ROWS, desired.rows));
    return;
  }

  const targetBeasts = desiredBeasts(aliveCount);
  while (world.beasts.size < targetBeasts) {
    if (!spawnBeast()) break;
  }
}

function handleJoin(ws, msg) {
  const glyph = typeof msg.glyph === 'string' ? msg.glyph.slice(0, 4) : '';
  const color = typeof msg.color === 'string' ? msg.color.slice(0, 16) : '#6dff8a';
  if (!glyph) {
    send(ws, { t: 'error', code: 'bad_join', message: 'Invalid join payload.' });
    return;
  }

  const glyphTaken = [...world.players.values()].some((p) => p.alive && p.connected && p.glyph === glyph && p.id !== ws.playerId);
  if (glyphTaken) {
    send(ws, { t: 'error', code: 'glyph_taken', message: 'Glyph already taken.' });
    return;
  }

  const aliveCount = alivePlayers().length;
  const nextSize = desiredSize(Math.max(1, aliveCount + (ws.playerId ? 0 : 1)));
  if (nextSize.cols > world.cols || nextSize.rows > world.rows) {
    resizeWorld(Math.max(world.cols, nextSize.cols), Math.max(world.rows, nextSize.rows));
  }

  let player = ws.playerId ? world.players.get(ws.playerId) : null;
  const pos = findEmptyCell();

  if (!player) {
    player = {
      id: `p${world.nextPlayerId++}`,
      glyph,
      color,
      x: pos.x,
      y: pos.y,
      alive: true,
      deathTime: null,
      lastSeen: Date.now(),
      lastMoveAt: 0,
      connected: true,
      ws,
    };
    world.players.set(player.id, player);
    ws.playerId = player.id;
  } else {
    player.glyph = glyph;
    player.color = color;
    player.x = pos.x;
    player.y = pos.y;
    player.alive = true;
    player.deathTime = null;
    player.connected = true;
    player.ws = ws;
    player.lastSeen = Date.now();
  }

  markPlayer(player);

  const targetBeasts = desiredBeasts(Math.max(1, alivePlayers().length));
  while (world.beasts.size < targetBeasts) {
    if (!spawnBeast()) break;
  }

  send(ws, { t: 'welcome', you: player.id, world: buildSnapshot() });
}

function handleMove(ws, msg) {
  const player = ws.playerId ? world.players.get(ws.playerId) : null;
  if (!player || !player.alive) return;

  const { dx, dy, seq } = msg;
  const now = Date.now();
  if (![ -1, 0, 1 ].includes(dx) || ![ -1, 0, 1 ].includes(dy) || (dx === 0 && dy === 0)) {
    send(ws, { t: 'move_ack', seq: Number(seq) || 0, x: player.x, y: player.y });
    return;
  }

  if (now - player.lastMoveAt < PLAYER_MOVE_COOLDOWN_MS) {
    send(ws, { t: 'move_ack', seq: Number(seq) || 0, x: player.x, y: player.y });
    return;
  }

  player.lastMoveAt = now;
  applyMove(player, dx, dy);
  send(ws, { t: 'move_ack', seq: Number(seq) || 0, x: player.x, y: player.y });
}

function handleLeave(ws) {
  const player = ws.playerId ? world.players.get(ws.playerId) : null;
  if (!player) return;
  disconnectPlayer(player);
}

function gameLoop() {
  const now = Date.now();
  world.tick += 1;

  const aliveCount = alivePlayers().length;
  const beastInterval = Math.max(BEAST_TICK_MIN_MS, BEAST_TICK_MAX_MS - aliveCount * 40);
  if (now - world.lastBeastTick >= beastInterval) {
    world.lastBeastTick = now;
    for (const beast of world.beasts.values()) moveBeast(beast);
  }

  if (now - world.lastCleanupAt >= 500) {
    world.lastCleanupAt = now;
    cleanupPlayers(now);
  }

  flushDeltas();

  if (now - world.lastSnapshotAt >= 10000) {
    world.lastSnapshotAt = now;
    broadcast({ t: 'snapshot', world: buildSnapshot() });
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === '/health') {
    const body = JSON.stringify({ ok: true, players: connectedPlayers().length });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  const pathname = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    };

    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.lastPong = Date.now();

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      ws.close(1003, 'Malformed JSON');
      return;
    }

    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      ws.close(1003, 'Malformed message');
      return;
    }

    const player = ws.playerId ? world.players.get(ws.playerId) : null;
    if (player) player.lastSeen = Date.now();

    switch (msg.t) {
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'move':
        handleMove(ws, msg);
        break;
      case 'leave':
        handleLeave(ws);
        break;
      case 'ping':
        send(ws, { t: 'pong', ts: Number(msg.ts) || Date.now() });
        break;
      default:
        ws.close(1003, 'Unknown message type');
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    handleLeave(ws);
  });

  ws.on('error', () => {
    clients.delete(ws);
    handleLeave(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const ws of clients) {
    const player = ws.playerId ? world.players.get(ws.playerId) : null;
    if (player && now - player.lastSeen > PLAYER_TIMEOUT_MS) {
      ws.close(1008, 'Heartbeat timeout');
    }
  }
}, HEARTBEAT_MS);

setInterval(gameLoop, 16);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'server_started', port: PORT }));
});
