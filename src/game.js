import {
  AGES,
  BUILD_DEFS,
  CIVS,
  TECH_DEFS,
  UNIT_DEFS,
  getUnitCost,
} from "./data.js";
import {
  MAP_SIZE,
  TERRAIN,
  findPath,
  generateWorld,
  isInsideBuilding,
  nearestResource,
  nearestWalkableTile,
  terrainAt,
} from "./world.js";
import { canAfford, clamp, dist, pay, refund } from "./utils.js";

const RESOURCE_KEYS = ["food", "wood", "gold", "stone"];

const AI_TUNING = {
  easy: {
    think: 2.15,
    attackThreshold: 10,
    attackInterval: 78,
    gatherBonus: 1,
    trainDelay: 1.25,
    startingBonus: 0,
  },
  normal: {
    think: 1.45,
    attackThreshold: 7,
    attackInterval: 55,
    gatherBonus: 1.05,
    trainDelay: 1,
    startingBonus: 45,
  },
  veteran: {
    think: 1.02,
    attackThreshold: 6,
    attackInterval: 42,
    gatherBonus: 1.13,
    trainDelay: 0.7,
    startingBonus: 120,
  },
};

const INITIAL_RESOURCES = {
  food: 520,
  wood: 470,
  gold: 280,
  stone: 190,
};

const OTHER = { player: "enemy", enemy: "player" };

function makePlayer(id, civId) {
  return {
    id,
    civId,
    resources: { ...INITIAL_RESOURCES },
    age: 0,
    techs: {},
    stats: {
      gathered: { food: 0, wood: 0, gold: 0, stone: 0 },
      trained: 0,
      villagersTrained: 0,
      killed: 0,
      lost: 0,
      buildingsBuilt: 0,
      buildingsLost: 0,
      resourcesSpent: 0,
    },
    deposits: [],
    ai: id === "enemy",
    nextThink: 1.8,
    nextAttackAt: 0,
    aiBuildCooldown: 0,
    aiTrainingCooldown: 0,
    alertedAt: 0,
  };
}

export class Game {
  constructor(options = {}) {
    this.options = {
      playerCiv: "song",
      difficulty: "normal",
      attract: false,
      ...options,
    };
    this.callbacks = options.callbacks ?? {};
    this.world = generateWorld(options.seed ?? 1140 + (Date.now() % 1000));
    this.players = {
      player: makePlayer("player", this.options.playerCiv),
      enemy: makePlayer("enemy", this.options.playerCiv === "song" ? "jin" : "song"),
    };
    if (!this.options.attract) {
      const bonus = AI_TUNING[this.options.difficulty]?.startingBonus ?? 0;
      this.players.enemy.resources.food += bonus;
      this.players.enemy.resources.wood += bonus;
    }

    this.entities = new Map();
    this.unitList = [];
    this.buildingList = [];
    this.projectiles = [];
    this.effects = [];
    this.selected = new Set();
    this.controlGroups = new Map();
    this.rallyPoints = new Map();
    this.blocked = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.blockedDirty = true;
    this.visibility = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.explored = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.fogTimer = 0;
    this.fogVersion = 0;
    this.time = 0;
    this.speed = 1;
    this.state = this.options.attract ? "menu" : "playing";
    this.placement = null;
    this.commandMode = null;
    this.mouseWorld = { x: this.world.size / 2, y: this.world.size / 2 };
    this.pendingEnd = null;
    this.matchEnded = false;
    this.tutorialStep = 0;
    this.lastAlertAt = 0;
    this.rates = { food: 0, wood: 0, gold: 0, stone: 0 };
    this.rateTimer = 0;
    this.aiTuning = AI_TUNING[this.options.difficulty] ?? AI_TUNING.normal;
    this.entitySequence = 1;
    this.objectiveCache = "";
    this.cameraTarget = null;

    this.setupMatch();
  }

  setupMatch() {
    this.spawnBuilding("townCenter", "player", 8, 26, { complete: true, silent: true });
    this.spawnBuilding("townCenter", "enemy", 44, 26, { complete: true, silent: true });

    const playerStart = [
      [7, 31],
      [8, 31],
      [9, 31],
      [11, 31],
      [12, 31],
    ];
    const enemyStart = [
      [43, 31],
      [44, 31],
      [45, 31],
      [47, 31],
      [48, 31],
    ];
    for (const [x, y] of playerStart) this.spawnUnit("villager", "player", x, y, { silent: true });
    for (const [x, y] of enemyStart) this.spawnUnit("villager", "enemy", x, y, { silent: true });

    this.spawnUnit("spearman", "player", 6, 24, { silent: true });
    this.spawnUnit("spearman", "player", 7, 24, { silent: true });
    this.spawnUnit("archer", "player", 8, 23, { silent: true });
    this.spawnUnit("spearman", "enemy", 49, 24, { silent: true });
    this.spawnUnit("spearman", "enemy", 48, 24, { silent: true });
    this.spawnUnit("archer", "enemy", 47, 23, { silent: true });

    this.rebuildBlockGrid();
    this.updateVisibility(true);
    if (this.callbacks.onSelectionChanged) this.callbacks.onSelectionChanged([]);
  }

  get player() {
    return this.players.player;
  }

  get enemy() {
    return this.players.enemy;
  }

  get civ() {
    return CIVS[this.player.civId];
  }

  getOtherPlayer(owner) {
    return this.players[OTHER[owner]];
  }

  nextId(prefix) {
    return `${prefix}_${this.entitySequence++}_${Math.floor(Math.random() * 1000)}`;
  }

  notify(message, type = "info") {
    if (this.callbacks.onNotice) this.callbacks.onNotice(message, type);
  }

  alertAttack(owner) {
    if (owner !== "player") return;
    const now = performance.now();
    if (now - this.lastAlertAt < 5500) return;
    this.lastAlertAt = now;
    this.notify("军情急报：敌方正在进攻我军营垒！", "warning");
    if (this.callbacks.onUnderAttack) this.callbacks.onUnderAttack();
  }

  spawnUnit(type, owner, x, y, options = {}) {
    const def = UNIT_DEFS[type];
    if (!def) throw new Error(`Unknown unit: ${type}`);
    const entity = {
      id: this.nextId("u"),
      kind: "unit",
      type,
      owner,
      x,
      y,
      hp: def.hp,
      maxHp: def.hp,
      radius: def.radius,
      armor: def.armor,
      sight: def.sight,
      facing: owner === "player" ? 0.2 : Math.PI - 0.2,
      alive: true,
      task: { type: "idle" },
      path: null,
      pathIndex: 0,
      speed: def.speed,
      cooldown: Math.random() * 0.3,
      attackAnimation: 0,
      gatherAnimation: 0,
      walkAnimation: 0,
      carry: 0,
      carryType: null,
      thinkTimer: 0,
      acquisitionTimer: Math.random() * 0.4,
      lastAttacker: null,
      underConstruction: false,
      deadAt: null,
    };
    this.entities.set(entity.id, entity);
    this.unitList.push(entity);
    this.blockedDirty = true;
    if (options.completed !== false) {
      const player = this.players[owner];
      player.stats.trained++;
      if (type === "villager") player.stats.villagersTrained++;
    }
    if (!options.silent) {
      this.addEffect({
        type: "muster",
        x,
        y,
        owner,
        duration: 0.9,
      });
    }
    return entity;
  }

  spawnBuilding(type, owner, anchorX, anchorY, options = {}) {
    const def = BUILD_DEFS[type];
    if (!def) throw new Error(`Unknown building: ${type}`);
    const complete = options.complete !== false;
    const centerX = anchorX + (def.size - 1) / 2;
    const centerY = anchorY + (def.size - 1) / 2;
    const entity = {
      id: this.nextId("b"),
      kind: "building",
      type,
      owner,
      anchorX,
      anchorY,
      x: centerX,
      y: centerY,
      size: def.size,
      hp: complete ? def.hp : Math.max(1, def.hp * 0.08),
      maxHp: def.hp,
      armor: def.armor,
      sight: def.sight,
      alive: true,
      complete,
      constructionProgress: complete ? 100 : 0,
      productionQueue: [],
      productionProgress: 0,
      research: null,
      cooldown: Math.random() * 0.4,
      attackAnimation: 0,
      aliveSince: this.time,
      foodRemaining: complete && type === "farm" ? def.foodNode : 0,
      builderIds: new Set(),
      deadAt: null,
      sightFlicker: Math.random() * 10,
    };
    this.entities.set(entity.id, entity);
    this.buildingList.push(entity);
    this.blockedDirty = true;
    if (complete) {
      const player = this.players[owner];
      if (!options.silent) player.stats.buildingsBuilt++;
      if (type === "townCenter") this.tryRevealStartingArea(entity);
    } else {
      this.addEffect({ type: "blueprint", x: centerX, y: centerY, owner, duration: 0.8 });
    }
    return entity;
  }

  completeBuilding(entity) {
    if (entity.complete || !entity.alive) return;
    entity.complete = true;
    entity.constructionProgress = 100;
    entity.hp = entity.maxHp;
    entity.foodRemaining = entity.type === "farm" ? BUILD_DEFS.farm.foodNode : 0;
    const player = this.players[entity.owner];
    player.stats.buildingsBuilt++;
    this.addEffect({
      type: "complete",
      x: entity.x,
      y: entity.y,
      owner: entity.owner,
      duration: 1.35,
    });
    if (entity.owner === "player") {
      this.notify(`${BUILD_DEFS[entity.type].name}营造完成。`, "success");
    }
  }

