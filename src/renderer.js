import { BUILD_DEFS, CIVS, UNIT_DEFS } from "./data.js";
import { MAP_SIZE, TERRAIN, TILE_H, TILE_W } from "./world.js";
import { canvasRoundRect, clamp, hash2 } from "./utils.js";

const TEAM_COLORS = {
  player: { main: "#ab4637", bright: "#e06d52", dark: "#5b211a", metal: "#d4b66c" },
  enemy: { main: "#376b75", bright: "#70a7ab", dark: "#193a43", metal: "#cfc38c" },
};

const TERRAIN_PALETTES = {
  [TERRAIN.GRASS]: ["#68754f", "#718057", "#64724c", "#758259"],
  [TERRAIN.FOREST]: ["#536244", "#586644", "#4e5b3e"],
  [TERRAIN.WATER]: ["#345d61", "#2d565d", "#396b6d"],
  [TERRAIN.BRIDGE]: ["#6e5a40", "#766247", "#604f3a"],
  [TERRAIN.ROAD]: ["#827259", "#897a60", "#796b54"],
  [TERRAIN.MEADOW]: ["#7b8558", "#828c5d", "#768052"],
  [TERRAIN.ROCK]: ["#62665b", "#6a6d61", "#5b6055"],
};

export class Renderer {
  constructor(gameCanvas, minimapCanvas, overlayCanvas, game) {
    this.canvas = gameCanvas;
    this.ctx = gameCanvas.getContext("2d", { alpha: false });
    this.minimap = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext("2d");
    this.overlay = overlayCanvas;
    this.overlayCtx = overlayCanvas.getContext("2d");
    this.game = game;
    this.width = 1;
    this.height = 1;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.camera = { x: 28, y: 28, zoom: 0.9 };
    this.time = 0;
    this.minimapTimer = 0;
    this.hoveredId = null;
    this.animatingCamera = null;
    this.resize();
  }

  setGame(game) {
    this.game = game;
    if (game.state !== "menu") this.camera.zoom = 1.02;
    this.focusOnBase(true);
  }

