(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BEAST_CONSTANTS = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  const constants = {
    CELL_PX: 28,
    BASE_COLS: 28,
    BASE_ROWS: 18,
    PER_PLAYER_COLS: 10,
    PER_PLAYER_ROWS: 5,
    MAX_COLS: 120,
    MAX_ROWS: 80,
    TILE: { EMPTY: 0, WALL: 1, BLOCK: 2 },
    WALL_DENSITY: 0.025,
    BLOCK_DENSITY: 0.32,
    BEAST_BASE: 3,
    BEAST_PER_PLAYER: 2,
    BEAST_TICK_MIN_MS: 450,
    BEAST_TICK_MAX_MS: 900,
    PLAYER_MOVE_COOLDOWN_MS: 80,
    HEARTBEAT_MS: 3000,
    PLAYER_TIMEOUT_MS: 8000,
    DEATH_LINGER_MS: 4000,
  };
  return constants;
}));