  tryRevealStartingArea(entity) {
    const cx = Math.round(entity.x);
    const cy = Math.round(entity.y);
    const radius = 9;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || y < 0 || x >= this.world.size || y >= this.world.size) continue;
        if (Math.hypot(x - cx, y - cy) > radius) continue;
        this.explored[y * this.world.size + x] = 1;
      }
    }
    this.fogVersion++;
  }

  addEffect(effect) {
    this.effects.push({
      id: this.nextId("fx"),
      age: 0,
      duration: 0.7,
      ...effect,
    });
    if (this.effects.length > 320) this.effects.splice(0, this.effects.length - 320);
  }

  rebuildBlockGrid() {
    this.blocked.fill(0);
    const { terrain, size } = this.world;
    for (let i = 0; i < terrain.length; i++) {
      if (terrain[i] === TERRAIN.WATER) this.blocked[i] = 1;
    }
    for (const node of this.world.nodes) {
      if (!node.alive || node.amount <= 0) continue;
      const index = node.y * size + node.x;
      if (index >= 0 && index < this.blocked.length) this.blocked[index] = 1;
    }
    for (const building of this.buildingList) {
      if (!building.alive) continue;
      this.markBuildingBlocked(building);
    }
    this.blockedDirty = false;
  }

  markBuildingBlocked(building, blocked = true) {
    for (let y = building.anchorY; y < building.anchorY + building.size; y++) {
      for (let x = building.anchorX; x < building.anchorX + building.size; x++) {
        if (x < 0 || y < 0 || x >= this.world.size || y >= this.world.size) continue;
        this.blocked[y * this.world.size + x] = blocked ? 1 : 0;
      }
    }
  }

  isTileOccupiedByBuilding(x, y, ignoreId = null) {
    for (const building of this.buildingList) {
      if (!building.alive || building.id === ignoreId) continue;
      if (x >= building.anchorX && x < building.anchorX + building.size && y >= building.anchorY && y < building.anchorY + building.size) {
        return building;
      }
    }
    return null;
  }

  getResourceNode(nodeId) {
    if (!nodeId) return null;
    if (nodeId.startsWith("b_")) {
      const farm = this.entities.get(nodeId);
      return farm?.alive && farm.type === "farm" && farm.complete ? farm : null;
    }
    const node = this.world.nodeMap.get(nodeId);
    return node?.alive && node.amount > 0 ? node : null;
  }

  resourceKindOf(target) {
    if (!target) return null;
    if (target.kind === "building") return target.type === "farm" ? "food" : null;
    return target.kind ?? null;
  }

  resourceAmount(target) {
    if (!target) return 0;
    if (target.kind === "building") return target.foodRemaining ?? 0;
    return target.amount ?? 0;
  }

  consumeResource(target, amount) {
    if (!target) return;
    if (target.kind === "building") {
      target.foodRemaining = Math.max(0, target.foodRemaining - amount);
    } else {
      target.amount = Math.max(0, target.amount - amount);
      if (target.amount <= 0) {
        target.alive = false;
        this.blockedDirty = true;
        this.addEffect({
          type: target.kind === "tree" ? "stump" : "depleted",
          x: target.x,
          y: target.y,
          duration: 2.2,
        });
      }
    }
  }

  findDropoff(owner, resourceType, nearX, nearY) {
    let best = null;
    let bestDistance = Infinity;
    for (const building of this.buildingList) {
      if (!building.alive || !building.complete || building.owner !== owner) continue;
      const def = BUILD_DEFS[building.type];
      if (!def.drop?.includes(resourceType)) continue;
      const distance = Math.hypot(building.x - nearX, building.y - nearY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = building;
      }
    }
    return best;
  }

  getGatherRate(unit) {
    const def = UNIT_DEFS[unit.type];
    let rate = def.gatherRate;
    const player = this.players[unit.owner];
    if (unit.carryType === "food" && player.civId === "song") rate *= CIVS.song.bonuses.farmGather;
    if (unit.owner === "enemy") rate *= this.aiTuning.gatherBonus;
    return rate;
  }

  getUnitStats(unit) {
    const def = UNIT_DEFS[unit.type];
    const player = this.players[unit.owner];
    const techs = player.techs;
    let damage = def.damage;
    let armor = unit.armor;
    let range = def.attackRange;
    let speed = def.speed;
    if (techs.weapons && ["spearman", "cavalry"].includes(unit.type)) damage += 2;
    if (techs.armor) armor += 1;
    if (techs.bowcraft && unit.type === "archer") {
      damage += 1;
      range += 1;
    }
    if (player.civId === "song" && unit.type === "archer") range += CIVS.song.bonuses.archerRange;
    if (player.civId === "jin" && unit.type === "cavalry") {
      armor += CIVS.jin.bonuses.cavalryArmor;
      speed *= CIVS.jin.bonuses.cavalrySpeed;
    }
    if (player.age >= 2) damage *= 1.1;
    return { damage, armor, range, speed, sight: def.sight };
  }

  getPopulation(owner) {
    let population = 0;
    let capacity = 0;
    for (const entity of this.entities.values()) {
      if (!entity.alive || entity.owner !== owner) continue;
      if (entity.kind === "unit") population++;
      if (entity.kind === "building" && entity.complete) {
        capacity += BUILD_DEFS[entity.type].pop ?? 0;
      }
    }
    return { population, capacity };
  }

  canSpend(owner, cost) {
    return canAfford(this.players[owner].resources, cost);
  }

  spend(owner, cost) {
    const player = this.players[owner];
    if (!pay(player.resources, cost)) return false;
    player.stats.resourcesSpent += Object.values(cost).reduce((a, b) => a + b, 0);
    return true;
  }

  refund(owner, cost) {
    refund(this.players[owner].resources, cost);
  }

  canStartTraining(building, unitType) {
    const def = BUILD_DEFS[building.type];
    const unit = UNIT_DEFS[unitType];
    const player = this.players[building.owner];
    if (!building.alive || !building.complete || building.owner !== "player" && building.owner !== "enemy") return false;
    if (!def.train?.includes(unitType) || !unit) return false;
    if (unit.unlockAge && player.age < unit.unlockAge) return false;
    if (building.productionQueue.length >= 6) return false;
    const pop = this.getPopulation(building.owner);
    if (pop.population + building.productionQueue.filter((id) => UNIT_DEFS[id].category !== "worker").length >= pop.capacity) return false;
    return this.canSpend(building.owner, getUnitCost(unitType, player.civId));
  }

  startTraining(buildingId, unitType, options = {}) {
    const building = this.entities.get(buildingId);
    if (!building || building.kind !== "building" || !building.alive) return false;
    const def = BUILD_DEFS[building.type];
    const unitDef = UNIT_DEFS[unitType];
    const player = this.players[building.owner];
    if (!building.complete || !def.train?.includes(unitType)) return false;
    if (unitDef.unlockAge && player.age < unitDef.unlockAge) {
      if (building.owner === "player") this.notify(`${unitDef.name}需要进入「${AGES[unitDef.unlockAge].name}」时代。`, "warning");
      return false;
    }
    if (building.productionQueue.length >= 6) {
      if (building.owner === "player") this.notify("生产队列已满。", "warning");
      return false;
    }
    const { population, capacity } = this.getPopulation(building.owner);
    if (population + building.productionQueue.length >= capacity) {
      if (building.owner === "player") this.notify("人口已满，请营造更多民居。", "warning");
      return false;
    }
    const cost = getUnitCost(unitType, player.civId);
    if (!this.spend(building.owner, cost)) {
      if (building.owner === "player") this.notify("资源不足，无法招募该单位。", "warning");
      return false;
    }
    building.productionQueue.push(unitType);
    if (building.owner === "player" && !options.silent) {
      this.notify(`已加入训练：${unitDef.name}。`, "info");
    }
    return true;
  }

  cancelTraining(buildingId, index = null) {
    const building = this.entities.get(buildingId);
    if (!building || building.owner !== "player" || building.productionQueue.length === 0) return false;
    const queueIndex = index ?? building.productionQueue.length - 1;
    const [unitType] = building.productionQueue.splice(queueIndex, 1);
    if (!unitType) return false;
    this.refund("player", getUnitCost(unitType, this.player.civId));
    if (queueIndex === 0) building.productionProgress = 0;
    return true;
  }

  startResearch(buildingId, techId) {
    const building = this.entities.get(buildingId);
    const tech = TECH_DEFS[techId];
    if (!building || !tech || !building.alive || !building.complete) return false;
    const player = this.players[building.owner];
    if (player.techs[techId] || building.research) return false;
    if (!BUILD_DEFS[building.type].research?.includes(techId)) return false;
    if (!this.spend(building.owner, tech.cost)) {
      if (building.owner === "player") this.notify("资源不足，无法开展此项研究。", "warning");
      return false;
    }
    building.research = {
      kind: "tech",
      id: techId,
      time: tech.time,
      progress: 0,
      name: tech.name,
    };
    return true;
  }

  startAgeAdvance(buildingId = null) {
    const tc = buildingId ? this.entities.get(buildingId) : this.getTownCenter("player");
    if (!tc || tc.type !== "townCenter" || tc.owner !== "player" || !tc.complete) return false;
    const player = this.player;
    if (player.age >= AGES.length - 1) {
      this.notify("王朝已至鼎盛，无需继续演进。", "info");
      return false;
    }
    if (tc.research) {
      this.notify("城镇中心正在处理其他事务。", "warning");
      return false;
    }
    const targetAge = player.age + 1;
    const age = AGES[targetAge];
    if (!this.spend("player", age.cost)) {
      this.notify("资源不足，无法推进时代演进。", "warning");
      return false;
    }
    tc.research = {
      kind: "age",
      targetAge,
      time: age.time,
      progress: 0,
      name: age.title,
    };
    this.notify(`时代演进开始：${age.title}。`, "success");
    return true;
  }

  cancelAgeAdvance(buildingId = null) {
    const tc = buildingId ? this.entities.get(buildingId) : this.getTownCenter("player");
    if (!tc || tc.research?.kind !== "age") return false;
    const targetAge = tc.research.targetAge;
    this.refund("player", AGES[targetAge].cost);
    tc.research = null;
    return true;
  }

  getTownCenter(owner) {
    return this.buildingList.find((building) => building.alive && building.owner === owner && building.type === "townCenter") ?? null;
  }

  select(ids, additive = false) {
    if (!additive) this.selected.clear();
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (entity?.alive && entity.owner === "player") this.selected.add(id);
    }
    if (this.callbacks.onSelectionChanged) this.callbacks.onSelectionChanged(this.getSelectedEntities());
  }

  clearSelection() {
    if (this.selected.size === 0) return;
    this.selected.clear();
    if (this.callbacks.onSelectionChanged) this.callbacks.onSelectionChanged([]);
  }

  addToSelection(ids, additive = true) {
    this.select(ids, additive);
  }

  getSelectedEntities() {
    return [...this.selected].map((id) => this.entities.get(id)).filter((entity) => entity?.alive && entity.owner === "player");
  }

  getSelectedUnits() {
    return this.getSelectedEntities().filter((entity) => entity.kind === "unit");
  }

  getPrimarySelection() {
    const selected = this.getSelectedEntities();
    return selected.find((entity) => entity.kind === "building") ?? selected[0] ?? null;
  }

  assignControlGroup(index) {
    const ids = [...this.selected];
    if (ids.length) {
      this.controlGroups.set(index, ids);
      this.notify(`编队 ${index} 已整编。`, "info");
    }
  }

  recallControlGroup(index, additive = false) {
    const ids = this.controlGroups.get(index);
    if (!ids) return false;
    this.select(ids.filter((id) => this.entities.get(id)?.alive), additive);
    return true;
  }

  selectAllArmy() {
    const ids = this.unitList
      .filter((unit) => unit.alive && unit.owner === "player" && UNIT_DEFS[unit.type].category !== "worker")
      .map((unit) => unit.id);
    this.select(ids);
    return ids.length;
  }

  getIdleVillagers() {
    return this.unitList.filter(
      (unit) =>
        unit.alive &&
        unit.owner === "player" &&
        unit.type === "villager" &&
        (unit.task.type === "idle" || unit.task.type === "move") &&
        !unit.task.attackMove,
    );
  }

  selectNextIdleVillager() {
    const idle = this.getIdleVillagers();
    if (!idle.length) {
      this.notify("没有空闲的乡勇。", "info");
      return false;
    }
    const current = [...this.selected][0];
    const index = idle.findIndex((unit) => unit.id === current);
    const next = idle[(index + 1) % idle.length];
    this.select([next.id]);
    if (this.callbacks.onFocusWorld) this.callbacks.onFocusWorld(next.x, next.y);
    return true;
  }

  getEntityAtWorld(x, y, includeEnemies = true) {
    let best = null;
    let bestDepth = -Infinity;
    for (const entity of this.entities.values()) {
      if (!entity.alive) continue;
      if (!includeEnemies && entity.owner !== "player") continue;
      let hit = false;
      if (entity.kind === "building") {
        hit = isInsideBuilding(x, y, entity);
      } else {
        hit = Math.hypot(x - entity.x, y - entity.y) < Math.max(0.36, entity.radius + 0.12);
      }
      if (hit) {
        const depth = entity.kind === "building" ? entity.anchorY + entity.size : entity.y;
        if (depth > bestDepth) {
          best = entity;
          bestDepth = depth;
        }
      }
    }
    return best;
  }

  getInteractionAt(x, y) {
    const entity = this.getEntityAtWorld(x, y, true);
    if (entity) return entity;
    const gx = Math.round(x);
    const gy = Math.round(y);
    const node = this.world.nodeAt.get(`${gx},${gy}`);
    if (node?.alive && node.amount > 0) return node;
    return null;
  }

  createPath(unit, target, nearRadius = 5) {
    if (this.blockedDirty) this.rebuildBlockGrid();
    return findPath(this.world, unit, target, this.blocked, { nearRadius });
  }

  moveAlongPath(unit, path, dt, speed) {
    if (!path || path.length === 0) return true;
    let remaining = speed * dt;
    if (unit.path !== path) {
      unit.path = path;
      unit.pathIndex = 0;
    }
    while (remaining > 0 && unit.pathIndex < path.length) {
      const point = path[unit.pathIndex];
      const dx = point.x - unit.x;
      const dy = point.y - unit.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.055) {
        unit.pathIndex++;
        continue;
      }
      unit.facing = Math.atan2(dy, dx);
      const step = Math.min(remaining, distance);
      unit.x += (dx / distance) * step;
      unit.y += (dy / distance) * step;
      unit.walkAnimation += step * 5.6;
      remaining -= step;
      if (distance - step < 0.02) unit.pathIndex++;
    }
    return unit.pathIndex >= path.length;
  }

  formationOffset(index, total) {
    if (total <= 1) return { x: 0, y: 0 };
    const columns = Math.ceil(Math.sqrt(total));
    const row = Math.floor(index / columns);
    const col = index % columns;
    const rowCount = Math.ceil(total / columns);
    return {
      x: (col - (columns - 1) / 2) * 0.56,
      y: (row - (rowCount - 1) / 2) * 0.56,
    };
  }

  stopUnits(units = this.getSelectedUnits()) {
    for (const unit of units) {
      unit.task = { type: "idle" };
      unit.path = null;
      unit.pathIndex = 0;
    }
  }

  issueMove(ids, destination, attackMove = false) {
    const units = ids
      .map((id) => this.entities.get(id))
      .filter((entity) => entity?.alive && entity.owner === "player" && entity.kind === "unit");
    if (!units.length) return false;
    units.sort((a, b) => a.y - b.y);
    units.forEach((unit, index) => {
      const offset = this.formationOffset(index, units.length);
      const target = {
        x: clamp(destination.x + offset.x, 1, this.world.size - 2),
        y: clamp(destination.y + offset.y, 1, this.world.size - 2),
      };
      const path = this.createPath(unit, target, 3);
      if (!path.length && (Math.abs(unit.x - target.x) > 0.3 || Math.abs(unit.y - target.y) > 0.3)) {
        unit.thinkTimer = 1.2;
        return;
      }
      unit.task = {
        type: attackMove ? "attackMove" : "move",
        dest: target,
        path,
        chasing: false,
      };
      unit.path = path;
      unit.pathIndex = 0;
    });
    this.commandMode = null;
    this.addEffect({ type: attackMove ? "attackMarker" : "moveMarker", x: destination.x, y: destination.y, duration: 0.85 });
    return true;
  }

  issueAttack(ids, targetId) {
    const target = this.entities.get(targetId);
    const units = ids
      .map((id) => this.entities.get(id))
      .filter((entity) => entity?.alive && entity.owner === "player" && entity.kind === "unit" && entity.type !== "villager");
    if (!target?.alive || target.owner === "player" || !units.length) return false;
    for (const unit of units) {
      const path = this.createPath(unit, target, 4);
      unit.task = { type: "attack", targetId: target.id, path, repathTimer: 0.8 };
      unit.path = path;
      unit.pathIndex = 0;
    }
    this.addEffect({ type: "attackMarker", x: target.x, y: target.y, duration: 0.85 });
    this.commandMode = null;
    return true;
  }

  issueContextOrder(x, y, additive = false) {
    const selectedBuildings = this.getSelectedEntities().filter((entity) => entity.kind === "building");
    const productionBuilding = selectedBuildings.find((building) => BUILD_DEFS[building.type].train);
    if (productionBuilding) {
      this.rallyPoints.set(productionBuilding.id, { x, y });
      this.addEffect({ type: "rallyMarker", x, y, duration: 1.2 });
      if (productionBuilding.owner === "player") this.notify(`已设下${BUILD_DEFS[productionBuilding.type].name}集结点。`, "info");
      return true;
    }
    const units = this.getSelectedUnits();
    if (!units.length) return false;
    const target = this.getInteractionAt(x, y);
    if (target?.kind === "unit" || target?.kind === "building") {
      if (target.owner !== "player") return this.issueAttack(units.map((u) => u.id), target.id);
      if (target.owner === "player" && target.kind === "building") {
        const workers = units.filter((unit) => unit.type === "villager");
        if (workers.length && (!target.complete || target.hp < target.maxHp)) {
          this.assignBuild(workers.map((unit) => unit.id), target.id);
          return true;
        }
      }
    }
    if (target && ["tree", "berries", "gold", "stone"].includes(target.kind)) {
      const workers = units.filter((unit) => unit.type === "villager");
      if (workers.length) {
        this.assignGather(workers.map((worker) => worker.id), target.id);
        return true;
      }
      return false;
    }
    if (target?.kind === "building" && target.owner === "player" && target.type === "farm") {
      const workers = units.filter((unit) => unit.type === "villager");
      if (workers.length) {
        this.assignGather(workers.map((worker) => worker.id), target.id);
        return true;
      }
    }
    return this.issueMove(units.map((unit) => unit.id), { x, y }, false);
  }

  assignGather(ids, nodeId) {
    const target = this.getResourceNode(nodeId);
    if (!target) return false;
    const kind =
      target.kind === "building" || target.kind === "berries"
        ? "food"
        : target.kind === "tree"
          ? "wood"
          : target.kind;
    const units = ids
      .map((id) => this.entities.get(id))
      .filter((entity) => entity?.alive && entity.kind === "unit" && entity.type === "villager");
    if (!units.length) return false;
    for (const unit of units) {
      const path = this.createPath(unit, target, 3);
      unit.task = {
        type: "gather",
        nodeId,
        resourceType: kind,
        phase: "to",
        path,
      };
      unit.path = path;
      unit.pathIndex = 0;
      unit.carryType = kind;
      unit.carry = unit.carryType === kind ? unit.carry : 0;
    }
    this.addEffect({ type: "gatherMarker", x: target.x, y: target.y, resourceType: kind, duration: 1 });
    return true;
  }

  assignBuild(ids, buildingId) {
    const building = this.entities.get(buildingId);
    if (!building?.alive || building.owner !== "player") return false;
    const units = ids
      .map((id) => this.entities.get(id))
      .filter((entity) => entity?.alive && entity.owner === "player" && entity.kind === "unit" && entity.type === "villager");
    if (!units.length) return false;
    for (const unit of units) {
      const path = this.createPath(unit, building, 3);
      unit.task = { type: "build", buildingId, path };
      unit.path = path;
      unit.pathIndex = 0;
      building.builderIds.add(unit.id);
    }
    this.addEffect({ type: "buildMarker", x: building.x, y: building.y, duration: 0.9 });
    return true;
  }

  getPlacementValidity(type, anchorX, anchorY, owner = "player") {
    const def = BUILD_DEFS[type];
    if (!def) return { valid: false, reason: "未知建筑。" };
    const player = this.players[owner];
    if ((def.unlockAge ?? 0) > player.age) return { valid: false, reason: `需要进入「${AGES[def.unlockAge].name}」时代。` };
    for (let y = anchorY; y < anchorY + def.size; y++) {
      for (let x = anchorX; x < anchorX + def.size; x++) {
        if (x < 1 || y < 1 || x >= this.world.size - 1 || y >= this.world.size - 1) {
          return { valid: false, reason: "超出舆图边界。" };
        }
        const terrain = terrainAt(this.world, x, y);
        if (terrain === TERRAIN.WATER) return { valid: false, reason: "水面上无法营造。" };
        const node = this.world.nodeAt.get(`${x},${y}`);
        if (node?.alive && node.amount > 0) return { valid: false, reason: "此处有资源或林木阻挡。" };
        if (this.isTileOccupiedByBuilding(x, y)) return { valid: false, reason: "此处已有建筑。" };
      }
    }
    if (!this.canSpend(owner, def.cost)) return { valid: false, reason: "资源不足。" };
    return { valid: true, reason: "" };
  }

  beginPlacement(buildingType) {
    const def = BUILD_DEFS[buildingType];
    if (!def) return false;
    const workers = this.getSelectedUnits().filter((unit) => unit.type === "villager");
    if (!workers.length) {
      this.notify("请先选择乡勇，再安排营造。", "warning");
      return false;
    }
    this.placement = {
      buildingType,
      anchorX: Math.round(this.mouseWorld.x - (def.size - 1) / 2),
      anchorY: Math.round(this.mouseWorld.y - (def.size - 1) / 2),
      validity: { valid: false, reason: "" },
    };
    this.updatePlacementAt(this.mouseWorld.x, this.mouseWorld.y);
    return true;
  }

  updatePlacementAt(worldX, worldY) {
    if (!this.placement) return null;
    const def = BUILD_DEFS[this.placement.buildingType];
    this.placement.anchorX = Math.round(worldX - (def.size - 1) / 2);
    this.placement.anchorY = Math.round(worldY - (def.size - 1) / 2);
    this.placement.validity = this.getPlacementValidity(
      this.placement.buildingType,
      this.placement.anchorX,
      this.placement.anchorY,
      "player",
    );
    return this.placement;
  }

  cancelPlacement() {
    this.placement = null;
  }

  confirmPlacement() {
    if (!this.placement) return false;
    const { buildingType, anchorX, anchorY } = this.placement;
    const def = BUILD_DEFS[buildingType];
    const validation = this.getPlacementValidity(buildingType, anchorX, anchorY, "player");
    if (!validation.valid) {
      this.notify(validation.reason, "warning");
      return false;
    }
    const workers = this.getSelectedUnits().filter((unit) => unit.type === "villager");
    if (!workers.length) {
      this.notify("需要乡勇前来营造。", "warning");
      this.cancelPlacement();
      return false;
    }
    this.spend("player", def.cost);
    const building = this.spawnBuilding(buildingType, "player", anchorX, anchorY, { complete: false });
    this.assignBuild(workers.map((worker) => worker.id), building.id);
    this.placement = null;
    this.notify(`已下达营造令：${def.name}。`, "info");
    return true;
  }

  getEnemyTargets(owner) {
    return [...this.entities.values()].filter((entity) => entity.alive && entity.owner !== owner);
  }

  findEnemyNear(entity, radius, options = {}) {
    let best = null;
    let bestScore = Infinity;
    for (const target of this.entities.values()) {
      if (!target.alive || target.owner === entity.owner) continue;
      if (target.kind === "building" && target.underConstruction && options.skipConstruction) continue;
      const distance = dist(entity, target) - (target.kind === "building" ? target.size * 0.42 : target.radius);
      if (distance > radius) continue;
      let score = distance;
      if (target.kind === "unit") score -= target.type === "villager" ? 4 : 2;
      if (target.kind === "building" && target.type === "townCenter") score += 2;
      if (target === entity.lastAttacker) score -= 4;
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }
    return best;
  }

  attackReach(unit, target) {
    const edge = target.kind === "building" ? target.size * 0.48 : target.radius;
    return this.getUnitStats(unit).range + edge + unit.radius * 0.6;
  }

  isInAttackRange(unit, target) {
    if (!target?.alive) return false;
    return dist(unit, target) <= this.attackReach(unit, target);
  }

  faceTarget(unit, target) {
    unit.facing = Math.atan2(target.y - unit.y, target.x - unit.x);
  }

  performAttack(unit, target) {
    if (!target?.alive || unit.cooldown > 0) return;
    const stats = this.getUnitStats(unit);
    const def = UNIT_DEFS[unit.type];
    unit.cooldown = def.attackSpeed;
    unit.attackAnimation = 0.36;
    this.faceTarget(unit, target);
    if (def.projectile) {
      const source = { x: unit.x, y: unit.y - 0.2 };
      this.projectiles.push({
        id: this.nextId("p"),
        type: def.projectile,
        x: source.x,
        y: source.y,
        targetId: target.id,
        targetX: target.x,
        targetY: target.y,
        owner: unit.owner,
        damage: stats.damage,
        speed: def.projectile === "boulder" ? 4.2 : 10,
        age: 0,
        shotBy: unit.type,
      });
    } else {
      this.applyDamage(target, stats.damage, unit);
      this.addEffect({ type: "slash", x: (unit.x + target.x) / 2, y: (unit.y + target.y) / 2, duration: 0.28 });
    }
  }

  applyDamage(target, rawDamage, source = null) {
    if (!target?.alive) return;
    let damage = rawDamage;
    if (source?.kind === "unit") {
      const def = UNIT_DEFS[source.type];
      if (def) {
        const targetCategory = target.kind === "building" ? "building" : UNIT_DEFS[target.type].category;
        damage *= def.bonusesVs?.[targetCategory] ?? 1;
        if (target.kind === "building" && !def.bonusesVs?.building) {
          damage *= def.category === "ranged" ? 0.55 : def.category === "siege" ? 1 : 0.82;
        }
      }
    } else if (source?.kind === "building") {
      damage *= 1;
    }
    const armor = target.armor + (target.kind === "building" && this.players[target.owner]?.age >= 2 ? 2 : 0);
    damage = Math.max(1, Math.round(damage - armor));
    target.hp -= damage;
    target.lastDamagedAt = this.time;
    if (source && target.kind === "unit" && target.owner === "player" && target.type !== "villager") {
      target.lastAttacker = source.id ? source : null;
      if (target.task.type === "idle") target.task = { type: "attack", targetId: source.id, path: null, repathTimer: 0.8 };
    }
    if (target.owner === "player") this.alertAttack("player");
    this.addEffect({
      type: target.kind === "building" ? "woodHit" : "hit",
      x: target.x + (Math.random() - 0.5) * 0.35,
      y: target.y + (Math.random() - 0.5) * 0.35,
      amount: damage,
      duration: 0.72,
      critical: damage >= 24,
    });
    if (target.hp <= 0) this.destroyEntity(target, source);
  }

  destroyEntity(entity, source = null) {
    if (!entity.alive) return;
    entity.alive = false;
    entity.deadAt = this.time;
    entity.hp = 0;
    this.selected.delete(entity.id);
    const attackerOwner = source?.owner ?? this.getOtherPlayer(entity.owner).id;
    const victim = this.players[entity.owner];
    const attacker = this.players[attackerOwner];
    if (entity.kind === "unit") {
      victim.stats.lost++;
      attacker.stats.killed++;
      this.addEffect({
        type: "corpse",
        x: entity.x,
        y: entity.y,
        owner: entity.owner,
        unitType: entity.type,
        facing: entity.facing,
        duration: 9,
      });
      this.addEffect({ type: "dust", x: entity.x, y: entity.y, duration: 1.4 });
    } else {
      victim.stats.buildingsLost++;
      this.markBuildingBlocked(entity, false);
      this.blockedDirty = true;
      for (const unit of this.unitList) {
        if (unit.alive && unit.task.type === "build" && unit.task.buildingId === entity.id) {
          unit.task = { type: "idle" };
        }
      }
      this.addEffect({
        type: "collapse",
        x: entity.x,
        y: entity.y,
        size: entity.size,
        duration: 2.4,
      });
      if (entity.owner === "player") this.notify(`${BUILD_DEFS[entity.type].name}已失守！`, "warning");
      else this.notify(`敌军${BUILD_DEFS[entity.type].name}已被摧毁。`, "success");
      if (entity.type === "townCenter") this.queueMatchEnd(entity.owner === "enemy" ? "player" : "enemy");
    }
    if (this.callbacks.onSelectionChanged && this.selected.size === 0) this.callbacks.onSelectionChanged([]);
  }

  queueMatchEnd(winner) {
    if (this.pendingEnd || this.matchEnded) return;
    this.pendingEnd = { winner, at: this.time + 2 };
    this.state = "ending";
  }

  endMatch(winner) {
    if (this.matchEnded) return;
    this.matchEnded = true;
    this.state = "ended";
    this.winner = winner;
    if (this.callbacks.onGameEnd) this.callbacks.onGameEnd(winner);
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      const target = this.entities.get(projectile.targetId);
      if (target?.alive) {
        projectile.targetX = target.x;
        projectile.targetY = target.y;
      }
      const dx = projectile.targetX - projectile.x;
      const dy = projectile.targetY - projectile.y;
      const distance = Math.hypot(dx, dy);
      const step = projectile.speed * dt;
      projectile.age += dt;
      if (distance <= step + 0.08 || projectile.age > 4) {
        if (target?.alive) {
          this.applyDamage(target, projectile.damage, {
            id: projectile.shotBy,
            kind: "unit",
            type: projectile.shotBy,
            owner: projectile.owner,
          });
          this.addEffect({
            type: projectile.type === "boulder" ? "splash" : "arrowHit",
            x: target.x,
            y: target.y,
            duration: projectile.type === "boulder" ? 0.9 : 0.45,
          });
        }
        this.projectiles.splice(i, 1);
        continue;
      }
      projectile.x += (dx / distance) * step;
      projectile.y += (dy / distance) * step;
    }
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.age += dt;
      if (effect.age >= effect.duration) this.effects.splice(i, 1);
    }
  }

  updateUnit(unit, dt) {
    if (!unit.alive) return;
    unit.cooldown = Math.max(0, unit.cooldown - dt);
    unit.attackAnimation = Math.max(0, unit.attackAnimation - dt);
    unit.gatherAnimation = Math.max(0, unit.gatherAnimation - dt);
    const stats = this.getUnitStats(unit);

    if (unit.task.type === "idle") {
      unit.acquisitionTimer -= dt;
      if (unit.acquisitionTimer <= 0 && unit.type !== "villager") {
        unit.acquisitionTimer = 0.55;
        const enemy = this.findEnemyNear(unit, stats.sight * 0.9);
        if (enemy) {
          unit.task = { type: "attack", targetId: enemy.id, path: null, repathTimer: 0.8 };
        }
      }
      return;
    }

    if (unit.task.type === "move") {
      if (this.moveAlongPath(unit, unit.task.path, dt, stats.speed)) {
        unit.task = { type: "idle" };
      }
      return;
    }

    if (unit.task.type === "attackMove") {
      unit.acquisitionTimer -= dt;
      if (unit.acquisitionTimer <= 0) {
        unit.acquisitionTimer = 0.45;
        const enemy = this.findEnemyNear(unit, stats.sight);
        if (enemy) unit.task.targetId = enemy.id;
      }
      const target = this.entities.get(unit.task.targetId);
      if (target?.alive) {
        if (this.isInAttackRange(unit, target)) {
          unit.task.chasing = true;
          this.faceTarget(unit, target);
          unit.path = null;
          this.performAttack(unit, target);
          return;
        }
        unit.task.repathTimer = (unit.task.repathTimer ?? 1.1) - dt;
        if (unit.task.repathTimer <= 0 || !unit.task.path) {
          unit.task.path = this.createPath(unit, target, 3);
          unit.task.repathTimer = 1.2;
          unit.path = unit.task.path;
          unit.pathIndex = 0;
        }
        if (unit.task.path?.length && this.moveAlongPath(unit, unit.task.path, dt, stats.speed)) {
          unit.task.repathTimer = 0;
        }
        return;
      } else {
        unit.task.targetId = null;
      }
      if (!unit.task.path || unit.pathIndex >= unit.task.path.length) {
        unit.task.path = this.createPath(unit, unit.task.dest, 4);
        unit.path = unit.task.path;
        unit.pathIndex = 0;
      }
      if (this.moveAlongPath(unit, unit.task.path, dt, stats.speed)) {
        unit.task = { type: "idle" };
      }
      return;
    }

    if (unit.task.type === "attack") {
      const target = this.entities.get(unit.task.targetId);
      if (!target?.alive) {
        unit.task = { type: "idle" };
        unit.path = null;
        return;
      }
      if (this.isInAttackRange(unit, target)) {
        unit.path = null;
        this.faceTarget(unit, target);
        this.performAttack(unit, target);
        return;
      }
      unit.task.repathTimer -= dt;
      if (unit.task.repathTimer <= 0 || !unit.task.path) {
        unit.task.path = this.createPath(unit, target, 4);
        unit.task.repathTimer = 1.1;
        unit.path = unit.task.path;
        unit.pathIndex = 0;
      }
      if (unit.task.path?.length) {
        this.moveAlongPath(unit, unit.task.path, dt, stats.speed);
      } else {
        unit.task.repathTimer = Math.max(unit.task.repathTimer, 0.35);
      }
      return;
    }

    if (unit.task.type === "gather") {
      this.updateGathering(unit, dt);
      return;
    }

    if (unit.task.type === "build") {
      this.updateBuildingTask(unit, dt);
    }
  }

  updateGathering(unit, dt) {
    const task = unit.task;
    const target = this.getResourceNode(task.nodeId);
    if (!target || this.resourceAmount(target) <= 0) {
      if (unit.carry > 0.05) {
        this.sendWorkerToDropoff(unit);
      } else {
        const replacement = this.findResourceForWorker(unit, task.resourceType);
        if (replacement) this.assignGather([unit.id], replacement.id);
        else unit.task = { type: "idle" };
      }
      return;
    }
    const interactionRange = target.kind === "building" ? target.size * 0.5 + 0.82 : 1.58;
    if (task.phase === "gathering") {
      if (dist(unit, target) > interactionRange) {
        task.phase = "to";
        task.path = this.createPath(unit, target, 2);
        unit.path = task.path;
        unit.pathIndex = 0;
        return;
      }
      this.faceTarget(unit, target);
      unit.gatherAnimation += dt;
      const rate = this.getGatherRate(unit);
      const desired = Math.min(rate * dt, UNIT_DEFS.villager.carry - unit.carry, this.resourceAmount(target));
      if (desired > 0) {
        this.consumeResource(target, desired);
        unit.carry += desired;
        const player = this.players[unit.owner];
        player.stats.gathered[task.resourceType] += desired;
        if (Math.random() < dt * 4) {
          this.addEffect({
            type: "gather",
            x: target.x,
            y: target.y,
            resourceType: task.resourceType,
            duration: 0.7,
          });
        }
      }
      if (unit.carry >= UNIT_DEFS.villager.carry - 0.001 || this.resourceAmount(target) <= 0) {
        this.sendWorkerToDropoff(unit);
      }
      return;
    }

    if (task.phase === "returning") {
      const dropoff = this.entities.get(task.dropoffId);
      if (!dropoff?.alive) {
        this.sendWorkerToDropoff(unit);
        return;
      }
      const arrived = !task.path?.length || this.moveAlongPath(unit, task.path, dt, this.getUnitStats(unit).speed);
      if (arrived && dist(unit, dropoff) <= dropoff.size * 0.76 + 0.45) {
        const carry = Math.max(0, unit.carry);
        if (carry > 0) {
          const player = this.players[unit.owner];
          player.resources[task.resourceType] += carry;
          player.deposits.push({ time: this.time, type: task.resourceType, amount: carry });
          this.addEffect({
            type: "deposit",
            x: dropoff.x,
            y: dropoff.y,
            resourceType: task.resourceType,
            duration: 0.8,
          });
        }
        unit.carry = 0;
        const node = this.getResourceNode(task.nodeId);
        if (node) {
          task.phase = "to";
          task.path = this.createPath(unit, node, 3);
          unit.path = task.path;
          unit.pathIndex = 0;
        } else {
          const replacement = this.findResourceForWorker(unit, task.resourceType);
          if (replacement) this.assignGather([unit.id], replacement.id);
          else unit.task = { type: "idle" };
        }
      }
      return;
    }

    const arrived = !task.path?.length || this.moveAlongPath(unit, task.path, dt, this.getUnitStats(unit).speed);
    if (arrived) {
      if (dist(unit, target) > interactionRange) {
        task.path = this.createPath(unit, target, 3);
        unit.path = task.path;
        unit.pathIndex = 0;
      } else {
        task.phase = "gathering";
      }
    }
  }

  sendWorkerToDropoff(unit) {
    const task = unit.task;
    const dropoff = this.findDropoff(unit.owner, task.resourceType, unit.x, unit.y);
    if (!dropoff) {
      unit.task = { type: "idle" };
      this.notify("没有可接收资源的中军营垒。", "warning");
      return;
    }
    task.phase = "returning";
    task.dropoffId = dropoff.id;
    task.path = this.createPath(unit, dropoff, 3);
    unit.path = task.path;
    unit.pathIndex = 0;
    if (!task.path.length && dist(unit, dropoff) > dropoff.size * 0.78 + 0.5) {
      task.path = this.createPath(unit, dropoff, 6);
      unit.path = task.path;
      unit.pathIndex = 0;
    }
  }

  findResourceForWorker(unit, kind = null) {
    const base = this.getTownCenter(unit.owner);
    const resourceKinds = kind ? [kind] : ["food", "wood", "gold", "stone"];
    let best = null;
    let bestDistance = Infinity;
    for (const resourceKind of resourceKinds) {
      const kinds = {
        food: ["berries"],
        wood: ["tree"],
        gold: ["gold"],
        stone: ["stone"],
      }[resourceKind] ?? [resourceKind];
      const found = nearestResource(this.world, base?.x ?? unit.x, base?.y ?? unit.y, kinds, 30);
      if (!found) continue;
      const d = dist(unit, found);
      if (d < bestDistance) {
        best = found;
        bestDistance = d;
      }
    }
    if (!kind || kind === "food") {
      const farms = this.buildingList.filter(
        (building) =>
          building.alive &&
          building.complete &&
          building.owner === unit.owner &&
          building.type === "farm" &&
          building.foodRemaining > 0,
      );
      for (const farm of farms) {
        const d = dist(unit, farm);
        if (d < bestDistance) {
          best = farm;
          bestDistance = d;
        }
      }
    }
    return best;
  }

  updateBuildingTask(unit, dt) {
    const building = this.entities.get(unit.task.buildingId);
    if (!building?.alive) {
      unit.task = { type: "idle" };
      return;
    }
    const range = building.size * 0.55 + 0.8;
    if (dist(unit, building) > range) {
      if (!unit.task.path?.length) {
        unit.task.path = this.createPath(unit, building, 3);
        unit.path = unit.task.path;
        unit.pathIndex = 0;
      }
      if (unit.task.path?.length) this.moveAlongPath(unit, unit.task.path, dt, this.getUnitStats(unit).speed);
      return;
    }
    this.faceTarget(unit, building);
    unit.gatherAnimation += dt;
    if (!building.complete) {
      const def = BUILD_DEFS[building.type];
      const civBonus = this.players[unit.owner].civId === "song" ? CIVS.song.bonuses.constructionSpeed : 1;
      const rate = (100 / def.buildTime) * civBonus;
      building.constructionProgress = Math.min(100, building.constructionProgress + rate * dt);
      building.hp = Math.min(building.maxHp, Math.max(building.hp, building.maxHp * (0.08 + building.constructionProgress * 0.0092)));
      if (building.constructionProgress >= 100) {
        this.completeBuilding(building);
        unit.task = { type: "idle" };
      }
      if (Math.random() < dt * 5) {
        this.addEffect({
          type: "build",
          x: building.x + (Math.random() - 0.5) * building.size,
          y: building.y + (Math.random() - 0.5) * building.size,
          duration: 0.8,
        });
      }
    } else if (building.hp < building.maxHp && this.players[unit.owner].resources.wood >= 0) {
      const rate = (building.maxHp / BUILD_DEFS[building.type].buildTime) * 0.6;
      building.hp = Math.min(building.maxHp, building.hp + rate * dt);
      if (Math.random() < dt * 2) this.addEffect({ type: "build", x: building.x, y: building.y, duration: 0.6 });
      if (building.hp >= building.maxHp) unit.task = { type: "idle" };
    } else {
      unit.task = { type: "idle" };
    }
  }

  updateBuilding(building, dt) {
    if (!building.alive) return;
    building.attackAnimation = Math.max(0, building.attackAnimation - dt);
    building.cooldown = Math.max(0, building.cooldown - dt);
    const def = BUILD_DEFS[building.type];

    if (building.research) {
      building.research.progress += (dt / building.research.time) * 100;
      if (building.research.progress >= 100) this.completeResearch(building);
    }

    if (building.complete && building.productionQueue.length > 0) {
      const type = building.productionQueue[0];
      const unitDef = UNIT_DEFS[type];
      let trainTime = unitDef.buildTime;
      const player = this.players[building.owner];
      if (player.age >= 1) trainTime *= 0.9;
      if (building.type === "archeryRange" && type === "archer") trainTime *= 0.78;
      if (building.owner === "enemy") trainTime *= this.aiTuning.trainDelay;
      building.productionProgress += (dt / trainTime) * 100;
      if (building.productionProgress >= 100) {
        building.productionProgress = 0;
        building.productionQueue.shift();
        const spawn = this.findUnitSpawn(building);
        const spawned = this.spawnUnit(type, building.owner, spawn.x, spawn.y, { completed: true });
        const rally = this.rallyPoints.get(building.id);
        if (rally && (rally.x !== spawn.x || rally.y !== spawn.y)) {
          const path = this.createPath(spawned, rally, 4);
          spawned.task = {
            type: type === "villager" ? "move" : "attackMove",
            dest: rally,
            path,
            targetId: null,
            repathingTimer: 1,
          };
          spawned.path = path;
          spawned.pathIndex = 0;
        }
        if (building.owner === "player") this.notify(`${unitDef.name}已列阵待命。`, "success");
      }
    }

    if (building.complete && def.attackDamage) {
      building.cooldown -= dt;
      if (building.cooldown <= 0) {
        const target = this.findEnemyNear(building, def.attackRange);
        if (target) {
          building.cooldown = def.attackSpeed;
          building.attackAnimation = 0.4;
          const stats = this.getUnitStats({
            type: "archer",
            owner: building.owner,
            armor: 0,
          });
          const damage = def.attackDamage + (this.players[building.owner].age >= 2 ? 2 : 0);
          this.projectiles.push({
            id: this.nextId("p"),
            type: "towerArrow",
            x: building.x,
            y: building.y - building.size * 0.35,
            targetId: target.id,
            targetX: target.x,
            targetY: target.y,
            owner: building.owner,
            damage: Math.max(damage, stats.damage - 2),
            speed: 9,
            age: 0,
            shotBy: "tower",
          });
        }
      }
    }
  }

  completeResearch(building) {
    const research = building.research;
    if (!research) return;
    const player = this.players[building.owner];
    if (research.kind === "age") {
      player.age = Math.max(player.age, research.targetAge);
      if (building.owner === "player") {
        this.notify(`时代演进完成：${AGES[player.age].title}。`, "success");
        this.addEffect({ type: "ageBurst", x: building.x, y: building.y, duration: 2.5 });
      }
    } else {
      player.techs[research.id] = true;
      if (building.owner === "player") this.notify(`研究完成：${research.name}。`, "success");
    }
    building.research = null;
  }

  findUnitSpawn(building) {
    const def = BUILD_DEFS[building.type];
    if (this.blockedDirty) this.rebuildBlockGrid();
    const center = { x: Math.round(building.x), y: Math.round(building.y) };
    const candidates = [];
    for (let radius = def.size + 1; radius < def.size + 6; radius++) {
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue;
          const x = center.x + ox;
          const y = center.y + oy;
          if (x < 0 || y < 0 || x >= this.world.size || y >= this.world.size) continue;
          if (!this.blocked[y * this.world.size + x] && terrainAt(this.world, x, y) !== TERRAIN.WATER) {
            candidates.push({ x, y, d: Math.abs(ox) + Math.abs(oy) });
          }
        }
      }
      if (candidates.length) break;
    }
    candidates.sort((a, b) => a.d - b.d);
    const spot = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))] ?? center;
    return { x: spot.x, y: spot.y };
  }

  separateUnits() {
    const units = this.unitList.filter((unit) => unit.alive);
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDistance = (a.radius + b.radius) * 0.8;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDistance * minDistance) continue;
        const d = Math.sqrt(d2) || 0.001;
        const push = (minDistance - d) * 0.16;
        const nx = dx / d;
        const ny = dy / d;
        this.nudgeUnit(a, -nx * push, -ny * push);
        this.nudgeUnit(b, nx * push, ny * push);
      }
    }
  }

  nudgeUnit(unit, dx, dy) {
    const nx = clamp(unit.x + dx, 1, this.world.size - 2);
    const ny = clamp(unit.y + dy, 1, this.world.size - 2);
    const tileX = Math.round(nx);
    const tileY = Math.round(ny);
    if (this.blocked[tileY * this.world.size + tileX]) return;
    unit.x = nx;
    unit.y = ny;
  }

  updateVisibility(force = false) {
    if (!force && this.fogTimer > 0) return;
    this.fogTimer = 0.2;
    this.visibility.fill(0);
    const size = this.world.size;
    for (const entity of this.entities.values()) {
      if (!entity.alive || entity.owner !== "player") continue;
      const radius = Math.ceil(entity.sight);
      const cx = Math.round(entity.x);
      const cy = Math.round(entity.y);
      for (let y = cy - radius; y <= cy + radius; y++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          if (Math.hypot(x - cx, y - cy) > entity.sight + 0.3) continue;
          const index = y * size + x;
          this.visibility[index] = 1;
          this.explored[index] = 1;
        }
      }
    }
    this.fogVersion++;
  }

  isVisibleAt(x, y) {
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    if (gx < 0 || gy < 0 || gx >= this.world.size || gy >= this.world.size) return false;
    return this.visibility[gy * this.world.size + gx] === 1;
  }

  isExploredAt(x, y) {
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    if (gx < 0 || gy < 0 || gx >= this.world.size || gy >= this.world.size) return false;
    return this.explored[gy * this.world.size + gx] === 1;
  }

  updateRates(dt) {
    this.rateTimer += dt;
    if (this.rateTimer < 0.5) return;
    this.rateTimer = 0;
    const cutoff = this.time - 20;
    const deposits = this.player.deposits;
    while (deposits.length && deposits[0].time < cutoff) deposits.shift();
    const elapsed = Math.max(1, Math.min(20, this.time));
    this.rates = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const deposit of deposits) this.rates[deposit.type] += (deposit.amount / elapsed) * 60;
  }

  updateAI(dt) {
    if (this.options.attract || this.matchEnded) return;
    const ai = this.enemy;
    ai.nextThink -= dt;
    if (ai.nextThink > 0) return;
    ai.nextThink = this.aiTuning.think;
    if (this.state !== "playing") return;

    const ownUnits = this.unitList.filter((unit) => unit.alive && unit.owner === "enemy");
    const ownBuildings = this.buildingList.filter((building) => building.alive && building.owner === "enemy");
    const townCenter = ownBuildings.find((building) => building.type === "townCenter" && building.complete);
    if (!townCenter) return;
    const villagers = ownUnits.filter((unit) => unit.type === "villager");
    const military = ownUnits.filter((unit) => UNIT_DEFS[unit.type].category !== "worker");
    const idleVillagers = villagers.filter((unit) => unit.task.type === "idle");
    const nextAgeCost = ai.age < AGES.length - 1 ? AGES[ai.age + 1].cost : null;
    const ageReserveStartsAt = ai.age === 0 ? 45 : 240;
    const savingForAge = Boolean(
      nextAgeCost &&
      !townCenter.research &&
      this.time > ageReserveStartsAt,
    );

    this.aiRebalanceGatherers(villagers, savingForAge);
    for (const villager of idleVillagers) this.aiAssignGather(villager);

    if (townCenter && !townCenter.research && ai.age < 2 && this.time > 90 + ai.age * 80) {
      const targetAge = ai.age + 1;
      const cost = AGES[targetAge].cost;
      if (this.canSpend("enemy", cost)) {
        this.spend("enemy", cost);
        townCenter.research = {
          kind: "age",
          targetAge,
          time: AGES[targetAge].time,
          progress: 0,
          name: AGES[targetAge].title,
        };
      }
    }

    const villagerTarget = savingForAge ? (ai.age === 0 ? 8 : 11) : 14;
    if (townCenter.productionQueue.length === 0 && villagers.length < villagerTarget) {
      this.startTraining(townCenter.id, "villager", { silent: true });
    }

    const pop = this.getPopulation("enemy");
    if (pop.capacity - pop.population <= 2) this.aiBuild("house", ownBuildings, villagers, townCenter);

    if (!ownBuildings.some((building) => building.type === "lumberCamp")) {
      const wood = nearestResource(this.world, townCenter.x, townCenter.y, ["tree"], 30);
      if (wood) this.aiBuild("lumberCamp", ownBuildings, villagers, townCenter, 0.72, wood);
    }
    if (!ownBuildings.some((building) => building.type === "mill")) {
      const food = nearestResource(this.world, townCenter.x, townCenter.y, ["berries"], 30);
      if (food) this.aiBuild("mill", ownBuildings, villagers, townCenter, 0.62, food);
    }
    if (!ownBuildings.some((building) => building.type === "miningCamp")) {
      const gold = nearestResource(this.world, townCenter.x, townCenter.y, ["gold"], 30);
      if (gold) this.aiBuild("miningCamp", ownBuildings, villagers, townCenter, 0.58, gold);
    }

    if (!ownBuildings.some((building) => building.type === "barracks" && building.complete)) {
      this.aiBuild("barracks", ownBuildings, villagers, townCenter);
    }
    if (ownBuildings.filter((building) => building.type === "barracks" && building.complete).length < 2 && this.time > 120) {
      this.aiBuild("barracks", ownBuildings, villagers, townCenter);
    }
    if (ai.age >= 1 && !ownBuildings.some((building) => building.type === "stable" && building.complete)) {
      this.aiBuild("stable", ownBuildings, villagers, townCenter);
    }
    if (ai.age >= 1 && !ownBuildings.some((building) => building.type === "blacksmith" && building.complete)) {
      this.aiBuild("blacksmith", ownBuildings, villagers, townCenter);
    }
    if (ai.age >= 1 && this.time > 110 && !ownBuildings.some((building) => building.type === "tower")) {
      this.aiBuild("tower", ownBuildings, villagers, townCenter);
    }
    if (this.time > 190 && ownBuildings.filter((building) => building.type === "farm").length < 3) {
      this.aiBuild("farm", ownBuildings, villagers, townCenter);
    }
    if (ownBuildings.filter((building) => building.type === "house").length < 5 && pop.capacity < 55) {
      this.aiBuild("house", ownBuildings, villagers, townCenter, 0.25);
    }

    for (const building of ownBuildings) {
      if (!building.complete) continue;
      if (building.type === "blacksmith" && !building.research && ai.age >= 1) {
        const techId = !ai.techs.armor ? "armor" : !ai.techs.weapons ? "weapons" : !ai.techs.bowcraft ? "bowcraft" : null;
        if (techId && this.canSpend("enemy", TECH_DEFS[techId].cost)) this.startResearch(building.id, techId);
      }
    }

    if (!savingForAge || (ai.age >= 1 && military.length < this.aiTuning.attackThreshold)) {
      const productionBuildings = ownBuildings.filter((building) => building.complete && BUILD_DEFS[building.type].train);
      for (const building of productionBuildings) {
        if (building.productionQueue.length > 0) continue;
        const choices = [];
        if (building.type === "barracks") {
          choices.push("spearman", "archer");
          if (ai.age >= 2) choices.push("catapult");
        }
        if (building.type === "stable") choices.push("cavalry");
        if (!choices.length) continue;
        const unitType = choices[Math.floor(Math.random() * choices.length)];
        if (this.getPopulation("enemy").population >= this.getPopulation("enemy").capacity - 1) break;
        if (this.startTraining(building.id, unitType, { silent: true })) break;
      }
    }

    if (this.time >= ai.nextAttackAt && military.length >= this.aiTuning.attackThreshold) {
      const idleArmy = military.filter((unit) => unit.task.type === "idle" || unit.task.type === "move");
      if (idleArmy.length >= Math.min(this.aiTuning.attackThreshold, Math.floor(military.length * 0.65))) {
        const target = this.getTownCenter("player") ?? this.unitList.find((unit) => unit.alive && unit.owner === "player");
        if (target) {
          this.aiAttackWith(idleArmy, target);
          ai.nextAttackAt = this.time + this.aiTuning.attackInterval;
        }
      }
    }
  }

  aiAssignGather(villager) {
    const owned = this.unitList.filter((unit) => unit.alive && unit.owner === "enemy" && unit.type === "villager");
    const counts = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const unit of owned) {
      if (unit.task.type === "gather") counts[unit.task.resourceType]++;
    }
    let kind = "food";
    const nextAgeCost = this.enemy.age < AGES.length - 1 ? AGES[this.enemy.age + 1].cost : null;
    const reserveAge = Boolean(
      nextAgeCost &&
      this.time > (this.enemy.age === 0 ? 45 : 240) &&
      !this.canSpend("enemy", nextAgeCost),
    );
    if (reserveAge) {
      const foodNeed = Math.max(0, nextAgeCost.food - this.enemy.resources.food);
      const goldNeed = Math.max(0, nextAgeCost.gold - this.enemy.resources.gold);
      const foodTarget = goldNeed > 0 ? Math.ceil(owned.length * 0.62) : owned.length;
      const goldTarget = Math.max(2, owned.length - foodTarget);
      if (foodNeed > 0 && counts.food < foodTarget) kind = "food";
      else if (goldNeed > 0 && counts.gold < goldTarget) kind = "gold";
      else kind = "wood";
    } else {
      const ratios = { food: 0.38, wood: 0.34, gold: 0.2, stone: 0.08 };
      let largestGap = -Infinity;
      for (const key of RESOURCE_KEYS) {
        const gap = ratios[key] * Math.max(1, owned.length) - counts[key];
        if (gap > largestGap) {
          largestGap = gap;
          kind = key;
        }
      }
    }
    const replacement = this.findResourceForWorker(villager, kind);
    if (replacement) this.assignGather([villager.id], replacement.id);
    else if (kind === "food") {
      const fallback = this.findResourceForWorker(villager, "wood");
      if (fallback) this.assignGather([villager.id], fallback.id);
    }
  }

  aiRebalanceGatherers(villagers, savingForAge) {
    if (!savingForAge || villagers.length < 4) return;
    const player = this.enemy;
    const nextCost = player.age < AGES.length - 1 ? AGES[player.age + 1].cost : null;
    if (!nextCost) return;
    const deficitFood = Math.max(0, nextCost.food - player.resources.food);
    const deficitGold = Math.max(0, nextCost.gold - player.resources.gold);
    if (deficitFood <= 0 && deficitGold <= 0) return;
    const counts = { food: 0, wood: 0, gold: 0, stone: 0 };
    for (const unit of villagers) {
      if (unit.task.type === "gather") counts[unit.task.resourceType]++;
    }
    const desiredFood = Math.ceil(villagers.length * 0.62);
    const desiredGold = Math.max(2, Math.floor(villagers.length * 0.28));
    const foodGap = deficitFood > 0 ? desiredFood - counts.food : 0;
    const goldGap = deficitGold > 0 ? desiredGold - counts.gold : 0;
    const desiredKind = foodGap >= goldGap && foodGap > 0 ? "food" : goldGap > 0 ? "gold" : null;
    if (!desiredKind) return;
    const candidates = villagers
      .filter(
        (unit) =>
          unit.task.type === "gather" &&
          unit.task.resourceType !== desiredKind &&
          unit.task.phase !== "returning" &&
          unit.carry < 2,
      )
      .sort((a, b) => a.carry - b.carry)
      .slice(0, 2);
    for (const candidate of candidates) {
      candidate.task = { type: "idle" };
      candidate.path = null;
      this.aiAssignGather(candidate);
    }
  }

  aiBuild(type, ownBuildings, villagers, townCenter, chance = 1, nearPoint = null) {
    const ai = this.enemy;
    if (this.time < ai.aiBuildCooldown || Math.random() > chance) return false;
    const def = BUILD_DEFS[type];
    if (!def || !villagers.length) return false;
    if ((def.unlockAge ?? 0) > ai.age) return false;
    if (!this.canSpend("enemy", def.cost)) return false;
    const incomplete = this.buildingList.some(
      (building) => building.alive && building.owner === "enemy" && !building.complete && building.type === type,
    );
    if (incomplete) return false;

    const baseX = nearPoint?.x ?? townCenter.anchorX + townCenter.size / 2;
    const baseY = nearPoint?.y ?? townCenter.anchorY + townCenter.size / 2;
    const spots = [];
    for (let radius = nearPoint ? 2 : 4; radius <= (nearPoint ? 9 : 12); radius += nearPoint ? 0.7 : 1.4) {
      for (let angleIndex = 0; angleIndex < 16; angleIndex++) {
        const angle = (angleIndex / 16) * Math.PI * 2 + (type === "house" ? 0.18 : 0);
        const ax = Math.round(baseX + Math.cos(angle) * radius - (def.size - 1) / 2);
        const ay = Math.round(baseY + Math.sin(angle) * radius - (def.size - 1) / 2);
        const validity = this.getPlacementValidity(type, ax, ay, "enemy");
        if (validity.valid) spots.push({ ax, ay, d: radius });
      }
      if (spots.length >= 3) break;
    }
    if (!spots.length) return false;
    spots.sort((a, b) => a.d - b.d);
    const spot = spots[Math.floor(Math.random() * Math.min(3, spots.length))];
    if (!this.spend("enemy", def.cost)) return false;
    const building = this.spawnBuilding(type, "enemy", spot.ax, spot.ay, { complete: false });

    const workers = [...villagers].sort((a, b) => {
      const aIdle = a.task.type === "idle" ? 0 : 1;
      const bIdle = b.task.type === "idle" ? 0 : 1;
      if (aIdle !== bIdle) return aIdle - bIdle;
      return dist(a, building) - dist(b, building);
    });
    for (const worker of workers.slice(0, def.size >= 3 ? 2 : 1)) {
      const path = this.createPath(worker, building, 3);
      worker.task = { type: "build", buildingId: building.id, path };
      worker.path = path;
      worker.pathIndex = 0;
    }
    ai.aiBuildCooldown = this.time + 4;
    return true;
  }

  aiAttackWith(units, target) {
    const pivot = units[0];
    units.forEach((unit, index) => {
      const offset = this.formationOffset(index, units.length);
      const dest = { x: target.x + offset.x, y: target.y + offset.y };
      unit.task = {
        type: "attackMove",
        dest,
        path: this.createPath(unit, dest, 4),
        targetId: null,
        repathTimer: 0.8,
      };
      unit.path = unit.task.path;
      unit.pathIndex = 0;
    });
    if (pivot) {
      this.addEffect({ type: "enemyAttack", x: pivot.x, y: pivot.y, duration: 1 });
    }
  }

  updateObjectives() {
    const player = this.player;
    const ownUnits = this.unitList.filter((unit) => unit.alive && unit.owner === "player");
    const military = ownUnits.filter((unit) => UNIT_DEFS[unit.type].category !== "worker");
    const houses = this.buildingList.filter((building) => building.alive && building.owner === "player" && building.type === "house" && building.complete);
    const barracks = this.buildingList.filter((building) => building.alive && building.owner === "player" && building.type === "barracks" && building.complete);
    const enemyTc = this.getTownCenter("enemy");
    const objectives = [
      { id: "pop", text: "人口达到 10", done: this.getPopulation("player").population >= 10 },
      { id: "house", text: "营造一座民居", done: houses.length >= 1 },
      { id: "army", text: "兵营建成，军队达到 6 人", done: barracks.length > 0 && military.length >= 6 },
      { id: "victory", text: "摧毁敌军城镇中心", done: !enemyTc },
    ];
    this.objectives = objectives;
    const cache = objectives.map((objective) => `${objective.id}:${objective.done}`).join("|") + `:${player.age}`;
    if (cache !== this.objectiveCache) {
      this.objectiveCache = cache;
      if (this.callbacks.onObjectivesChanged) this.callbacks.onObjectivesChanged(objectives);
    }
  }

  getPlayerRates() {
    return this.rates;
  }

  getUnitsByOwner(owner, type = null) {
    return this.unitList.filter((unit) => unit.alive && unit.owner === owner && (!type || unit.type === type));
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  pause() {
    if (this.state === "playing") this.state = "paused";
  }

  resume() {
    if (this.state === "paused") this.state = "playing";
  }

  update(dtRaw) {
    if (this.state === "paused" || this.state === "ended") return;
    if (this.state === "menu") return;
    if (this.state !== "playing" && this.state !== "ending") return;
    const dt = Math.min(0.08, Math.max(0, dtRaw)) * this.speed;
    if (dt <= 0) return;
    this.time += dt;
    this.fogTimer -= dt;

    if (this.blockedDirty) this.rebuildBlockGrid();
    for (const entity of this.entities.values()) {
      if (!entity.alive) continue;
      if (entity.kind === "unit") this.updateUnit(entity, dt);
      else this.updateBuilding(entity, dt);
    }
    this.updateProjectiles(dt);
    this.separateUnits();
    this.updateEffects(dt);
    this.updateVisibility(false);
    this.updateRates(dt);
    if (this.state === "playing") this.updateAI(dt);
    this.updateObjectives();

    if (this.pendingEnd && this.time >= this.pendingEnd.at) this.endMatch(this.pendingEnd.winner);

    // Keep memory and render lists tidy after combat.
    if (Math.floor(this.time * 4) % 12 === 0) this.pruneDeadLists();
  }

  pruneDeadLists() {
    this.unitList = this.unitList.filter((unit) => unit.alive);
    this.buildingList = this.buildingList.filter((building) => building.alive);
    for (const [id, entity] of this.entities) {
      if (!entity.alive && this.time - entity.deadAt > 8) this.entities.delete(id);
    }
    for (const projectiles of [this.projectiles]) {
      if (projectiles.length > 220) projectiles.splice(0, projectiles.length - 220);
    }
  }
}
