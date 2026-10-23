import "./styles.css";
import { AudioDirector } from "./audio.js";
import { CIVS } from "./data.js";
import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";

const app = document.getElementById("app");
const canvas = document.getElementById("gameCanvas");
const minimap = document.getElementById("minimap");
const placementCanvas = document.getElementById("placementCanvas");
const audio = new AudioDirector();

let game = new Game({
  attract: true,
  playerCiv: "song",
  difficulty: "normal",
});
let currentCiv = "song";
let currentDifficulty = "normal";
let ui = null;
let renderer = null;
let lastFrame = performance.now();
let mouseX = window.innerWidth * 0.5;
let mouseY = window.innerHeight * 0.5;
let pointerInsideCanvas = false;
let selection = { active: false, startX: 0, startY: 0, currentX: 0, currentY: 0, additive: false };
let dragging = null;
let pressedKeys = new Set();
let lastClickedUnit = { id: null, at: 0 };

function makeCallbacks() {
  return {
    onNotice(message, type) {
      ui?.addAlert(message, type);
    },
    onSelectionChanged() {
      if (ui) {
        ui.selectionSignature = "";
        ui.commandSignature = "";
        ui.refreshSelection(true);
        ui.refreshCommands(true);
      }
    },
    onUnderAttack() {
      ui?.underAttack();
    },
    onGameEnd(winner) {
      if (ui) {
        ui.elements.pauseOverlay.classList.add("hidden");
        ui.elements.codexOverlay.classList.add("hidden");
        ui.showEnd(winner, game);
      }
    },
  };
}

function createGame(civ, difficulty, attract = false) {
  return new Game({
    playerCiv: civ,
    difficulty,
    attract,
    callbacks: makeCallbacks(),
  });
}

ui = new UI({
  audio,
  callbacks: {
    onStart(civ, difficulty) {
      startGame(civ, difficulty);
    },
    onRestart() {
      startGame(currentCiv, currentDifficulty);
    },
    onReturnMenu() {
      returnToMenu();
    },
    onPlacementMode(active) {
      ui.setCommandCursor(active ? "placement" : null, mouseX, mouseY);
      if (active) audio.play("command");
    },
    onAttackMoveMode(active) {
      ui.setCommandCursor(active ? "attackMove" : null, mouseX, mouseY);
      if (active) audio.play("command");
    },
  },
});

renderer = new Renderer(canvas, minimap, placementCanvas, game);
ui.game = game;
ui.renderer = renderer;
ui.hideLoading();

function startGame(civ = ui.playerCiv, difficulty = ui.difficulty) {
  currentCiv = civ;
  currentDifficulty = difficulty;
  pressedKeys.clear();
  dragging = null;
  selection.active = false;
  game = createGame(civ, difficulty, false);
  renderer.setGame(game);
  ui.setGame(game, renderer);
  game.pause();
  renderer.focusOnBase(true);
  document.getElementById("cinematic-bars").classList.add("active");
  ui.showBattleIntro(CIVS[civ], () => {
    game.resume();
    document.getElementById("cinematic-bars").classList.remove("active");
  });
  window.setTimeout(() => {
    if (game.state !== "ended") {
      ui.showTutorial("乡勇右键浆果丛采集食物。木材与石料决定你的第一座民居和兵营。", "郾城军令");
    }
  }, 6200);
}

function returnToMenu() {
  pressedKeys.clear();
  dragging = null;
  selection.active = false;
  document.getElementById("cinematic-bars").classList.remove("active");
  game = createGame("song", "normal", true);
  renderer.setGame(game);
  ui.game = game;
  ui.renderer = renderer;
  ui.showMenu();
  game.state = "menu";
  renderer.centerOn(28, 28, true);
}

function isOverlayOpen() {
  return ui.hasOverlayOpen() || game.state === "menu" || game.matchEnded;
}

function screenPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function worldPosition(event) {
  const point = screenPosition(event);
  return renderer.screenToWorld(point.x, point.y);
}

function setAttackMode(enabled) {
  game.commandMode = enabled ? "attackMove" : null;
  ui.setCommandCursor(enabled ? "attackMove" : null, mouseX, mouseY);
}

function cancelCommands() {
  if (game.placement) {
    game.cancelPlacement();
    ui.setCommandCursor(null);
    return true;
  }
  if (game.commandMode) {
    setAttackMode(false);
    return true;
  }
  return false;
}

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerenter", () => {
  pointerInsideCanvas = true;
});
canvas.addEventListener("pointerleave", () => {
  pointerInsideCanvas = false;
  renderer.hoveredId = null;
});

