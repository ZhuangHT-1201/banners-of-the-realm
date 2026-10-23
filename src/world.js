import { hash2, mulberry32 } from "./utils.js";

export const MAP_SIZE = 56;
export const TILE_W = 88;
export const TILE_H = 44;

export const TERRAIN = {
  GRASS: 0,
  FOREST: 1,
  WATER: 2,
  BRIDGE: 3,
  ROAD: 4,
  MEADOW: 5,
  ROCK: 6,
};

const BASE_AREAS = [
  { x: 11.5, y: 28, radius: 7.2, owner: "player" },
  { x: 44.5, y: 28, radius: 7.2, owner: "enemy" },
];

function riverCenter(y) {
  return 28 + Math.sin(y * 0.31) * 1.55 + Math.sin(y * 0.085 + 0.6) * 1.3;
}

function isBridgeTile(x, y) {
  const center = riverCenter(y);
  return Math.abs(x - center) < 2.3 && ((y >= 16 && y <= 18) || (y >= 37 && y <= 39));
}

function isWaterTile(x, y) {
  return Math.abs(x - riverCenter(y)) < 1.5;
}

function inBaseArea(x, y, extra = 0) {
  return BASE_AREAS.some((base) => Math.hypot(x - base.x, y - base.y) < base.radius + extra);
}

function makeNode(id, kind, x, y, amount, variant = 0) {
  return {
    id,
    kind,
    x,
    y,
    amount,
    maxAmount: amount,
    radius: 0.33,
    variant,
    alive: true,
  };
}

export function generateWorld(seed = 1140) {
  const random = mulberry32(seed);
  const size = MAP_SIZE;
  const terrain = new Uint8Array(size * size);
  const elevation = new Float32Array(size * size);
  const nodes = [];
  let nodeIndex = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      let type = TERRAIN.GRASS;
      const noise = hash2(x, y, seed);
      const broadNoise = hash2(Math.floor(x / 4), Math.floor(y / 4), seed + 33);
      elevation[idx] =
        Math.sin(x * 0.21) * 0.22 +
        Math.cos(y * 0.17) * 0.2 +
        Math.sin((x + y) * 0.11) * 0.16 +
        broadNoise * 0.18;
      if (noise > 0.82) type = TERRAIN.MEADOW;
      if (broadNoise > 0.91) type = TERRAIN.ROCK;

      if (isWaterTile(x, y)) {
        type = isBridgeTile(x, y) ? TERRAIN.BRIDGE : TERRAIN.WATER;
      }

      if (inBaseArea(x, y, 1.5)) {
        type = TERRAIN.GRASS;
      }

      const roadDistance = Math.abs(x - riverCenter(y));
      if (
        (y >= 26 && y <= 30 && (x < 25 || x > 31)) ||
        (Math.abs(y - 17) <= 1 && roadDistance < 8) ||
        (Math.abs(y - 38) <= 1 && roadDistance < 8)
      ) {
        if (type !== TERRAIN.WATER) type = TERRAIN.ROAD;
      }

      terrain[idx] = type;
    }
  }

  const occupied = new Set();
  const reserve = (x, y) => occupied.add(`${x},${y}`);
  const isReserved = (x, y) => occupied.has(`${x},${y}`);
  const canPlaceResource = (x, y, baseClearance = 2) => {
    if (x < 2 || y < 2 || x >= size - 2 || y >= size - 2) return false;
    if (terrain[y * size + x] === TERRAIN.WATER || terrain[y * size + x] === TERRAIN.BRIDGE) return false;
    if (isReserved(x, y)) return false;
    for (let oy = -baseClearance; oy <= baseClearance; oy++) {
      for (let ox = -baseClearance; ox <= baseClearance; ox++) {
        if (inBaseArea(x + ox, y + oy, 1.3)) return false;
      }
    }
    return true;
  };

  const addCluster = (kind, count, amount, near = null, scatter = 2.2, clearance = 2) => {
    const clusterX = near?.x ?? 8 + random() * 40;
    const clusterY = near?.y ?? 8 + random() * 40;
    let attempts = 0;
    let placed = 0;
    while (placed < count && attempts < count * 30) {
      attempts++;
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * scatter;
      const x = Math.round(clusterX + Math.cos(angle) * radius);
      const y = Math.round(clusterY + Math.sin(angle) * radius);
      if (!canPlaceResource(x, y, clearance)) continue;
      const variants = { tree: 4, berries: 3, gold: 2, stone: 2 }[kind] ?? 1;
      nodes.push(makeNode(`node_${nodeIndex++}`, kind, x, y, amount, Math.floor(random() * variants)));
      reserve(x, y);
      placed++;
    }
  };

  // Base food gardens use visual berry thickets; farms can later replace these gathering routes.
  addCluster("berries", 7, 520, { x: 17, y: 22 }, 2.8, 1);
  addCluster("berries", 6, 520, { x: 39, y: 34 }, 2.8, 1);
  addCluster("berries", 5, 460, { x: 17, y: 35 }, 2.5, 1);
  addCluster("berries", 5, 460, { x: 39, y: 21 }, 2.5, 1);

  addCluster("gold", 5, 720, { x: 20, y: 16 }, 2.1, 1);
  addCluster("gold", 5, 720, { x: 36, y: 40 }, 2.1, 1);
  addCluster("gold", 6, 850, { x: 28, y: 10 }, 3.2, 3);
  addCluster("gold", 6, 850, { x: 28, y: 47 }, 3.2, 3);

  addCluster("stone", 5, 620, { x: 20, y: 41 }, 2.2, 1);
  addCluster("stone", 5, 620, { x: 36, y: 15 }, 2.2, 1);
  addCluster("stone", 6, 760, { x: 22, y: 8 }, 3.6, 2);
  addCluster("stone", 6, 760, { x: 34, y: 48 }, 3.6, 2);

  // Wooded belts frame the central river valley.
  const groves = [
    [6, 10, 15],
    [8, 44, 18],
    [20, 5, 16],
    [22, 48, 18],
    [49, 10, 17],
    [46, 45, 17],
    [31, 22, 10],
    [31, 33, 10],
    [40, 6, 13],
    [40, 49, 13],
  ];
  for (const [x, y, count] of groves) {
    addCluster("tree", count, 150, { x, y }, 4.3, 1);
  }

  // A few scattered tree stands break up the open plain.
  for (let i = 0; i < 240; i++) {
    const x = Math.floor(4 + random() * (size - 8));
    const y = Math.floor(4 + random() * (size - 8));
    if (random() > 0.76 && canPlaceResource(x, y, 1)) {
      nodes.push(makeNode(`node_${nodeIndex++}`, "tree", x, y, 150, Math.floor(random() * 4)));
      reserve(x, y);
    }
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const nodeAt = new Map(nodes.map((node) => [`${node.x},${node.y}`, node]));

  const roads = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (terrain[idx] === TERRAIN.ROAD) roads.push({ x, y });
    }
  }

  return {
    seed,
    size,
    terrain,
    elevation,
    nodes,
    nodeMap,
    nodeAt,
    bases: BASE_AREAS,
    roads,
    riverCenter,
    isBridgeTile,
    isWaterTile,
  };
}