  colorFor(owner) {
    const civ = CIVS[this.game.players[owner]?.civId];
    if (!civ) return TEAM_COLORS[owner] ?? TEAM_COLORS.player;
    return {
      main: civ.color,
      bright: civ.colorBright,
      dark: civ.colorDark,
      metal: civ.trim,
    };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    const overlayRect = this.overlay.getBoundingClientRect();
    this.overlay.width = Math.round(overlayRect.width * this.dpr);
    this.overlay.height = Math.round(overlayRect.height * this.dpr);
    this.overlay.style.width = `${overlayRect.width}px`;
    this.overlay.style.height = `${overlayRect.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.overlayCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const minimapRect = this.minimap.getBoundingClientRect();
    this.minimap.width = Math.max(160, Math.round(minimapRect.width));
    this.minimap.height = Math.max(120, Math.round(minimapRect.height));
    this.clampCamera();
  }

  worldToScreen(x, y) {
    const { zoom } = this.camera;
    const dx = x - this.camera.x;
    const dy = y - this.camera.y;
    return {
      x: this.width / 2 + (dx - dy) * (TILE_W / 2) * zoom,
      y: this.height / 2 + (dx + dy) * (TILE_H / 2) * zoom,
    };
  }

  screenToWorld(screenX, screenY) {
    const { zoom } = this.camera;
    const a = (screenX - this.width / 2) / ((TILE_W / 2) * zoom);
    const b = (screenY - this.height / 2) / ((TILE_H / 2) * zoom);
    return {
      x: this.camera.x + (a + b) / 2,
      y: this.camera.y + (b - a) / 2,
    };
  }

  panByPixels(dx, dy) {
    const { zoom } = this.camera;
    const worldDX = (dx / ((TILE_W / 2) * zoom) + dy / ((TILE_H / 2) * zoom)) / 2;
    const worldDY = (dy / ((TILE_H / 2) * zoom) - dx / ((TILE_W / 2) * zoom)) / 2;
    this.camera.x -= worldDX;
    this.camera.y -= worldDY;
    this.clampCamera();
  }

  zoomAt(delta, screenX, screenY) {
    const before = this.screenToWorld(screenX, screenY);
    const factor = delta > 0 ? 0.9 : 1.1;
    this.camera.zoom = clamp(this.camera.zoom * factor, 0.62, 1.48);
    const after = this.screenToWorld(screenX, screenY);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.clampCamera();
  }

  clampCamera() {
    this.camera.x = clamp(this.camera.x, 2, MAP_SIZE - 2);
    this.camera.y = clamp(this.camera.y, 2, MAP_SIZE - 2);
  }

  centerOn(x, y, instant = true) {
    if (instant) {
      this.camera.x = x;
      this.camera.y = y;
      this.animatingCamera = null;
    } else {
      this.animatingCamera = {
        fromX: this.camera.x,
        fromY: this.camera.y,
        toX: x,
        toY: y,
        age: 0,
        duration: 0.38,
      };
    }
  }

  focusOnBase(instant = false) {
    const tc = this.game.getTownCenter("player");
    if (tc) this.centerOn(tc.x, tc.y, instant);
    else {
      const base = this.game.world.bases.find((entry) => entry.owner === "player");
      this.centerOn(base?.x ?? 12, base?.y ?? 28, instant);
    }
  }

  getCameraViewPolygon() {
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(this.width, 0),
      this.screenToWorld(this.width, this.height),
      this.screenToWorld(0, this.height),
    ];
    return corners;
  }

  updateCamera(dt) {
    if (this.game.state === "menu") {
      this.camera.x = 28 + Math.sin(this.time * 0.055) * 3.4;
      this.camera.y = 28 + Math.cos(this.time * 0.043) * 1.6;
      this.camera.zoom = 0.73 + Math.sin(this.time * 0.03) * 0.012;
      return;
    }
    if (!this.animatingCamera) return;
    const animation = this.animatingCamera;
    animation.age += dt;
    const t = clamp(animation.age / animation.duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.x = animation.fromX + (animation.toX - animation.fromX) * eased;
    this.camera.y = animation.fromY + (animation.toY - animation.fromY) * eased;
    if (t >= 1) this.animatingCamera = null;
  }

  render(dt) {
    this.time += dt;
    this.updateCamera(dt);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackdrop(ctx);
    this.drawTerrain(ctx);
    this.drawWorldActors(ctx);
    this.drawProjectiles(ctx);
    this.drawEffects(ctx);
    this.drawFog(ctx);
    this.drawSelectionRings(ctx);
    this.drawRallyPoints(ctx);
    this.drawScreenAtmosphere(ctx);
    this.minimapTimer -= dt;
    if (this.minimapTimer <= 0) {
      this.drawMinimap();
      this.minimapTimer = 0.16;
    }
  }

  drawBackdrop(ctx) {
    const gradient = ctx.createRadialGradient(this.width * 0.5, this.height * 0.4, 40, this.width * 0.5, this.height * 0.5, this.width * 0.8);
    gradient.addColorStop(0, "#39412e");
    gradient.addColorStop(0.58, "#252c21");
    gradient.addColorStop(1, "#11150f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.globalAlpha = 0.26;
    ctx.strokeStyle = "#919b79";
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const y = this.height * (0.22 + i * 0.09);
      ctx.beginPath();
      for (let x = -20; x <= this.width + 20; x += 22) {
        const wave = Math.sin(x * 0.008 + i * 1.4 + this.time * 0.02) * (8 + i * 1.2);
        if (x === -20) ctx.moveTo(x, y + wave);
        else ctx.lineTo(x, y + wave);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  tileCenter(x, y) {
    return this.worldToScreen(x, y);
  }

  terrainYOffset(x, y) {
    const idx = y * MAP_SIZE + x;
    return (this.game.world.elevation[idx] ?? 0) * 2.2 * this.camera.zoom;
  }

  drawDiamond(ctx, centerX, centerY, rx, ry, fill, stroke = null) {
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - ry);
    ctx.lineTo(centerX + rx, centerY);
    ctx.lineTo(centerX, centerY + ry);
    ctx.lineTo(centerX - rx, centerY);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  isScreenOnMap(sx, sy, margin = 120) {
    return sx > -margin && sx < this.width + margin && sy > -margin && sy < this.height + margin;
  }

  drawTerrain(ctx) {
    const { zoom } = this.camera;
    const rx = (TILE_W / 2) * zoom + 0.55;
    const ry = (TILE_H / 2) * zoom + 0.4;
    for (let sum = 0; sum <= (MAP_SIZE - 1) * 2; sum++) {
      const startY = Math.max(0, sum - MAP_SIZE + 1);
      const endY = Math.min(MAP_SIZE - 1, sum);
      for (let y = startY; y <= endY; y++) {
        const x = sum - y;
        const center = this.tileCenter(x, y);
        if (!this.isScreenOnMap(center.x, center.y, 80)) continue;
        const idx = y * MAP_SIZE + x;
        const terrain = this.game.world.terrain[idx];
        const palette = TERRAIN_PALETTES[terrain] ?? TERRAIN_PALETTES[TERRAIN.GRASS];
        const variant = Math.floor(hash2(x, y, 81) * palette.length);
        const centerY = center.y + this.terrainYOffset(x, y);

        if (terrain === TERRAIN.WATER) {
          const waterGradient = ctx.createLinearGradient(center.x, centerY - ry, center.x, centerY + ry);
          waterGradient.addColorStop(0, palette[variant % palette.length]);
          waterGradient.addColorStop(1, "#274b54");
          this.drawDiamond(ctx, center.x, centerY, rx + 0.3, ry + 0.3, waterGradient);
          if (hash2(x, y, 19) > 0.38) {
            const wave = Math.sin(this.time * 1.2 + x * 0.8 + y * 0.35) * 2.2 * zoom;
            ctx.strokeStyle = "rgba(151, 188, 181, 0.18)";
            ctx.lineWidth = Math.max(0.65, zoom);
            ctx.beginPath();
            ctx.moveTo(center.x - rx * 0.45, centerY + wave);
            ctx.quadraticCurveTo(center.x - 3, centerY - 2 + wave, center.x + rx * 0.37, centerY + wave);
            ctx.stroke();
          }
        } else {
          this.drawDiamond(ctx, center.x, centerY, rx, ry, palette[variant]);
          if (terrain === TERRAIN.BRIDGE) {
            this.drawBridgeTile(ctx, center.x, centerY, rx, ry);
          } else if (terrain === TERRAIN.ROAD) {
            ctx.strokeStyle = "rgba(48, 42, 31, 0.16)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(center.x - rx * 0.58, centerY);
            ctx.lineTo(center.x, centerY + ry * 0.55);
            ctx.lineTo(center.x + rx * 0.47, centerY - ry * 0.12);
            ctx.stroke();
          }
        }

        if (this.camera.zoom > 0.72 && terrain !== TERRAIN.WATER && terrain !== TERRAIN.BRIDGE) {
          this.drawTileDetails(ctx, x, y, center.x, centerY, rx, ry, terrain);
        }
      }
    }
  }

  drawTileDetails(ctx, x, y, cx, cy, rx, ry, terrain) {
    const seed = 1423;
    const count = hash2(x, y, seed) > 0.61 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const hx = hash2(x, y, seed + i * 13);
      const hy = hash2(x, y, seed + i * 31);
      const px = cx + (hx - 0.5) * rx * 0.9;
      const py = cy + (hy - 0.5) * ry * 0.8;
      ctx.strokeStyle = terrain === TERRAIN.ROCK ? "rgba(195, 198, 178, 0.15)" : "rgba(38, 54, 31, 0.32)";
      ctx.lineWidth = Math.max(0.65, this.camera.zoom * 0.8);
      ctx.beginPath();
      if (terrain === TERRAIN.ROCK) {
        ctx.moveTo(px - 2, py + 2);
        ctx.lineTo(px, py - 3);
        ctx.lineTo(px + 3, py + 1);
      } else {
        ctx.moveTo(px, py + 2);
        ctx.lineTo(px - 1.5, py - 2);
        ctx.moveTo(px, py + 2);
        ctx.lineTo(px + 2, py - 1);
      }
      ctx.stroke();
    }
    if (terrain === TERRAIN.MEADOW && hash2(x, y, 55) > 0.83) {
      ctx.fillStyle = "rgba(206, 190, 117, 0.32)";
      ctx.beginPath();
      ctx.arc(cx + (hash2(x, y, 12) - 0.5) * rx * 0.7, cy + (hash2(x, y, 21) - 0.5) * ry * 0.6, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawBridgeTile(ctx, cx, cy, rx, ry) {
    ctx.save();
    this.drawDiamond(ctx, cx, cy, rx, ry, null);
    ctx.clip();
    ctx.strokeStyle = "rgba(43, 31, 21, 0.48)";
    ctx.lineWidth = Math.max(0.7, this.camera.zoom);
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(cx - rx + i * (rx / 3), cy);
      ctx.lineTo(cx + i * (rx / 3), cy + ry);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(204, 177, 121, 0.18)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - rx * 0.84, cy);
    ctx.lineTo(cx, cy - ry * 0.7);
    ctx.lineTo(cx + rx * 0.84, cy);
    ctx.stroke();
  }

  drawWorldActors(ctx) {
    const renderables = [];
    const game = this.game;
    for (const node of game.world.nodes) {
      if (!game.isExploredAt(node.x, node.y)) continue;
      const p = this.worldToScreen(node.x, node.y);
      if (!this.isScreenOnMap(p.x, p.y, 100)) continue;
      renderables.push({ kind: "resource", depth: node.y - 0.1, node, screen: p });
    }
    for (const entity of game.entities.values()) {
      if (!entity.alive) continue;
      if (entity.owner !== "player" && !game.isVisibleAt(entity.x, entity.y)) {
        if (!(entity.kind === "building" && game.isExploredAt(entity.x, entity.y))) continue;
      }
      const p = this.worldToScreen(entity.x, entity.y);
      if (!this.isScreenOnMap(p.x, p.y, entity.kind === "building" ? 180 : 100)) continue;
      renderables.push({
        kind: entity.kind,
        depth: entity.kind === "building" ? entity.anchorY + entity.size - 0.1 : entity.y + entity.radius * 0.4,
        entity,
        screen: p,
      });
    }
    renderables.sort((a, b) => a.depth - b.depth || (a.screen.x - b.screen.x));
    for (const item of renderables) {
      if (item.kind === "resource") this.drawResourceNode(ctx, item.node, item.screen);
      else if (item.kind === "building") this.drawBuilding(ctx, item.entity, item.screen);
      else this.drawUnit(ctx, item.entity, item.screen);
    }
  }

  drawResourceNode(ctx, node, screen) {
    if (!node.alive || node.amount <= 0) {
      if (node.kind === "tree" && this.game.isExploredAt(node.x, node.y)) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = "#493b29";
        ctx.beginPath();
        ctx.ellipse(screen.x, screen.y + 4, 5 * this.camera.zoom, 2.4 * this.camera.zoom, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    const scale = this.camera.zoom * (0.92 + Math.min(0.12, Math.max(0, node.variant) * 0.025));
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.scale(scale, scale);
    if (node.kind === "tree") this.drawTree(ctx, node);
    else if (node.kind === "berries") this.drawBerries(ctx, node);
    else if (node.kind === "gold") this.drawGold(ctx, node);
    else if (node.kind === "stone") this.drawStone(ctx, node);
    ctx.restore();
    if (this.hoveredId === node.id) this.drawResourceHighlight(ctx, screen, scale);
  }

  drawTree(ctx, node) {
    const sway = Math.sin(this.time * 1.3 + node.x * 0.8 + node.y * 0.4) * 1.2;
    ctx.fillStyle = "rgba(16, 23, 13, 0.34)";
    ctx.beginPath();
    ctx.ellipse(3, 5, 22, 8, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#493924";
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.quadraticCurveTo(-1, -9, sway, -22);
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-1, -10);
    ctx.lineTo(-8, -19);
    ctx.moveTo(0, -14);
    ctx.lineTo(8, -22);
    ctx.stroke();
    if (node.variant % 2 === 0) {
      const leafColors = ["#3d5138", "#4b5c3e", "#566348", "#46573c"];
      const blobs = [
        [-11, -25, 12],
        [8, -27, 13],
        [0, -37, 14],
        [-5, -17, 10],
        [13, -16, 9],
      ];
      blobs.forEach(([x, y, r], index) => {
        ctx.fillStyle = leafColors[(node.variant + index) % leafColors.length];
        ctx.beginPath();
        ctx.arc(x + sway * 0.4, y, r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = "rgba(183, 187, 131, 0.13)";
      ctx.beginPath();
      ctx.arc(-7 + sway * 0.4, -41, 7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "#344d39";
      for (let i = 0; i < 3; i++) {
        const y = -11 - i * 9;
        const half = 14 - i * 3;
        ctx.beginPath();
        ctx.moveTo(sway, y - 14);
        ctx.lineTo(half, y + 4);
        ctx.lineTo(-half, y + 4);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(143, 159, 108, 0.17)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sway, -38);
      ctx.lineTo(4, -15);
      ctx.stroke();
    }
  }

  drawBerries(ctx, node) {
    ctx.fillStyle = "rgba(24, 27, 18, 0.3)";
    ctx.beginPath();
    ctx.ellipse(1, 5, 18, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4f643d";
    const blobs = [
      [-10, -5, 10],
      [3, -9, 12],
      [12, -3, 8],
      [-2, 1, 9],
    ];
    blobs.forEach(([x, y, r], index) => {
      ctx.fillStyle = index % 2 ? "#516845" : "#465d3d";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
    const colors = ["#b75c4f", "#d18458", "#8d3d3f"];
    for (let i = 0; i < 12; i++) {
      const x = (hash2(node.x, node.y, i * 7) - 0.5) * 27;
      const y = -9 + (hash2(node.x, node.y, i * 13) - 0.5) * 18;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawGold(ctx, node) {
    ctx.fillStyle = "rgba(24, 24, 17, 0.34)";
    ctx.beginPath();
    ctx.ellipse(2, 4, 17, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#666456";
    ctx.beginPath();
    ctx.moveTo(-17, 2);
    ctx.lineTo(-8, -7);
    ctx.lineTo(1, -2);
    ctx.lineTo(12, -8);
    ctx.lineTo(18, 3);
    ctx.lineTo(3, 8);
    ctx.closePath();
    ctx.fill();
    const crystals = [
      [-8, -7, 5, 12],
      [1, -3, 4, 9],
      [9, -7, 4, 11],
      [-1, -13, 3, 8],
    ];
    for (const [x, y, w, h] of crystals) {
      const gradient = ctx.createLinearGradient(x - w, y, x + w, y + h);
      gradient.addColorStop(0, "#f1d477");
      gradient.addColorStop(0.55, "#b99544");
      gradient.addColorStop(1, "#6f592c");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h * 0.45);
      ctx.lineTo(x + w * 0.3, y + h);
      ctx.lineTo(x - w, y + h * 0.58);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawStone(ctx, node) {
    ctx.fillStyle = "rgba(19, 23, 18, 0.34)";
    ctx.beginPath();
    ctx.ellipse(2, 4, 18, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    const rocks = [
      [-10, -2, 12, 12, "#77796d"],
      [3, -7, 13, 13, "#8a8b7d"],
      [12, 1, 8, 9, "#676a61"],
    ];
    for (const [x, y, rx, ry, color] of rocks) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - rx, y + 2);
      ctx.lineTo(x - rx * 0.45, y - ry * 0.7);
      ctx.lineTo(x + rx * 0.28, y - ry);
      ctx.lineTo(x + rx, y - ry * 0.1);
      ctx.lineTo(x + rx * 0.52, y + ry * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(217, 218, 198, 0.16)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x - rx * 0.4, y - ry * 0.55);
      ctx.lineTo(x + rx * 0.28, y - ry * 0.82);
      ctx.lineTo(x + rx * 0.78, y - ry * 0.2);
      ctx.stroke();
    }
  }

  drawResourceHighlight(ctx, screen, scale) {
    ctx.save();
    ctx.strokeStyle = "rgba(230, 201, 121, 0.82)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y + 4 * scale, 18 * scale, 8 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawBuilding(ctx, building, screen) {
    const def = BUILD_DEFS[building.type];
    const scale = this.camera.zoom;
    const color = this.colorFor(building.owner);
    const alpha = building.complete ? (building.owner !== "player" && !this.game.isVisibleAt(building.x, building.y) ? 0.65 : 1) : 0.5 + building.constructionProgress * 0.005;
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.globalAlpha = alpha;
    this.drawBuildingShadow(ctx, def.size * scale);
    if (building.type === "farm") this.drawFarm(ctx, building, scale, color);
    else {
      const base = def.size * scale;
      if (building.type === "townCenter") this.drawTownCenter(ctx, building, base, scale, color);
      else if (building.type === "house") this.drawHouse(ctx, building, base, scale, color);
      else if (building.type === "tower") this.drawTower(ctx, building, base, scale, color);
      else if (building.type === "barracks") this.drawBarracks(ctx, building, base, scale, color);
      else if (building.type === "archeryRange") this.drawArcheryRange(ctx, building, base, scale, color);
      else if (building.type === "stable") this.drawStable(ctx, building, base, scale, color);
      else if (building.type === "blacksmith") this.drawBlacksmith(ctx, building, base, scale, color);
      else this.drawCamp(ctx, building, base, scale, color);
    }
    if (!building.complete) this.drawConstructionScaffolding(ctx, building, def.size * scale, scale);
    ctx.restore();
    this.drawBuildingOverhead(ctx, building, screen, color);
  }

  drawBuildingShadow(ctx, size) {
    ctx.fillStyle = "rgba(8, 12, 9, 0.34)";
    ctx.beginPath();
    ctx.ellipse(size * 1.8, size * 5.6, size * 20, size * 6.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawIsoBase(ctx, scale, width, depth, height, colors) {
    const w = width * scale;
    const h = depth * scale;
    const wall = height * scale;
    const topY = -wall;
    ctx.fillStyle = colors.left;
    ctx.beginPath();
    ctx.moveTo(-w / 2, topY);
    ctx.lineTo(0, topY + h / 2);
    ctx.lineTo(0, h / 2);
    ctx.lineTo(-w / 2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colors.right;
    ctx.beginPath();
    ctx.moveTo(0, topY + h / 2);
    ctx.lineTo(w / 2, topY);
    ctx.lineTo(w / 2, 0);
    ctx.lineTo(0, h / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colors.top;
    ctx.beginPath();
    ctx.moveTo(0, topY - h / 2);
    ctx.lineTo(w / 2, topY);
    ctx.lineTo(0, topY + h / 2);
    ctx.lineTo(-w / 2, topY);
    ctx.closePath();
    ctx.fill();
    return { w, h, wall, topY };
  }

  drawChineseRoof(ctx, width, y, height, scale, color = "#3e4033", trim = "#735c3a") {
    const w = width * scale;
    const rh = height * scale;
    ctx.fillStyle = "#2b241b";
    ctx.beginPath();
    ctx.moveTo(-w * 0.56, y + 3);
    ctx.quadraticCurveTo(-w * 0.43, y - rh * 0.16, -w * 0.32, y - rh * 0.66);
    ctx.quadraticCurveTo(0, y - rh * 1.04, w * 0.32, y - rh * 0.66);
    ctx.quadraticCurveTo(w * 0.43, y - rh * 0.16, w * 0.56, y + 3);
    ctx.quadraticCurveTo(w * 0.29, y - 1, 0, y + rh * 0.14);
    ctx.quadraticCurveTo(-w * 0.29, y - 1, -w * 0.56, y + 3);
    ctx.closePath();
    ctx.fill();
    const gradient = ctx.createLinearGradient(0, y - rh, 0, y + 3);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.65, "#4c4a36");
    gradient.addColorStop(1, "#343329");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-w * 0.53, y);
    ctx.quadraticCurveTo(-w * 0.38, y - rh * 0.12, -w * 0.27, y - rh * 0.63);
    ctx.quadraticCurveTo(0, y - rh * 0.95, w * 0.27, y - rh * 0.63);
    ctx.quadraticCurveTo(w * 0.38, y - rh * 0.12, w * 0.53, y);
    ctx.quadraticCurveTo(0, y + rh * 0.24, -w * 0.53, y);
    ctx.fill();
    ctx.strokeStyle = trim;
    ctx.lineWidth = Math.max(1, scale * 1.15);
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, y - rh * 0.01);
    ctx.quadraticCurveTo(0, y + rh * 0.22, w * 0.5, y - rh * 0.01);
    ctx.moveTo(-w * 0.25, y - rh * 0.63);
    ctx.quadraticCurveTo(0, y - rh * 0.94, w * 0.25, y - rh * 0.63);
    ctx.moveTo(0, y - rh * 0.91);
    ctx.lineTo(0, y - rh * 0.58);
    ctx.stroke();
    ctx.strokeStyle = "rgba(19, 19, 15, 0.28)";
    ctx.lineWidth = 0.7;
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      ctx.beginPath();
      ctx.moveTo(i * w * 0.065, y - rh * (0.86 - Math.abs(i) * 0.09));
      ctx.quadraticCurveTo(i * w * 0.12, y - rh * 0.3, i * w * 0.28, y - 1);
      ctx.stroke();
    }
  }

  drawTownCenter(ctx, building, base, scale, color) {
    const width = 64 * scale;
    const depth = 30 * scale;
    const wall = 25 * scale;
    const platform = this.drawIsoBase(ctx, scale, 76, 36, 9, {
      left: "#686044",
      right: "#7b7051",
      top: "#938766",
    });
    ctx.fillStyle = "#4a3a28";
    ctx.fillRect(-width / 2, -wall - 4, width, wall);
    ctx.fillStyle = "#8f7d59";
    ctx.beginPath();
    ctx.moveTo(-width / 2, -wall - 4);
    ctx.lineTo(-width * 0.28, -wall + depth * 0.24);
    ctx.lineTo(-width * 0.28, depth * 0.24);
    ctx.lineTo(-width / 2, -4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#a18d64";
    ctx.beginPath();
    ctx.moveTo(width * 0.28, -wall + depth * 0.24);
    ctx.lineTo(width / 2, -wall - 4);
    ctx.lineTo(width / 2, -4);
    ctx.lineTo(width * 0.28, depth * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#6c5034";
    ctx.fillRect(-width * 0.34, -wall - 2, width * 0.68, wall - 1);
    ctx.strokeStyle = "#3b2b20";
    ctx.lineWidth = Math.max(1, 1.6 * scale);
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * width * 0.14, -wall - 2);
      ctx.lineTo(i * width * 0.14, -3);
      ctx.stroke();
    }
    ctx.fillStyle = "#39291f";
    ctx.fillRect(-width * 0.12, -wall + 6 * scale, width * 0.24, wall - 7 * scale);
    ctx.strokeStyle = "#c0a15e";
    ctx.lineWidth = 1;
    ctx.strokeRect(-width * 0.07, -wall + 10 * scale, width * 0.14, wall - 12 * scale);
    this.drawChineseRoof(ctx, 62, -wall - 6, 20, scale, "#46483a", "#826b44");
    ctx.fillStyle = "#6e5738";
    ctx.fillRect(-width * 0.26, -wall - 28 * scale, width * 0.52, 19 * scale);
    ctx.fillStyle = "#847052";
    ctx.fillRect(-width * 0.22, -wall - 27 * scale, width * 0.44, 17 * scale);
    this.drawChineseRoof(ctx, 48, -wall - 29 * scale, 16, scale, "#3e453a", "#ad8d56");
    ctx.fillStyle = color.main;
    ctx.fillRect(-width * 0.39, -wall - 9 * scale, width * 0.08, wall + 15 * scale);
    ctx.fillStyle = color.bright;
    ctx.beginPath();
    ctx.moveTo(-width * 0.36, -wall - 9 * scale);
    ctx.lineTo(-width * 0.17, -wall - 5 * scale);
    ctx.lineTo(-width * 0.36, -wall + 1 * scale);
    ctx.closePath();
    ctx.fill();
    this.drawAgeBanners(ctx, building, width, scale, color);
  }

  drawAgeBanners(ctx, building, width, scale, color) {
    const age = this.game.players[building.owner]?.age ?? 0;
    for (let i = 0; i < Math.min(3, age + 1); i++) {
      ctx.strokeStyle = "#35291d";
      ctx.lineWidth = Math.max(1, scale);
      ctx.beginPath();
      ctx.moveTo(width * 0.28 + i * 8 * scale, 0);
      ctx.lineTo(width * 0.28 + i * 8 * scale, -28 * scale - i * 4);
      ctx.stroke();
      ctx.fillStyle = i === 0 ? color.main : i === 1 ? "#bc9a55" : "#76693f";
      ctx.beginPath();
      ctx.moveTo(width * 0.28 + i * 8 * scale, -28 * scale - i * 4);
      ctx.lineTo(width * 0.28 + 10 * scale + i * 8 * scale, -25 * scale - i * 4);
      ctx.lineTo(width * 0.28 + i * 8 * scale, -20 * scale - i * 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawHouse(ctx, building, base, scale, color) {
    const wallH = 22 * scale;
    this.drawIsoBase(ctx, scale, 50, 24, 21, {
      left: "#786348",
      right: "#8b7655",
      top: "#a18d68",
    });
    ctx.fillStyle = "#a38e6b";
    ctx.fillRect(-20 * scale, -wallH, 40 * scale, wallH);
    ctx.fillStyle = "#74583c";
    ctx.fillRect(-13 * scale, -wallH + 7 * scale, 10 * scale, 14 * scale);
    ctx.fillStyle = "#3f3124";
    ctx.fillRect(-3 * scale, -wallH + 10 * scale, 7 * scale, 11 * scale);
    ctx.strokeStyle = "#5d4932";
    ctx.lineWidth = Math.max(1, scale * 1.1);
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 9 * scale, -wallH + 1);
      ctx.lineTo(i * 9 * scale, -2 * scale);
      ctx.stroke();
    }
    this.drawChineseRoof(ctx, 45, -wallH - 4, 17, scale, "#474b3a", "#9b7b4b");
    if (building.complete && this.game.isVisibleAt(building.x, building.y)) {
      this.drawChimneySmoke(ctx, 14 * scale, -wallH - 20 * scale, 0.72);
    }
  }

  drawCamp(ctx, building, base, scale, color) {
    const isMill = building.type === "mill";
    this.drawIsoBase(ctx, scale, 55, 27, 15, {
      left: "#67563d",
      right: "#786848",
      top: "#8d7b57",
    });
    if (isMill) {
      ctx.fillStyle = "#7a6443";
      ctx.fillRect(-23 * scale, -20 * scale, 46 * scale, 20 * scale);
      ctx.fillStyle = "#513e2b";
      ctx.beginPath();
      ctx.moveTo(-29 * scale, -20 * scale);
      ctx.lineTo(0, -39 * scale);
      ctx.lineTo(29 * scale, -20 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ba9f6a";
      ctx.beginPath();
      ctx.arc(0, -20 * scale, 11 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5a432c";
      ctx.lineWidth = 1.5 * scale;
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2 + this.time * 0.25;
        ctx.beginPath();
        ctx.moveTo(0, -20 * scale);
        ctx.lineTo(Math.cos(angle) * 15 * scale, -20 * scale + Math.sin(angle) * 15 * scale);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = "#9a8261";
      ctx.beginPath();
      ctx.moveTo(-22 * scale, -4 * scale);
      ctx.lineTo(-17 * scale, -28 * scale);
      ctx.lineTo(0, -42 * scale);
      ctx.lineTo(18 * scale, -27 * scale);
      ctx.lineTo(23 * scale, -3 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#56432c";
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.moveTo(0, -40 * scale);
      ctx.lineTo(0, -3 * scale);
      ctx.moveTo(-17 * scale, -27 * scale);
      ctx.lineTo(0, -32 * scale);
      ctx.lineTo(18 * scale, -25 * scale);
      ctx.stroke();
      ctx.fillStyle = color.main;
      ctx.fillRect(-2 * scale, -39 * scale, 4 * scale, 12 * scale);
    }
    const logs = isMill ? [] : [
      [-31, -3, 18, 4],
      [-28, -8, 15, 4],
      [24, 0, 13, 4],
    ];
    for (const [x, y, w, h] of logs) {
      ctx.fillStyle = "#4b3824";
      ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
      ctx.strokeStyle = "#97774a";
      ctx.lineWidth = 0.7;
      ctx.strokeRect(x * scale, y * scale, w * scale, h * scale);
    }
  }

  drawBarracks(ctx, building, base, scale, color) {
    const width = 64 * scale;
    const wallH = 28 * scale;
    this.drawIsoBase(ctx, scale, 70, 31, 8, {
      left: "#5b5a48",
      right: "#686752",
      top: "#7e7b62",
    });
    ctx.fillStyle = "#6b5740";
    ctx.fillRect(-width / 2, -wallH, width, wallH);
    ctx.fillStyle = "#8f7a59";
    ctx.fillRect(-width * 0.34, -wallH + 5 * scale, width * 0.68, wallH - 5 * scale);
    ctx.fillStyle = "#4c3727";
    ctx.fillRect(-8 * scale, -wallH + 9 * scale, 16 * scale, wallH - 9 * scale);
    ctx.strokeStyle = "#4c3927";
    ctx.lineWidth = 1.2 * scale;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 8.5 * scale, -wallH + 1);
      ctx.lineTo(i * 8.5 * scale, 0);
      ctx.stroke();
    }
    this.drawChineseRoof(ctx, 68, -wallH - 5, 18, scale, "#46423a", "#9e7945");
    ctx.fillStyle = color.main;
    ctx.fillRect(-width * 0.43, -wallH - 7 * scale, 7 * scale, 41 * scale);
    ctx.fillStyle = color.bright;
    ctx.beginPath();
    ctx.moveTo(-width * 0.43 + 7 * scale, -wallH - 7 * scale);
    ctx.quadraticCurveTo(-width * 0.20, -wallH - 2 * scale, -width * 0.44, -wallH + 6 * scale);
    ctx.closePath();
    ctx.fill();
    this.drawWeaponRack(ctx, 29 * scale, -4 * scale, scale, color);
  }

  drawWeaponRack(ctx, x, y, scale, color) {
    ctx.strokeStyle = "#403022";
    ctx.lineWidth = Math.max(1, scale);
    for (let i = 0; i < 4; i++) {
      const px = x + i * 3.2 * scale;
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px - 1.5 * scale, y - (22 + i % 2 * 4) * scale);
      ctx.stroke();
      ctx.fillStyle = i % 2 ? "#a2a493" : color.metal;
      ctx.beginPath();
      ctx.moveTo(px - 1.5 * scale, y - (22 + i % 2 * 4) * scale);
      ctx.lineTo(px - 4 * scale, y - (17 + i % 2 * 4) * scale);
      ctx.lineTo(px + 1 * scale, y - (17 + i % 2 * 4) * scale);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawArcheryRange(ctx, building, base, scale, color) {
    this.drawIsoBase(ctx, scale, 66, 30, 11, {
      left: "#665a43",
      right: "#75684f",
      top: "#8b7a5c",
    });
    const width = 60 * scale;
    const wallH = 23 * scale;
    ctx.fillStyle = "#937d5b";
    ctx.fillRect(-width / 2, -wallH, width, wallH);
    ctx.fillStyle = "#57422e";
    ctx.fillRect(-width * 0.18, -wallH + 3 * scale, width * 0.36, wallH - 3 * scale);
    ctx.strokeStyle = "#72593a";
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 7.5 * scale, -wallH + 3 * scale);
      ctx.lineTo(i * 7.5 * scale, 0);
      ctx.stroke();
    }
    this.drawChineseRoof(ctx, 61, -wallH - 4, 15, scale, "#414837", "#967545");
    for (let i = 0; i < 3; i++) {
      const tx = (-25 + i * 24) * scale;
      const ty = 1;
      ctx.fillStyle = "#bda477";
      ctx.beginPath();
      ctx.arc(tx, ty, 7.5 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5d482f";
      ctx.lineWidth = 0.8;
      ctx.stroke();
      for (let ring = 0; ring < 2; ring++) {
        ctx.beginPath();
        ctx.arc(tx, ty, (3 + ring * 2.5) * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = color.main;
    ctx.fillRect(-31 * scale, -wallH - 4 * scale, 5 * scale, 27 * scale);
    ctx.fillStyle = color.bright;
    ctx.beginPath();
    ctx.moveTo(-26 * scale, -wallH - 4 * scale);
    ctx.lineTo(-13 * scale, -wallH + 1 * scale);
    ctx.lineTo(-26 * scale, -wallH + 6 * scale);
    ctx.closePath();
    ctx.fill();
  }

  drawStable(ctx, building, base, scale, color) {
    const wallH = 24 * scale;
    this.drawIsoBase(ctx, scale, 70, 31, 9, {
      left: "#554f3f",
      right: "#66604c",
      top: "#786f56",
    });
    ctx.fillStyle = "#756044";
    ctx.fillRect(-32 * scale, -wallH, 64 * scale, wallH);
    ctx.fillStyle = "#4b3525";
    for (let i = -2; i <= 2; i++) {
      ctx.fillRect(i * 13 * scale - 2 * scale, -wallH + 5 * scale, 7 * scale, 18 * scale);
    }
    this.drawChineseRoof(ctx, 60, -wallH - 4, 17, scale, "#3f4034", "#927048");
    ctx.strokeStyle = "#503b27";
    ctx.lineWidth = 1.4 * scale;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 10 * scale, 4 * scale);
      ctx.lineTo(i * 10 * scale, 17 * scale);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-34 * scale, 11 * scale);
    ctx.lineTo(35 * scale, 11 * scale);
    ctx.stroke();
    ctx.fillStyle = color.main;
    ctx.fillRect(30 * scale, -wallH - 8 * scale, 5 * scale, 44 * scale);
    ctx.fillStyle = color.bright;
    ctx.beginPath();
    ctx.moveTo(35 * scale, -wallH - 8 * scale);
    ctx.lineTo(48 * scale, -wallH - 3 * scale);
    ctx.lineTo(35 * scale, -wallH + 3 * scale);
    ctx.closePath();
    ctx.fill();
    this.drawSmallHorseSigil(ctx, 16 * scale, -8 * scale, 0.8 * scale, color);
  }

  drawSmallHorseSigil(ctx, x, y, scale, color) {
    ctx.fillStyle = "#a78d60";
    ctx.beginPath();
    ctx.ellipse(x, y - 8 * scale, 9 * scale, 4 * scale, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 7 * scale, y - 10 * scale);
    ctx.lineTo(x + 11 * scale, y - 17 * scale);
    ctx.lineTo(x + 15 * scale, y - 15 * scale);
    ctx.lineTo(x + 13 * scale, y - 9 * scale);
    ctx.fill();
    ctx.strokeStyle = "#59452e";
    ctx.lineWidth = 1.2 * scale;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 5 * scale, y - 6 * scale);
      ctx.lineTo(x + i * 4 * scale, y);
      ctx.stroke();
    }
  }

  drawBlacksmith(ctx, building, base, scale, color) {
    const wallH = 20 * scale;
    this.drawIsoBase(ctx, scale, 51, 24, 8, {
      left: "#544d41",
      right: "#62594a",
      top: "#756858",
    });
    ctx.fillStyle = "#705844";
    ctx.fillRect(-22 * scale, -wallH, 44 * scale, wallH);
    ctx.fillStyle = "#4c3326";
    ctx.fillRect(-6 * scale, -wallH + 3 * scale, 14 * scale, wallH - 3 * scale);
    const glow = ctx.createRadialGradient(1, -4 * scale, 1, 1, -4 * scale, 20 * scale);
    glow.addColorStop(0, "rgba(244, 148, 58, 0.85)");
    glow.addColorStop(0.5, "rgba(196, 78, 31, 0.32)");
    glow.addColorStop(1, "rgba(92, 35, 18, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(-22 * scale, -26 * scale, 45 * scale, 30 * scale);
    this.drawChineseRoof(ctx, 47, -wallH - 4, 15, scale, "#414137", "#8b6a42");
    ctx.fillStyle = "#6b5b43";
    ctx.fillRect(20 * scale, -wallH - 33 * scale, 8 * scale, 29 * scale);
    ctx.fillStyle = "#33332e";
    ctx.fillRect(19 * scale, -wallH - 36 * scale, 10 * scale, 5 * scale);
    if (building.complete) this.drawChimneySmoke(ctx, 24 * scale, -wallH - 38 * scale, 0.95);
    ctx.fillStyle = color.main;
    ctx.fillRect(-26 * scale, -wallH - 3 * scale, 4 * scale, 25 * scale);
    ctx.fillStyle = color.bright;
    ctx.fillRect(-22 * scale, -wallH - 1 * scale, 9 * scale, 4 * scale);
  }

  drawTower(ctx, building, base, scale, color) {
    this.drawIsoBase(ctx, scale, 44, 21, 12, {
      left: "#5f5e50",
      right: "#71705f",
      top: "#87836f",
    });
    ctx.fillStyle = "#6b6859";
    ctx.fillRect(-15 * scale, -61 * scale, 30 * scale, 59 * scale);
    ctx.fillStyle = "#898571";
    ctx.beginPath();
    ctx.moveTo(-15 * scale, -61 * scale);
    ctx.lineTo(-7 * scale, -51 * scale);
    ctx.lineTo(-7 * scale, 0);
    ctx.lineTo(-15 * scale, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#4c493d";
    for (let i = -1; i <= 1; i += 2) {
      ctx.fillRect(i * 11 * scale - 2 * scale, -54 * scale, 4 * scale, 8 * scale);
    }
    ctx.fillStyle = "#4a3d2d";
    ctx.fillRect(-18 * scale, -68 * scale, 36 * scale, 9 * scale);
    ctx.fillStyle = "#6d5335";
    ctx.fillRect(-13 * scale, -86 * scale, 26 * scale, 19 * scale);
    this.drawChineseRoof(ctx, 40, -84 * scale, 21, scale, "#3f4439", "#9b7a4a");
    ctx.strokeStyle = "#3d2c20";
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.moveTo(0, -103 * scale);
    ctx.lineTo(0, -122 * scale);
    ctx.stroke();
    ctx.fillStyle = color.main;
    ctx.beginPath();
    ctx.moveTo(0, -121 * scale);
    ctx.lineTo(18 * scale, -116 * scale);
    ctx.lineTo(0, -108 * scale);
    ctx.closePath();
    ctx.fill();
  }

  drawFarm(ctx, building, scale, color) {
    const size = BUILD_DEFS.farm.size;
    this.drawDiamond(ctx, 0, 0, size * TILE_W * 0.42 * scale, size * TILE_H * 0.42 * scale, "#786443", "rgba(52, 39, 25, 0.6)");
    ctx.save();
    this.drawDiamond(ctx, 0, 0, size * TILE_W * 0.4 * scale, size * TILE_H * 0.39 * scale, null);
    ctx.clip();
    ctx.fillStyle = "rgba(71, 83, 43, 0.65)";
    for (let i = -5; i <= 5; i++) {
      const px = i * 9 * scale;
      ctx.save();
      ctx.translate(px, 0);
      ctx.rotate(-0.46);
      ctx.fillRect(-2 * scale, -30 * scale, 4 * scale, 60 * scale);
      ctx.fillStyle = i % 2 ? "rgba(130, 142, 69, 0.7)" : "rgba(82, 100, 50, 0.8)";
      ctx.restore();
      ctx.fillStyle = i % 2 ? "rgba(130, 142, 69, 0.7)" : "rgba(82, 100, 50, 0.8)";
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(56, 42, 27, 0.45)";
    ctx.lineWidth = 1.2;
    this.drawDiamond(ctx, 0, 0, size * TILE_W * 0.4 * scale, size * TILE_H * 0.39 * scale, null);
    ctx.stroke();
    ctx.strokeStyle = "#4b3827";
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(25 * scale, 0);
    ctx.lineTo(25 * scale, -24 * scale);
    ctx.moveTo(10 * scale, -17 * scale);
    ctx.lineTo(40 * scale, -17 * scale);
    ctx.stroke();
    ctx.fillStyle = color.main;
    ctx.beginPath();
    ctx.moveTo(26 * scale, -23 * scale);
    ctx.lineTo(39 * scale, -18 * scale);
    ctx.lineTo(26 * scale, -12 * scale);
    ctx.closePath();
    ctx.fill();
  }

  drawConstructionScaffolding(ctx, building, base, scale) {
    const def = BUILD_DEFS[building.type];
    const width = def.size * 28 * scale;
    const height = def.size * 27 * scale;
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.strokeStyle = "rgba(176, 134, 74, 0.65)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.setLineDash([3 * scale, 2 * scale]);
    ctx.beginPath();
    ctx.moveTo(-width / 2, 2);
    ctx.lineTo(-width / 2, -height);
    ctx.moveTo(width / 2, 2);
    ctx.lineTo(width / 2, -height);
    ctx.moveTo(-width / 2, -height * 0.55);
    ctx.lineTo(width / 2, -height * 0.55);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawBuildingOverhead(ctx, building, screen, color) {
    const def = BUILD_DEFS[building.type];
    const scale = this.camera.zoom;
    const top = screen.y - (building.type === "tower" ? 126 : building.type === "townCenter" ? 104 : 68) * scale;
    if (!building.complete) {
      const w = 72 * Math.min(1.25, 0.8 + def.size * 0.12) * scale;
      this.drawProgressBar(ctx, screen.x - w / 2, top, w, 5, building.constructionProgress / 100, "#d1ad63");
      if (building.owner === "player" && this.hoveredId === building.id) {
        ctx.fillStyle = "rgba(15, 12, 9, 0.84)";
        canvasRoundRect(ctx, screen.x - 23, top - 17, 46, 13, 2);
        ctx.fill();
        ctx.fillStyle = "#e1c894";
        ctx.font = `9px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textAlign = "center";
        ctx.fillText(`${Math.floor(building.constructionProgress)}%`, screen.x, top - 7);
      }
    } else if (building.hp < building.maxHp * 0.995 || this.game.selected.has(building.id) || this.hoveredId === building.id) {
      const w = 58 * scale;
      this.drawProgressBar(ctx, screen.x - w / 2, top, w, 5, building.hp / building.maxHp, color.bright);
    }
    if (building.complete && building.productionQueue.length > 0) {
      const iconDef = UNIT_DEFS[building.productionQueue[0]];
      ctx.fillStyle = "rgba(16, 13, 9, 0.78)";
      ctx.strokeStyle = "rgba(215, 179, 103, 0.32)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(screen.x + 36 * scale, top + 4, 11 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#d7b46d";
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.arc(screen.x + 36 * scale, top + 4, 8 * scale, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (building.productionProgress / 100));
      ctx.stroke();
      ctx.fillStyle = "#d6c29c";
      ctx.font = `${8 * Math.max(0.8, scale)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = "center";
      ctx.fillText(iconDef.name.slice(0, 1), screen.x + 36 * scale, top + 7);
    }
  }

  drawChimneySmoke(ctx, x, y, scale) {
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const phase = (this.time * 0.25 + i * 0.19) % 1;
      const smokeX = x + Math.sin(this.time * 0.6 + i * 1.8) * 7 * scale + phase * 8 * scale;
      const smokeY = y - phase * 35 * scale;
      ctx.globalAlpha = (1 - phase) * 0.16;
      ctx.fillStyle = "#d1d1bd";
      ctx.beginPath();
      ctx.arc(smokeX, smokeY, (4 + phase * 6) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawUnit(ctx, unit, screen) {
    if (unit.owner !== "player" && !this.game.isVisibleAt(unit.x, unit.y)) return;
    const def = UNIT_DEFS[unit.type];
    const color = this.colorFor(unit.owner);
    const scale = this.camera.zoom * (def.category === "cavalry" ? 1.1 : def.category === "siege" ? 1.2 : 1);
    const moving = unit.task.type === "move" || unit.task.type === "attackMove" || unit.task.type === "attack" || unit.task.type === "gather" || unit.task.type === "build";
    const bob = moving ? Math.abs(Math.sin(unit.walkAnimation)) * 1.1 * scale : Math.sin(this.time * 2.4 + unit.id.length) * 0.35;
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.scale(scale, scale);
    ctx.fillStyle = "rgba(8, 11, 7, 0.36)";
    ctx.beginPath();
    ctx.ellipse(1, 4, def.category === "cavalry" ? 15 : def.category === "siege" ? 18 : 8, def.category === "cavalry" ? 5 : 3, 0, 0, Math.PI * 2);
    ctx.fill();
    if (unit.type === "villager") this.drawVillager(ctx, unit, color, bob);
    else if (unit.type === "spearman") this.drawSpearman(ctx, unit, color, bob);
    else if (unit.type === "archer") this.drawArcher(ctx, unit, color, bob);
    else if (unit.type === "cavalry") this.drawCavalry(ctx, unit, color, bob);
    else if (unit.type === "catapult") this.drawCatapult(ctx, unit, color, bob);
    if (unit.carry > 0.2) this.drawCarry(ctx, unit, def);
    ctx.restore();

    if (unit.hp < unit.maxHp * 0.995 || this.game.selected.has(unit.id) || this.hoveredId === unit.id) {
      const width = def.category === "cavalry" ? 30 : def.category === "siege" ? 37 : 22;
      const y = screen.y - (def.category === "cavalry" ? 38 : def.category === "siege" ? 29 : 28) * scale;
      this.drawProgressBar(ctx, screen.x - width * scale / 2, y, width * scale, 3.5 * scale, unit.hp / unit.maxHp, color.bright);
    }
  }

  drawVillager(ctx, unit, color, bob) {
    const gait = Math.sin(unit.walkAnimation * 1.9) * 2.2;
    ctx.strokeStyle = "#3d3328";
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(-2, -2);
    ctx.lineTo(-3 + gait * 0.55, 6);
    ctx.moveTo(2, -2);
    ctx.lineTo(3 - gait * 0.55, 6);
    ctx.stroke();
    ctx.fillStyle = color.main;
    ctx.beginPath();
    ctx.moveTo(-6, -17 + bob);
    ctx.lineTo(-4, -4);
    ctx.lineTo(4, -4);
    ctx.lineTo(7, -17 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#8d7450";
    ctx.fillRect(-5, -11 + bob, 10, 3);
    ctx.strokeStyle = "#a78b63";
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(-3, -14 + bob);
    ctx.lineTo(-7, -6 + bob);
    ctx.moveTo(3, -14 + bob);
    ctx.lineTo(7, -7 + bob);
    ctx.stroke();
    ctx.fillStyle = "#c29d73";
    ctx.beginPath();
    ctx.arc(0, -20 + bob, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#a38b57";
    ctx.beginPath();
    ctx.ellipse(0, -23 + bob, 7.5, 2.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-5, -23 + bob);
    ctx.lineTo(0, -29 + bob);
    ctx.lineTo(5, -23 + bob);
    ctx.closePath();
    ctx.fill();
    if (unit.task.type === "gather" || unit.task.type === "build") {
      ctx.strokeStyle = "#5b442b";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(7, -8 + bob);
      ctx.lineTo(12, -21 + bob);
      ctx.stroke();
      ctx.fillStyle = "#999a87";
      ctx.fillRect(9.5, -23 + bob, 5, 2.5);
    }
  }

  drawSpearman(ctx, unit, color, bob) {
    const attack = unit.attackAnimation > 0 ? Math.sin((1 - unit.attackAnimation / 0.36) * Math.PI) : 0;
    const gait = Math.sin(unit.walkAnimation * 1.65) * 1.8;
    ctx.strokeStyle = "#3b3329";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-2, -4);
    ctx.lineTo(-3 + gait, 6);
    ctx.moveTo(2, -4);
    ctx.lineTo(3 - gait, 6);
    ctx.stroke();
    ctx.fillStyle = color.dark;
    ctx.beginPath();
    ctx.moveTo(-6, -17 + bob);
    ctx.lineTo(-5, -5);
    ctx.lineTo(5, -5);
    ctx.lineTo(7, -17 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = color.main;
    ctx.fillRect(-5, -15 + bob, 10, 8);
    ctx.fillStyle = color.metal;
    ctx.fillRect(-4, -11 + bob, 8, 2);
    ctx.strokeStyle = "#a1845f";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-4, -15 + bob);
    ctx.lineTo(-8 - attack * 3, -8 + bob);
    ctx.stroke();
    ctx.fillStyle = "#bd9f77";
    ctx.beginPath();
    ctx.arc(0, -21 + bob, 3.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#777a70";
    ctx.beginPath();
    ctx.arc(0, -23 + bob, 4.2, Math.PI, Math.PI * 2);
    ctx.lineTo(3.8, -20 + bob);
    ctx.lineTo(-3.8, -20 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#d2c185";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -27 + bob);
    ctx.lineTo(0, -31 + bob);
    ctx.stroke();
    ctx.strokeStyle = "#5b452e";
    ctx.lineWidth = 1.5;
    const spearX = 10 + attack * 8;
    ctx.beginPath();
    ctx.moveTo(spearX, 5);
    ctx.lineTo(spearX - 2, -36 + bob);
    ctx.stroke();
    ctx.fillStyle = "#c1c3b0";
    ctx.beginPath();
    ctx.moveTo(spearX - 2, -41 + bob);
    ctx.lineTo(spearX - 4.5, -34 + bob);
    ctx.lineTo(spearX + 1.5, -34 + bob);
    ctx.closePath();
    ctx.fill();
  }

  drawArcher(ctx, unit, color, bob) {
    const attack = unit.attackAnimation > 0 ? Math.sin((1 - unit.attackAnimation / 0.36) * Math.PI) : 0;
    const gait = Math.sin(unit.walkAnimation * 1.8) * 1.8;
    ctx.strokeStyle = "#40362a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-2, -3);
    ctx.lineTo(-3 + gait, 6);
    ctx.moveTo(2, -3);
    ctx.lineTo(3 - gait, 6);
    ctx.stroke();
    ctx.fillStyle = color.main;
    ctx.beginPath();
    ctx.moveTo(-5, -17 + bob);
    ctx.lineTo(-4, -4);
    ctx.lineTo(4, -4);
    ctx.lineTo(6, -17 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#6b4d32";
    ctx.fillRect(-5, -15 + bob, 11, 4);
    ctx.fillStyle = "#c09d73";
    ctx.beginPath();
    ctx.arc(0, -21 + bob, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4b4d42";
    ctx.beginPath();
    ctx.arc(0, -23 + bob, 4, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#9b7746";
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.arc(8 - attack * 3, -12 + bob, 7.5, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.strokeStyle = "#d5d0b8";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(8 - attack * 3, -19.5 + bob);
    ctx.lineTo(8 - attack * 3, -4.5 + bob);
    ctx.stroke();
    ctx.strokeStyle = "#d5cfb7";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(3 - attack * 3, -12 + bob);
    ctx.lineTo(13 - attack * 4, -12 + bob);
    ctx.stroke();
    ctx.strokeStyle = "#4e3a27";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, -11 + bob);
    ctx.lineTo(-11, -21 + bob);
    ctx.stroke();
  }

  drawCavalry(ctx, unit, color, bob) {
    const gallop = Math.sin(unit.walkAnimation * 1.7) * 4;
    const attack = unit.attackAnimation > 0 ? Math.sin((1 - unit.attackAnimation / 0.36) * Math.PI) : 0;
    ctx.strokeStyle = "#3d3125";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-9, -8);
    ctx.lineTo(-10 + gallop, 3);
    ctx.moveTo(-3, -7);
    ctx.lineTo(-2 - gallop, 4);
    ctx.moveTo(5, -8);
    ctx.lineTo(4 + gallop, 3);
    ctx.moveTo(11, -7);
    ctx.lineTo(12 - gallop, 4);
    ctx.stroke();
    const horseGradient = ctx.createLinearGradient(-14, -20, 14, -4);
    horseGradient.addColorStop(0, "#8c6948");
    horseGradient.addColorStop(0.6, "#67482f");
    horseGradient.addColorStop(1, "#4d3526");
    ctx.fillStyle = horseGradient;
    ctx.beginPath();
    ctx.ellipse(0, -13 + bob, 15, 8, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(11, -17 + bob);
    ctx.lineTo(17, -25 + bob);
    ctx.lineTo(20, -22 + bob);
    ctx.lineTo(16, -15 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#392a20";
    ctx.beginPath();
    ctx.moveTo(-13, -18 + bob);
    ctx.quadraticCurveTo(-22, -14 + bob, -18, -5 + bob);
    ctx.lineTo(-12, -9 + bob);
    ctx.fill();
    ctx.fillStyle = color.main;
    ctx.fillRect(-9, -17 + bob, 13, 9);
    ctx.fillStyle = color.dark;
    ctx.beginPath();
    ctx.moveTo(-7, -18 + bob);
    ctx.lineTo(-2, -30 + bob);
    ctx.lineTo(7, -19 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#bb9b76";
    ctx.beginPath();
    ctx.arc(2, -32 + bob, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#777b70";
    ctx.beginPath();
    ctx.arc(2, -34 + bob, 4.1, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color.metal;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-2, -36 + bob);
    ctx.lineTo(-5, -42 + bob);
    ctx.stroke();
    ctx.strokeStyle = "#5c432b";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(10, -24 + bob);
    ctx.lineTo(9 + attack * 6, 2);
    ctx.stroke();
    ctx.fillStyle = "#bec1ad";
    ctx.beginPath();
    ctx.moveTo(10, -25 + bob);
    ctx.lineTo(13, -20 + bob);
    ctx.lineTo(8, -21 + bob);
    ctx.closePath();
    ctx.fill();
  }

  drawCatapult(ctx, unit, color, bob) {
    ctx.strokeStyle = "#4d3825";
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(-17, 0);
    ctx.lineTo(-13, -9);
    ctx.lineTo(15, -9);
    ctx.lineTo(18, 1);
    ctx.stroke();
    for (const x of [-11, 11]) {
      ctx.fillStyle = "#4b3829";
      ctx.beginPath();
      ctx.arc(x, -3, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#977b4d";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, -7.5);
      ctx.lineTo(x, 1.5);
      ctx.stroke();
    }
    const attack = unit.attackAnimation > 0 ? Math.sin((1 - unit.attackAnimation / 0.36) * Math.PI) : 0;
    ctx.strokeStyle = "#61482d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, -9);
    ctx.lineTo(3, -30 + bob);
    ctx.lineTo(13 - attack * 14, -17 - attack * 8);
    ctx.stroke();
    ctx.fillStyle = "#6d6654";
    ctx.beginPath();
    ctx.arc(14 - attack * 14, -18 - attack * 8, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color.main;
    ctx.fillRect(-3, -12, 7, 8);
    ctx.fillStyle = "#b39369";
    ctx.beginPath();
    ctx.arc(0, -15, 2.8, 0, Math.PI * 2);
    ctx.fill();
  }

  drawCarry(ctx, unit, def) {
    const resourceColors = {
      food: "#be9b54",
      wood: "#755635",
      gold: "#d8bd5d",
      stone: "#909287",
    };
    ctx.save();
    ctx.translate(-7, -9);
    ctx.rotate(-0.15);
    ctx.fillStyle = resourceColors[unit.carryType] ?? "#aa8c60";
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(44, 33, 22, 0.6)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  }

  drawProgressBar(ctx, x, y, width, height, ratio, color) {
    ctx.fillStyle = "rgba(11, 9, 7, 0.8)";
    ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
    ctx.fillStyle = "#373025";
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width * clamp(ratio, 0, 1), height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.fillRect(x, y, width * clamp(ratio, 0, 1), Math.max(0.5, height * 0.3));
  }

  drawProjectiles(ctx) {
    for (const projectile of this.game.projectiles) {
      const p = this.worldToScreen(projectile.x, projectile.y);
      const target = this.game.entities.get(projectile.targetId);
      const targetP = this.worldToScreen(projectile.targetX, projectile.targetY);
      if (!this.isScreenOnMap(p.x, p.y, 80)) continue;
      if (projectile.type === "boulder") {
        ctx.fillStyle = "#5d5b4f";
        ctx.beginPath();
        ctx.arc(p.x, p.y - 12 * this.camera.zoom, 4.5 * this.camera.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(208, 186, 137, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y - 12 * this.camera.zoom, 7 * this.camera.zoom, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const angle = Math.atan2(targetP.y - p.y, targetP.x - p.x);
        ctx.save();
        ctx.translate(p.x, p.y - 11 * this.camera.zoom);
        ctx.rotate(angle);
        ctx.strokeStyle = projectile.owner === "player" ? "#e4d4ad" : "#d6d0b7";
        ctx.lineWidth = Math.max(0.8, this.camera.zoom);
        ctx.beginPath();
        ctx.moveTo(-6 * this.camera.zoom, 0);
        ctx.lineTo(5 * this.camera.zoom, 0);
        ctx.stroke();
        ctx.fillStyle = "#d2d0b5";
        ctx.beginPath();
        ctx.moveTo(6 * this.camera.zoom, 0);
        ctx.lineTo(2 * this.camera.zoom, -2 * this.camera.zoom);
        ctx.lineTo(2 * this.camera.zoom, 2 * this.camera.zoom);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  drawEffects(ctx) {
    for (const effect of this.game.effects) {
      const p = this.worldToScreen(effect.x, effect.y);
      if (!this.isScreenOnMap(p.x, p.y, 100)) continue;
      const progress = clamp(effect.age / effect.duration, 0, 1);
      ctx.save();
      if (effect.type === "hit" || effect.type === "woodHit") {
        ctx.globalAlpha = 1 - progress;
        const radius = (effect.critical ? 14 : 8) * this.camera.zoom;
        ctx.strokeStyle = effect.type === "woodHit" ? "#d3ad70" : "#e2d9c3";
        ctx.lineWidth = 1.2 * this.camera.zoom;
        for (let i = 0; i < 4; i++) {
          const angle = i * Math.PI * 0.5 + 0.45;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(angle) * radius * 0.3, p.y - 12 + Math.sin(angle) * radius * 0.3);
          ctx.lineTo(p.x + Math.cos(angle) * radius * (0.6 + progress), p.y - 12 + Math.sin(angle) * radius * (0.6 + progress));
          ctx.stroke();
        }
        if (effect.amount) {
          ctx.globalAlpha = 1 - progress;
          ctx.fillStyle = effect.critical ? "#edc574" : "rgba(233, 221, 198, 0.85)";
          ctx.font = `${effect.critical ? 13 : 10}px ${getComputedStyle(document.body).fontFamily}`;
          ctx.textAlign = "center";
          ctx.fillText(`-${effect.amount}`, p.x, p.y - 28 - progress * 18);
        }
      } else if (effect.type === "slash") {
        ctx.globalAlpha = 1 - progress;
        ctx.strokeStyle = "#efe3c2";
        ctx.lineWidth = 2 * this.camera.zoom;
        ctx.beginPath();
        ctx.arc(p.x, p.y - 12, 10 * this.camera.zoom, -1.2 + progress, 0.8 + progress);
        ctx.stroke();
      } else if (effect.type === "arrowHit" || effect.type === "splash") {
        ctx.globalAlpha = 1 - progress;
        ctx.strokeStyle = effect.type === "splash" ? "#b69965" : "#ded3bc";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, (8 + progress * 25) * this.camera.zoom, (3 + progress * 7) * this.camera.zoom, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (effect.type === "gather") {
        ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.8;
        const color = { food: "#d5b15e", wood: "#9a7c4c", gold: "#e0c35f", stone: "#bfc0b4" }[effect.resourceType] ?? "#d2bb85";
        ctx.fillStyle = color;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(p.x + (i - 1) * 5, p.y - 5 - progress * 14 - i * 2, 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (effect.type === "build" || effect.type === "deposit") {
        ctx.globalAlpha = (1 - progress) * 0.55;
        ctx.fillStyle = effect.type === "deposit" ? "#e1c06d" : "#d0c1a4";
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(progress * 9) * 4, p.y - progress * 25, 2 + progress * 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (effect.type === "moveMarker" || effect.type === "attackMarker" || effect.type === "gatherMarker" || effect.type === "rallyMarker") {
        ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.9;
        ctx.strokeStyle = effect.type === "attackMarker" ? "#d8785e" : effect.type === "gatherMarker" ? "#cfb776" : "#d8c691";
        ctx.lineWidth = 1.5;
        const radius = (8 + progress * 13) * this.camera.zoom;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, radius, radius * 0.48, 0, 0, Math.PI * 2);
        ctx.stroke();
        if (effect.type === "moveMarker") {
          ctx.beginPath();
          ctx.moveTo(p.x - radius * 0.25, p.y - 5);
          ctx.lineTo(p.x, p.y + 3);
          ctx.lineTo(p.x + radius * 0.25, p.y - 5);
          ctx.stroke();
        }
      } else if (effect.type === "muster" || effect.type === "complete" || effect.type === "ageBurst") {
        ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.55;
        ctx.strokeStyle = effect.type === "ageBurst" ? "#e7c97a" : "#d8c8a6";
        ctx.lineWidth = 1.3 * this.camera.zoom;
        const radius = (8 + progress * (effect.type === "ageBurst" ? 55 : 24)) * this.camera.zoom;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, radius, radius * 0.48, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (effect.type === "dust" || effect.type === "collapse") {
        ctx.globalAlpha = (1 - progress) * 0.24;
        ctx.fillStyle = "#b8a27f";
        const radius = (effect.type === "collapse" ? 22 : 7) * this.camera.zoom;
        for (let i = 0; i < 5; i++) {
          const angle = i * 1.7 + 0.3;
          ctx.beginPath();
          ctx.arc(
            p.x + Math.cos(angle) * progress * radius * 1.6,
            p.y - progress * (8 + i * 3),
            (5 + progress * 10 + i * 2) * this.camera.zoom,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      } else if (effect.type === "corpse") {
        ctx.globalAlpha = 0.44 * (1 - progress * 0.4);
        ctx.translate(p.x, p.y);
        ctx.rotate(effect.facing);
        ctx.fillStyle = effect.owner === "player" ? "#692f28" : "#2c525a";
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (effect.type === "stump") {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = "#55412b";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + 3, 5, 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (effect.type === "enemyAttack") {
        ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.75;
        ctx.strokeStyle = "#ca725b";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(this.width * 0.38, this.height * 0.1, this.width * 0.6, this.height * 0.6, p.x, p.y);
        ctx.stroke();
      } else if (effect.type === "splash") {
        ctx.globalAlpha = 1 - progress;
        ctx.fillStyle = "#a28c67";
        ctx.beginPath();
        ctx.arc(p.x, p.y, (4 + progress * 20) * this.camera.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawFog(ctx) {
    const zoom = this.camera.zoom;
    const rx = (TILE_W / 2) * zoom + 0.6;
    const ry = (TILE_H / 2) * zoom + 0.45;
    for (let sum = 0; sum <= (MAP_SIZE - 1) * 2; sum++) {
      const startY = Math.max(0, sum - MAP_SIZE + 1);
      const endY = Math.min(MAP_SIZE - 1, sum);
      for (let y = startY; y <= endY; y++) {
        const x = sum - y;
        const index = y * MAP_SIZE + x;
        if (this.game.visibility[index]) continue;
        const p = this.tileCenter(x, y);
        if (!this.isScreenOnMap(p.x, p.y, 60)) continue;
        const unexplored = !this.game.explored[index];
        ctx.fillStyle = unexplored ? "rgba(5, 9, 7, 0.95)" : "rgba(5, 8, 7, 0.36)";
        this.drawDiamond(ctx, p.x, p.y, rx, ry, ctx.fillStyle);
      }
    }
  }

  drawSelectionRings(ctx) {
    const selected = this.game.selected;
    for (const id of selected) {
      const entity = this.game.entities.get(id);
      if (!entity?.alive) continue;
      const p = this.worldToScreen(entity.x, entity.y);
      const radius = (entity.kind === "building" ? entity.size * 16 : 10) * this.camera.zoom;
      ctx.save();
      ctx.strokeStyle = "rgba(238, 203, 125, 0.9)";
      ctx.lineWidth = Math.max(1, 1.25 * this.camera.zoom);
      ctx.setLineDash([5 * this.camera.zoom, 3 * this.camera.zoom]);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + (entity.kind === "building" ? 2 : 4), radius, radius * 0.48, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (this.hoveredId && !selected.has(this.hoveredId)) {
      const entity = this.game.entities.get(this.hoveredId);
      if (entity?.alive) {
        const p = this.worldToScreen(entity.x, entity.y);
        ctx.save();
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = "#ddc594";
        ctx.lineWidth = 1;
        ctx.beginPath();
        const radius = entity.kind === "building" ? entity.size * 14 : 9;
        ctx.ellipse(p.x, p.y + 3, radius * this.camera.zoom, radius * 0.46 * this.camera.zoom, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawRallyPoints(ctx) {
    for (const buildingId of this.game.selected) {
      const building = this.game.entities.get(buildingId);
      if (!building?.alive || building.kind !== "building") continue;
      const rally = this.game.rallyPoints.get(buildingId);
      if (!rally) continue;
      const p = this.worldToScreen(rally.x, rally.y);
      const scale = this.camera.zoom;
      ctx.save();
      ctx.strokeStyle = "rgba(223, 195, 130, 0.86)";
      ctx.lineWidth = Math.max(0.8, scale * 0.9);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 3);
      ctx.lineTo(p.x, p.y - 24 * scale);
      ctx.stroke();
      const wave = Math.sin(this.time * 3.2) * 2 * scale;
      ctx.fillStyle = "rgba(176, 65, 49, 0.9)";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 24 * scale);
      ctx.quadraticCurveTo(p.x + 12 * scale, p.y - 21 * scale + wave, p.x, p.y - 13 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(235, 211, 158, 0.34)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 2, 13 * scale, 5 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawScreenAtmosphere(ctx) {
    if (this.game.state === "menu") return;
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, "rgba(225, 197, 134, 0.035)");
    gradient.addColorStop(0.35, "rgba(255, 238, 194, 0)");
    gradient.addColorStop(1, "rgba(23, 15, 8, 0.12)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  drawMinimap() {
    const ctx = this.minimapCtx;
    const width = this.minimap.width;
    const height = this.minimap.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#151910";
    ctx.fillRect(0, 0, width, height);
    const metrics = this.getMinimapMetrics();
    const { halfW, halfH, cx, cy } = metrics;
    const project = (x, y) => ({
      x: cx + (x - y) * halfW,
      y: cy + (x + y - MAP_SIZE + 1) * halfH,
    });
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        const p = project(x, y);
        const terrain = this.game.world.terrain[y * MAP_SIZE + x];
        let color = {
          [TERRAIN.GRASS]: "#606f49",
          [TERRAIN.FOREST]: "#49573b",
          [TERRAIN.WATER]: "#315b61",
          [TERRAIN.BRIDGE]: "#8c7652",
          [TERRAIN.ROAD]: "#807257",
          [TERRAIN.MEADOW]: "#748154",
          [TERRAIN.ROCK]: "#666b5e",
        }[terrain];
        if (!this.game.explored[y * MAP_SIZE + x]) color = "#121711";
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - halfH + 0.3);
        ctx.lineTo(p.x + halfW + 0.3, p.y);
        ctx.lineTo(p.x, p.y + halfH + 0.3);
        ctx.lineTo(p.x - halfW - 0.3, p.y);
        ctx.closePath();
        ctx.fill();
      }
    }
    for (const node of this.game.world.nodes) {
      if (!node.alive || !this.game.explored[node.y * MAP_SIZE + node.x]) continue;
      const p = project(node.x, node.y);
      ctx.fillStyle = {
        tree: "#2f4933",
        berries: "#a9684b",
        gold: "#d1b24f",
        stone: "#a4a598",
      }[node.kind];
      ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.8, 1.8);
    }
    for (const building of this.game.buildingList) {
      if (!building.alive || !this.game.isExploredAt(building.x, building.y)) continue;
      const p = project(building.x, building.y);
      ctx.fillStyle = this.colorFor(building.owner).bright;
      ctx.fillRect(p.x - building.size, p.y - building.size * 0.55, building.size * 2, building.size * 1.1);
      ctx.strokeStyle = "rgba(235, 218, 174, 0.42)";
      ctx.lineWidth = 0.7;
      ctx.strokeRect(p.x - building.size, p.y - building.size * 0.55, building.size * 2, building.size * 1.1);
    }
    for (const unit of this.game.unitList) {
      if (!unit.alive) continue;
      if (unit.owner !== "player" && !this.game.isVisibleAt(unit.x, unit.y)) continue;
      const p = project(unit.x, unit.y);
      ctx.fillStyle = this.colorFor(unit.owner).main;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.45, 0, Math.PI * 2);
      ctx.fill();
    }
    const corners = this.getCameraViewPolygon().map((point) => project(point.x, point.y));
    ctx.save();
    ctx.strokeStyle = "rgba(236, 216, 171, 0.58)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(235, 211, 159, 0.035)";
    ctx.beginPath();
    corners.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = "#d3b16a";
    ctx.strokeRect(2.5, 2.5, width - 5, height - 5);
    ctx.restore();
  }

  minimapToWorld(localX, localY) {
    const { halfW, halfH, cx, cy } = this.getMinimapMetrics();
    const a = (localX - cx) / halfW;
    const b = (localY - cy) / halfH + MAP_SIZE - 1;
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  getMinimapMetrics() {
    const width = this.minimap.width;
    const height = this.minimap.height;
    return {
      halfW: (width * 0.46) / MAP_SIZE,
      halfH: (height * 0.44) / MAP_SIZE,
      cx: width / 2,
      cy: height / 2,
    };
  }

  drawOverlay(selection = null) {
    const ctx = this.overlayCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.game.placement) {
      this.drawPlacement(ctx);
    }
    if (selection?.active) {
      const x = Math.min(selection.startX, selection.currentX);
      const y = Math.min(selection.startY, selection.currentY);
      const w = Math.abs(selection.currentX - selection.startX);
      const h = Math.abs(selection.currentY - selection.startY);
      ctx.fillStyle = "rgba(208, 184, 132, 0.1)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(233, 207, 151, 0.82)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }
  }

  drawPlacement(ctx) {
    const placement = this.game.placement;
    const def = BUILD_DEFS[placement.buildingType];
    if (!def) return;
    const valid = placement.validity.valid;
    const center = this.worldToScreen(
      placement.anchorX + (def.size - 1) / 2,
      placement.anchorY + (def.size - 1) / 2,
    );
    const rx = (def.size * TILE_W / 2) * this.camera.zoom;
    const ry = (def.size * TILE_H / 2) * this.camera.zoom;
    ctx.save();
    ctx.fillStyle = valid ? "rgba(143, 178, 118, 0.25)" : "rgba(184, 87, 65, 0.26)";
    ctx.strokeStyle = valid ? "rgba(198, 221, 161, 0.85)" : "rgba(220, 120, 96, 0.9)";
    ctx.lineWidth = 1.3;
    ctx.setLineDash([6, 4]);
    this.drawDiamond(ctx, center.x, center.y, rx, ry, ctx.fillStyle);
    ctx.stroke();
    ctx.setLineDash([]);
    const cellRx = (TILE_W / 2) * this.camera.zoom;
    const cellRy = (TILE_H / 2) * this.camera.zoom;
    for (let y = 0; y < def.size; y++) {
      for (let x = 0; x < def.size; x++) {
        const tile = this.worldToScreen(placement.anchorX + x, placement.anchorY + y);
        ctx.globalAlpha = 0.28;
        this.drawDiamond(ctx, tile.x, tile.y, cellRx, cellRy, null, valid ? "#d8e4c3" : "#e3a18f");
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(15, 12, 8, 0.86)";
    canvasRoundRect(ctx, center.x - 86, center.y - ry - 27, 172, 21, 2);
    ctx.fill();
    ctx.fillStyle = valid ? "#e4d5b6" : "#e0a28f";
    ctx.textAlign = "center";
    ctx.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillText(valid ? `左键营造 · ${def.name}` : placement.validity.reason, center.x, center.y - ry - 13);
    ctx.restore();
  }
}

function len(a) {
  return Math.hypot(a.x, a.y);
}