canvas.addEventListener("pointerdown", (event) => {
  if (!game || game.state === "menu" || game.matchEnded || ui.hasOverlayOpen()) return;
  const point = screenPosition(event);
  const world = worldPosition(event);
  mouseX = point.x;
  mouseY = point.y;
  if (event.button === 1) {
    event.preventDefault();
    dragging = { mode: "camera", x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button === 2) {
    event.preventDefault();
    if (cancelCommands()) {
      audio.play("click");
      return;
    }
    if (game.issueContextOrder(world.x, world.y, event.shiftKey)) audio.play("command");
    return;
  }
  if (event.button !== 0) return;
  if (game.placement) {
    if (game.confirmPlacement()) {
      audio.play("build");
      ui.setCommandCursor(null);
      ui.showTutorial("营造已经开工。可继续命令乡勇建造，或将不同乡勇派往不同工地。", "营造有方");
    }
    return;
  }
  if (game.commandMode === "attackMove") {
    const units = game.getSelectedUnits();
    if (units.length) {
      const target = game.getInteractionAt(world.x, world.y);
      if (target && target.owner && target.owner !== "player") {
        game.issueAttack(units.map((unit) => unit.id), target.id);
      } else {
        game.issueMove(units.map((unit) => unit.id), world, true);
      }
      audio.play("command");
    }
    setAttackMode(false);
    return;
  }
  selection = {
    active: false,
    startX: point.x,
    startY: point.y,
    currentX: point.x,
    currentY: point.y,
    additive: event.shiftKey,
    pending: true,
    pointerId: event.pointerId,
  };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  const point = screenPosition(event);
  const world = renderer.screenToWorld(point.x, point.y);
  const dx = event.clientX - (dragging?.x ?? event.clientX);
  const dy = event.clientY - (dragging?.y ?? event.clientY);
  mouseX = event.clientX;
  mouseY = event.clientY;
  game.mouseWorld = world;
  if (game.placement) game.updatePlacementAt(world.x, world.y);
  if (game.commandMode) ui.moveCommandCursor(event.clientX, event.clientY);

  if (dragging?.mode === "camera") {
    renderer.panByPixels(dx, dy);
    dragging.x = event.clientX;
    dragging.y = event.clientY;
  } else if (selection.pending || selection.active) {
    selection.currentX = point.x;
    selection.currentY = point.y;
    if (!selection.active && Math.hypot(selection.currentX - selection.startX, selection.currentY - selection.startY) > 6) {
      selection.active = true;
    }
  }

  const interaction = game.getInteractionAt(world.x, world.y);
  renderer.hoveredId = interaction?.id ?? null;
});

canvas.addEventListener("pointerup", (event) => {
  if (event.button === 1) {
    dragging = null;
    return;
  }
  if (event.button !== 0 || (!selection.pending && !selection.active)) return;
  const additive = selection.additive;
  const wasActive = selection.active;
  const startX = selection.startX;
  const startY = selection.startY;
  const currentX = selection.currentX;
  const currentY = selection.currentY;
  selection.active = false;
  selection.pending = false;
  selection.additive = false;

  if (wasActive) {
    const minX = Math.min(startX, currentX);
    const maxX = Math.max(startX, currentX);
    const minY = Math.min(startY, currentY);
    const maxY = Math.max(startY, currentY);
    const ids = game.unitList
      .filter((unit) => {
        if (!unit.alive || unit.owner !== "player" || !game.isVisibleAt(unit.x, unit.y)) return false;
        const screen = renderer.worldToScreen(unit.x, unit.y);
        return screen.x >= minX - 10 && screen.x <= maxX + 10 && screen.y >= minY - 10 && screen.y <= maxY + 10;
      })
      .map((unit) => unit.id);
    const building = game.buildingList.find((candidate) => {
      if (!candidate.alive || candidate.owner !== "player") return false;
      const screen = renderer.worldToScreen(candidate.x, candidate.y);
      return screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY;
    });
    if (!ids.length && building) ids.push(building.id);
    if (ids.length) {
      game.select(ids, additive);
      audio.play("select");
    } else if (!additive) {
      game.clearSelection();
    }
    return;
  }

  const point = screenPosition(event);
  const world = renderer.screenToWorld(point.x, point.y);
  const entity = game.getEntityAtWorld(world.x, world.y, true);
  if (entity?.owner === "player") {
    const now = performance.now();
    const isDoubleClick = entity.kind === "unit" && lastClickedUnit.id === entity.id && now - lastClickedUnit.at < 330;
    lastClickedUnit = { id: entity.id, at: now };
    if (isDoubleClick) {
      const ids = game.unitList
        .filter(
          (unit) =>
            unit.alive &&
            unit.owner === "player" &&
            unit.type === entity.type &&
            game.isVisibleAt(unit.x, unit.y),
        )
        .map((unit) => unit.id);
      game.select(ids, additive);
    } else if (additive && game.selected.has(entity.id)) {
      const ids = [...game.selected].filter((id) => id !== entity.id);
      game.select(ids);
    } else {
      game.select([entity.id], additive);
    }
    audio.play("select");
  } else if (!additive) {
    game.clearSelection();
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    if (isOverlayOpen()) return;
    event.preventDefault();
    const point = screenPosition(event);
    renderer.zoomAt(event.deltaY, point.x, point.y);
  },
  { passive: false },
);

let minimapDragging = false;
function minimapWorld(event) {
  const rect = minimap.getBoundingClientRect();
  const localX = ((event.clientX - rect.left) / rect.width) * minimap.width;
  const localY = ((event.clientY - rect.top) / rect.height) * minimap.height;
  return renderer.minimapToWorld(localX, localY);
}

minimap.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || isOverlayOpen()) return;
  event.preventDefault();
  minimapDragging = true;
  minimap.setPointerCapture(event.pointerId);
  const world = minimapWorld(event);
  renderer.centerOn(world.x, world.y, true);
  audio.play("click");
});
minimap.addEventListener("pointermove", (event) => {
  if (!minimapDragging) return;
  event.preventDefault();
  const world = minimapWorld(event);
  renderer.centerOn(world.x, world.y, true);
});
minimap.addEventListener("pointerup", (event) => {
  if (!minimapDragging) return;
  minimapDragging = false;
  if (minimap.hasPointerCapture(event.pointerId)) minimap.releasePointerCapture(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (game.commandMode) ui.moveCommandCursor(event.clientX, event.clientY);
});

window.addEventListener("keydown", (event) => {
  const key = event.key;
  const lower = key.toLowerCase();
  if (key === "F1") {
    event.preventDefault();
    if (ui.codexOpen) ui.closeCodex();
    else ui.openCodex(ui.codexPage);
    return;
  }
  if (ui.codexOpen) {
    if (key === "Escape") ui.closeCodex();
    return;
  }
  if (ui.elements.menu && !ui.elements.menu.classList.contains("hidden")) {
    if (key === "Enter") startGame(ui.playerCiv, ui.difficulty);
    return;
  }
  if (ui.elements.endOverlay && !ui.elements.endOverlay.classList.contains("hidden")) {
    if (key === "Enter") startGame(currentCiv, currentDifficulty);
    return;
  }
  if (key === "Escape") {
    event.preventDefault();
    if (cancelCommands()) return;
    ui.togglePause();
    return;
  }
  if (ui.pauseOpen || game.state === "menu" || game.matchEnded) return;
  if (event.ctrlKey && /^[1-9]$/.test(key)) {
    event.preventDefault();
    game.assignControlGroup(Number(key));
    return;
  }
  if (/^[1-9]$/.test(key)) {
    if (game.recallControlGroup(Number(key), event.shiftKey)) audio.play("select");
    return;
  }
  if (event.ctrlKey && lower === "a") {
    event.preventDefault();
    if (game.selectAllArmy()) audio.play("select");
    return;
  }
  if (key === " ") {
    event.preventDefault();
    const tc = game.getTownCenter("player");
    if (tc) {
      game.select([tc.id]);
      renderer.centerOn(tc.x, tc.y, false);
      audio.play("select");
    }
    return;
  }
  if (key === ".") {
    event.preventDefault();
    if (game.selectNextIdleVillager()) audio.play("select");
    return;
  }
  if (game.placement) {
    if (lower === "a" || lower === "s") event.preventDefault();
    return;
  }
  if (lower === "a") {
    event.preventDefault();
    const units = game.getSelectedUnits();
    if (units.length) setAttackMode(true);
    return;
  }
  if (lower === "s") {
    event.preventDefault();
    if (game.getSelectedUnits().length) {
      game.stopUnits();
      audio.play("command");
    }
    return;
  }
  if (ui.executeHotkey(lower)) {
    event.preventDefault();
    return;
  }
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(lower)) {
    pressedKeys.add(lower);
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  pressedKeys.delete(event.key.toLowerCase());
});
window.addEventListener("blur", () => {
  pressedKeys.clear();
  dragging = null;
});
window.addEventListener("resize", () => renderer.resize());
document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.state === "playing") ui.togglePause(true);
});