export function terrainAt(world, x, y) {
  if (x < 0 || y < 0 || x >= world.size || y >= world.size) return -1;
  return world.terrain[y * world.size + x];
}

export function isTerrainPassable(world, x, y) {
  const terrain = terrainAt(world, x, y);
  return terrain !== -1 && terrain !== TERRAIN.WATER;
}

export function nodeAtWorld(world, x, y) {
  return world.nodeAt.get(`${Math.round(x)},${Math.round(y)}`) ?? null;
}

export function isInsideBuilding(x, y, building) {
  return (
    x >= building.anchorX &&
    y >= building.anchorY &&
    x < building.anchorX + building.size &&
    y < building.anchorY + building.size
  );
}

export function nearestWalkableTile(world, startX, startY, blocked, maxRadius = 5) {
  const sx = Math.round(startX);
  const sy = Math.round(startY);
  const isOpen = (x, y) => {
    if (x < 0 || y < 0 || x >= world.size || y >= world.size) return false;
    const idx = y * world.size + x;
    return !blocked[idx] && isTerrainPassable(world, x, y);
  };

  if (isOpen(sx, sy)) return { x: sx, y: sy };

  for (let radius = 1; radius <= maxRadius; radius++) {
    let best = null;
    let bestDistance = Infinity;
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue;
        const x = sx + ox;
        const y = sy + oy;
        if (!isOpen(x, y)) continue;
        const d = ox * ox + oy * oy;
        if (d < bestDistance) {
          bestDistance = d;
          best = { x, y };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].f <= item.f) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop() {
    const items = this.items;
    if (items.length === 0) return null;
    const root = items[0];
    const last = items.pop();
    if (items.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= items.length) break;
        let child = left;
        if (right < items.length && items[right].f < items[left].f) child = right;
        if (items[child].f >= last.f) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return root;
  }

  get size() {
    return this.items.length;
  }
}