function updateCameraInput(dt) {
  if (game.state !== "playing" || ui.hasOverlayOpen()) return;
  const speed = 650 * dt;
  let dx = 0;
  let dy = 0;
  if (pressedKeys.has("a") || pressedKeys.has("arrowleft")) dx -= speed;
  if (pressedKeys.has("d") || pressedKeys.has("arrowright")) dx += speed;
  if (pressedKeys.has("w") || pressedKeys.has("arrowup")) dy -= speed;
  if (pressedKeys.has("s") || pressedKeys.has("arrowdown")) dy += speed;
  if (pointerInsideCanvas && !ui.pauseOpen && !ui.codexOpen) {
    const edge = 7;
    if (mouseX < edge) dx -= speed;
    if (mouseX > window.innerWidth - edge) dx += speed;
    if (mouseY < edge) dy -= speed;
    if (mouseY > window.innerHeight - edge) dy += speed;
  }
  if (dx || dy) renderer.panByPixels(dx, dy);
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  updateCameraInput(dt);
  game.update(dt);
  renderer.render(dt);
  renderer.drawOverlay(selection);
  if (game.state !== "menu") ui.update(dt);
  requestAnimationFrame(frame);
}

// A small visual guard lets the loading seal finish before the battlefield appears.
requestAnimationFrame(frame);

// Exposed for automated smoke tests and for curious tinkerers in DevTools.
window.Shanhe = {
  get game() {
    return game;
  },
  get renderer() {
    return renderer;
  },
  get ui() {
    return ui;
  },
  startGame,
  returnToMenu,
};