export function findPath(world, start, end, blocked, options = {}) {
  const size = world.size;
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  let ex = Math.round(end.x);
  let ey = Math.round(end.y);
  if (sx < 0 || sy < 0 || sx >= size || sy >= size) return [];
  if (ex < 0 || ey < 0 || ex >= size || ey >= size) return [];

  const targetBlocked = blocked[ey * size + ex] || !isTerrainPassable(world, ex, ey);
  if (targetBlocked) {
    const near = nearestWalkableTile(world, ex, ey, blocked, options.nearRadius ?? 5);
    if (!near) return [];
    ex = near.x;
    ey = near.y;
  }

  if (sx === ex && sy === ey) return [];

  const total = size * size;
  const gScore = new Float32Array(total);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(total);
  cameFrom.fill(-1);
  const closed = new Uint8Array(total);
  const startIndex = sy * size + sx;
  const endIndex = ey * size + ex;
  gScore[startIndex] = 0;
  const open = new MinHeap();
  open.push({ x: sx, y: sy, index: startIndex, f: 0 });

  const directions = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  let iterations = 0;
  while (open.size && iterations++ < 9000) {
    const current = open.pop();
    if (closed[current.index]) continue;
    if (current.index === endIndex) {
      const points = [];
      let index = endIndex;
      while (index !== startIndex && index !== -1) {
        points.push({ x: index % size, y: Math.floor(index / size) });
        index = cameFrom[index];
      }
      points.reverse();
      return simplifyPath(world, { x: start.x, y: start.y }, points, blocked);
    }
    closed[current.index] = 1;

    for (const [dx, dy, cost] of directions) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const nIndex = ny * size + nx;
      if (closed[nIndex] || blocked[nIndex] || !isTerrainPassable(world, nx, ny)) continue;
      if (dx !== 0 && dy !== 0) {
        if (blocked[current.y * size + nx] || blocked[ny * size + current.x]) continue;
        if (!isTerrainPassable(world, current.x + dx, current.y) || !isTerrainPassable(world, current.x, current.y + dy)) continue;
      }
      const nextG = gScore[current.index] + cost;
      if (nextG >= gScore[nIndex]) continue;
      gScore[nIndex] = nextG;
      cameFrom[nIndex] = current.index;
      const h = Math.abs(ex - nx) + Math.abs(ey - ny) + (Math.SQRT2 - 2) * Math.min(Math.abs(ex - nx), Math.abs(ey - ny));
      open.push({ x: nx, y: ny, index: nIndex, f: nextG + h * 1.002 });
    }
  }
  return [];
}

export function lineClear(world, start, end, blocked) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(length / 0.32));
  let previousX = Math.round(start.x);
  let previousY = Math.round(start.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(start.x + dx * t);
    const y = Math.round(start.y + dy * t);
    if (x < 0 || y < 0 || x >= world.size || y >= world.size) return false;
    if (blocked[y * world.size + x]) return false;
    if (!isTerrainPassable(world, x, y)) return false;
    if (x !== previousX && y !== previousY) {
      if (blocked[previousY * world.size + x] || blocked[y * world.size + previousX]) return false;
    }
    previousX = x;
    previousY = y;
  }
  return true;
}

export function simplifyPath(world, start, points, blocked) {
  if (points.length < 2) return points;
  const result = [];
  let anchor = start;
  let index = 0;
  while (index < points.length) {
    let farthest = index;
    for (let check = points.length - 1; check >= index; check--) {
      if (lineClear(world, anchor, points[check], blocked)) {
        farthest = check;
        break;
      }
    }
    const point = points[farthest];
    result.push(point);
    anchor = point;
    index = farthest + 1;
  }
  return result;
}

export function nearestResource(world, x, y, kinds, maxDistance = 40, predicate = null) {
  let best = null;
  let bestDistance = maxDistance;
  for (const node of world.nodes) {
    if (!node.alive || node.amount <= 0) continue;
    if (!kinds.includes(node.kind)) continue;
    if (predicate && !predicate(node)) continue;
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

export function mapRegionName(x, y) {
  if (Math.abs(x - riverCenter(y)) < 3) return "颍水河湾";
  if (x < 22) return "西营平野";
  if (x > 34) return "东境驿道";
  if (y < 22) return "北邙林麓";
  if (y > 35) return "南榆川";
  return "郾城中野";
}
