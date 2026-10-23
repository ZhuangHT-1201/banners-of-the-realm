import {
  AGES,
  BUILD_DEFS,
  BUILD_MENU,
  CIVS,
  TECH_DEFS,
  UNIT_DEFS,
  formatCost,
  getUnitCost,
} from "./data.js";
import { formatSigned, formatTime, svgIcon } from "./utils.js";

const BUILD_HOTKEYS = ["q", "w", "e", "r", "t", "z", "x", "c", "v", "b"];
const UNIT_HOTKEYS = { villager: "q", spearman: "w", archer: "e", cavalry: "r", catapult: "t" };
const TECH_HOTKEYS = { armor: "q", weapons: "w", bowcraft: "e" };

const CONTROL_GROUPS = [
  {
    title: "视野与镜头",
    rows: [
      ["移动视野", "W A S D / 方向键"],
      ["拖动镜头", "按住鼠标中键"],
      ["缩放视野", "鼠标滚轮"],
      ["返回城镇中心", "空格"],
    ],
  },
  {
    title: "选择与编队",
    rows: [
      ["选择 / 框选", "鼠标左键"],
      ["追加选择", "Shift + 左键"],
      ["编入队伍", "Ctrl + 1—9"],
      ["调出队伍", "1—9"],
      ["选择全部军队", "Ctrl + A"],
      ["下一个空闲乡勇", "."],
    ],
  },
  {
    title: "下达命令",
    rows: [
      ["移动 / 采集 / 攻击", "鼠标右键"],
      ["攻击移动", "A + 左键"],
      ["停止", "S"],
      ["取消营造 / 指令", "Esc / 右键"],
      ["选择同类单位", "双击单位"],
    ],
  },
  {
    title: "营建与界面",
    rows: [
      ["建造快捷键", "Q W E R T / Z X C V B"],
      ["训练与研究", "Q W E R T"],
      ["时代演进", "城镇中心 Q"],
      ["战局速度", "顶部 ➤ 按钮"],
      ["暂停", "Esc"],
      ["史册与帮助", "F1"],
    ],
  },
];

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatResourceAmount(amount) {
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return String(Math.floor(amount));
}

export class UI {
  constructor({ audio, callbacks }) {
    this.audio = audio;
    this.callbacks = callbacks;
    this.game = null;
    this.renderer = null;
    this.playerCiv = "song";
    this.difficulty = "normal";
    this.lastUpdate = 0;
    this.selectionSignature = "";
    this.commandSignature = "";
    this.commandMap = new Map();
    this.hotkeyMap = new Map();
    this.previousResources = null;
    this.codexOpen = false;
    this.codexPage = "history";
    this.pauseOpen = false;
    this.resumeAfterCodex = false;
    this.objectives = [];
    this.tutorialTimer = null;
    this.alertTimeouts = new Set();
    this.soundMuted = false;
    this.speedIndex = 0;
    this.speeds = [1, 1.25, 1.5, 2];
    this.buildUI();
    this.bindEvents();
  }

  get elements() {
    return this._elements;
  }

  cache(id) {
    return document.getElementById(id);
  }

  buildUI() {
    const ids = [
      "gameCanvas",
      "minimap",
      "placementCanvas",
      "topbar",
      "civSeal",
      "civName",
      "ageButton",
      "ageNumeral",
      "ageName",
      "ageProgress",
      "resFood",
      "resWood",
      "resGold",
      "resStone",
      "rateFood",
      "rateWood",
      "rateGold",
      "rateStone",
      "population",
      "gameClock",
      "soundButton",
      "speedButton",
      "pauseButton",
      "codexButton",
      "objectivePanel",
      "objectiveToggle",
      "objectiveBody",
      "alertFeed",
      "gameClock",
      "bottombar",
      "emptySelection",
      "selectionContent",
      "selectionPortrait",
      "selectionName",
      "selectionCount",
      "selectionSubtitle",
      "selectionHealth",
      "selectionHealthText",
      "selectionStats",
      "unitGrid",
      "commandTitle",
      "commandHint",
      "commandGrid",
      "queuePanel",
      "idleButton",
      "idleCount",
      "armyButton",
      "armyCount",
      "mapCoordinate",
      "tooltip",
      "menu",
      "startButton",
      "menuCodexButton",
      "difficultySwitch",
      "loadingScreen",
      "pauseOverlay",
      "codexOverlay",
      "closeCodex",
      "codexContent",
      "endOverlay",
      "endTitle",
      "endKicker",
      "endDescription",
      "endStats",
      "endSeal",
      "playAgainButton",
      "endMenuButton",
      "tutorialToast",
      "tutorialText",
      "tutorialKicker",
      "tutorialClose",
      "commandCursor",
      "cinematic-bars",
    ];
    this._elements = {};
    for (const id of ids) this._elements[id] = this.cache(id);
  }

  bindEvents() {
    document.querySelectorAll(".civ-card").forEach((card) => {
      card.addEventListener("click", () => {
        this.playerCiv = card.dataset.civ;
        document.querySelectorAll(".civ-card").forEach((other) => other.classList.toggle("selected", other === card));
        this.audio.play("click");
      });
    });

    this.elements.difficultySwitch.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        this.difficulty = button.dataset.difficulty;
        this.elements.difficultySwitch.querySelectorAll("button").forEach((other) => other.classList.toggle("active", other === button));
        this.audio.play("click");
      });
    });

    this.elements.startButton.addEventListener("click", () => {
      this.audio.ensureContext();
      this.audio.startAmbient();
      this.audio.play("click");
      this.callbacks.onStart?.(this.playerCiv, this.difficulty);
    });

    this.elements.menuCodexButton.addEventListener("click", () => this.openCodex("history"));
    this.elements.codexButton.addEventListener("click", () => this.openCodex(this.codexPage));
    this.elements.closeCodex.addEventListener("click", () => this.closeCodex());
    document.querySelectorAll(".codex-nav [data-codex-page]").forEach((button) => {
      button.addEventListener("click", () => this.setCodexPage(button.dataset.codexPage));
    });

    this.elements.soundButton.addEventListener("click", () => {
      this.soundMuted = this.audio.toggleMuted();
      this.updateSoundButton();
    });
    this.elements.speedButton.addEventListener("click", () => {
      this.speedIndex = (this.speedIndex + 1) % this.speeds.length;
      const speed = this.speeds[this.speedIndex];
      this.game?.setSpeed(speed);
      this.elements.speedButton.querySelector("span").textContent = `${speed}×`;
      this.audio.play("click");
    });
    this.elements.pauseButton.addEventListener("click", () => this.togglePause());
    this.elements.ageButton.addEventListener("click", () => {
      if (!this.game) return;
      const tc = this.game.getTownCenter("player");
      if (tc) {
        this.game.select([tc.id]);
        this.renderer?.centerOn(tc.x, tc.y, false);
        this.audio.play("select");
      }
    });
    this.elements.objectiveToggle.addEventListener("click", () => {
      const panel = this.elements.objectivePanel;
      panel.classList.toggle("collapsed");
      this.elements.objectiveToggle.textContent = panel.classList.contains("collapsed") ? "+" : "−";
    });
    this.elements.commandGrid.addEventListener("click", (event) => {
      const button = event.target.closest(".command-button");
      if (!button || button.classList.contains("disabled")) return;
      const command = this.commandMap.get(button.dataset.commandId);
      if (!command) return;
      this.executeCommand(command);
    });
    this.elements.commandGrid.addEventListener("pointerover", (event) => {
      const button = event.target.closest(".command-button");
      if (!button) return;
      this.showTip(button, event);
    });
    this.elements.commandGrid.addEventListener("pointerout", (event) => {
      if (!this.elements.commandGrid.contains(event.relatedTarget)) this.hideTip();
    });

    this.elements.idleButton.addEventListener("click", () => {
      if (this.game?.selectNextIdleVillager()) this.audio.play("select");
    });
    this.elements.armyButton.addEventListener("click", () => {
      if (this.game?.selectAllArmy()) {
        this.audio.play("select");
        this.refreshSelection(true);
      }
    });

    this.elements.selectionPanel = document.getElementById("selectionPanel");
    this.elements.selectionPanel.addEventListener("click", (event) => {
      const chip = event.target.closest(".unit-chip[data-id]");
      if (!chip || !this.game) return;
      this.game.select([chip.dataset.id]);
      this.audio.play("select");
    });

    this.elements.pauseOverlay.addEventListener("click", (event) => {
      if (event.target === this.elements.pauseOverlay) this.togglePause();
    });
    this.elements.pauseOverlay.querySelector(".resume-button").addEventListener("click", () => this.togglePause());
    this.elements.pauseOverlay.querySelector(".open-controls-button").addEventListener("click", () => this.openCodex("controls"));
    this.elements.pauseOverlay.querySelector(".restart-button").addEventListener("click", () => this.callbacks.onRestart?.());
    this.elements.pauseOverlay.querySelector(".return-menu-button").addEventListener("click", () => this.callbacks.onReturnMenu?.());

    this.elements.codexOverlay.addEventListener("click", (event) => {
      if (event.target === this.elements.codexOverlay) this.closeCodex();
    });
    this.elements.playAgainButton.addEventListener("click", () => this.callbacks.onRestart?.());
    this.elements.endMenuButton.addEventListener("click", () => this.callbacks.onReturnMenu?.());
    this.elements.tutorialClose.addEventListener("click", () => this.hideTutorial());
    this.showCodexPage("history");
  }

  setGame(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.objectives = [];
    this.selectionSignature = "";
    this.commandSignature = "";
    this.previousResources = null;
    this.elements.menu.classList.add("leaving");
    window.setTimeout(() => this.elements.menu.classList.add("hidden"), 720);
    ["topbar", "objectivePanel", "alertFeed", "bottombar"].forEach((id) => this.elements[id]?.classList.remove("hidden"));
    this.elements.pauseOverlay.classList.add("hidden");
    this.elements.endOverlay.classList.add("hidden");
    this.elements.codexOverlay.classList.add("hidden");
    this.codexOpen = false;
    this.pauseOpen = false;
    this.resumeAfterCodex = false;
    this.soundMuted = this.audio.muted;
    this.speedIndex = 0;
    this.game.setSpeed(1);
    this.elements.speedButton.querySelector("span").textContent = "1×";
    this.updateSoundButton();
    const civ = CIVS[game.player.civId];
    this.elements.civSeal.textContent = civ.seal;
    this.elements.civSeal.style.background = civ.color;
    this.elements.civName.textContent = civ.name;
    this.elements.placementCanvas.classList.remove("hidden");
    requestAnimationFrame(() => this.renderer?.resize());
    this.refreshSelection(true);
    this.refreshCommands(true);
    this.elements.tutorialToast.classList.add("hidden");
    window.setTimeout(() => {
      if (!this.game || this.game.matchEnded) return;
      this.showTutorial("先选择乡勇，右键浆果丛或树木即可开始采集。空格键可随时回到城镇中心。", "初入郾城");
    }, 2800);
  }

  showMenu() {
    this.elements.menu.classList.remove("hidden");
    requestAnimationFrame(() => this.elements.menu.classList.remove("leaving"));
    this.elements.pauseOverlay.classList.add("hidden");
    this.elements.endOverlay.classList.add("hidden");
    this.elements.codexOverlay.classList.add("hidden");
    this.elements.tutorialToast.classList.add("hidden");
    ["topbar", "objectivePanel", "alertFeed", "bottombar"].forEach((id) => this.elements[id]?.classList.add("hidden"));
    this.pauseOpen = false;
    this.codexOpen = false;
  }

  hideLoading() {
    window.setTimeout(() => this.elements.loadingScreen.classList.add("ready"), 300);
  }

  update(dt) {
    this.lastUpdate += dt;
    if (this.lastUpdate < 0.12 || !this.game) return;
    this.lastUpdate = 0;
    this.refreshResources();
    this.refreshSelection();
    this.refreshCommands();
    this.refreshObjectives();
    this.refreshCounters();
    this.refreshQueue();
  }

  refreshResources() {
    const game = this.game;
    const resources = game.player.resources;
    const formatted = {
      food: Math.floor(resources.food),
      wood: Math.floor(resources.wood),
      gold: Math.floor(resources.gold),
      stone: Math.floor(resources.stone),
    };
    for (const key of Object.keys(formatted)) {
      const capital = key[0].toUpperCase() + key.slice(1);
      const node = this.elements[`res${capital}`];
      node.textContent = formatted[key];
      if (this.previousResources && this.previousResources[key] !== formatted[key]) {
        const pill = node.closest(".res-pill");
        pill.classList.remove("flash");
        void pill.offsetWidth;
        pill.classList.add("flash");
      }
      const rate = this.elements[`rate${capital}`];
      const value = Math.round(game.getPlayerRates()[key]);
      rate.textContent = value > 0 ? `+${value}/m` : "";
    }
    this.previousResources = formatted;
    const pop = game.getPopulation("player");
    this.elements.population.textContent = `${pop.population} / ${pop.capacity}`;
    this.elements.population.style.color = pop.population >= pop.capacity ? "#d98269" : "";

    const age = game.player.age;
    this.elements.ageNumeral.textContent = AGES[age].numeral;
    this.elements.ageName.textContent = AGES[age].name;
    const tc = game.getTownCenter("player");
    const progress = tc?.research?.kind === "age" ? tc.research.progress / 100 : 0;
    this.elements.ageProgress.style.transform = `scaleX(${progress})`;
    this.elements.gameClock.textContent = formatTime(game.time);
    this.elements.ageButton.title =
      age < AGES.length - 1
        ? `当前：${AGES[age].title}。点击城镇中心以推进至${AGES[age + 1].name}时代。`
        : "王朝已至鼎盛。";
  }

  refreshSelection(force = false) {
    if (!this.game) return;
    const selected = this.game.getSelectedEntities();
    const ids = selected.map((entity) => entity.id).join(",");
    const hpValues = selected.map((entity) => Math.round((entity.hp / entity.maxHp) * 100)).join(",");
    const signature = `${ids}|${hpValues}|${selected[0]?.type ?? ""}`;
    if (!force && signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    if (!selected.length) {
      this.elements.emptySelection.classList.remove("hidden");
      this.elements.selectionContent.classList.add("hidden");
      return;
    }
    this.elements.emptySelection.classList.add("hidden");
    this.elements.selectionContent.classList.remove("hidden");
    const primary = selected.find((entity) => entity.kind === "building") ?? selected[0];
    const totalHp = selected.reduce((sum, entity) => sum + entity.hp, 0);
    const maxHp = selected.reduce((sum, entity) => sum + entity.maxHp, 0);
    const sameType = selected.every((entity) => entity.type === primary.type && entity.kind === primary.kind);
    const def = primary.kind === "unit" ? UNIT_DEFS[primary.type] : BUILD_DEFS[primary.type];
    if (!def) return;
    const icon = sameType ? def.icon : primary.kind === "unit" ? "i-sword" : "i-flag";
    this.elements.selectionPortrait.innerHTML = svgIcon(icon);
    this.elements.selectionPortrait.classList.toggle("enemy", primary.owner !== "player");
    this.elements.selectionName.textContent = sameType ? def.name : primary.kind === "unit" ? "混编部队" : `${def.name}编组`;
    this.elements.selectionCount.textContent = selected.length > 1 ? `×${selected.length}` : "";
    this.elements.selectionSubtitle.textContent =
      primary.kind === "building"
        ? def.description
        : sameType
          ? def.subtitle
          : this.describeComposition(selected);
    const hpRatio = maxHp > 0 ? totalHp / maxHp : 0;
    this.elements.selectionHealth.style.width = `${hpRatio * 100}%`;
    this.elements.selectionHealth.classList.toggle("low", hpRatio < 0.35);
    this.elements.selectionHealthText.textContent = `${Math.ceil(totalHp)} / ${Math.ceil(maxHp)}`;
    this.elements.selectionStats.innerHTML = this.selectionStats(selected, primary, sameType);
    this.renderUnitChips(selected);
  }

  describeComposition(units) {
    const counts = {};
    for (const unit of units) {
      if (unit.kind !== "unit") continue;
      counts[UNIT_DEFS[unit.type].name] = (counts[UNIT_DEFS[unit.type].name] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, count]) => `${name}×${count}`)
      .join(" · ");
  }

  selectionStats(selected, primary, sameType) {
    if (primary.kind === "building") {
      const def = BUILD_DEFS[primary.type];
      const values = [`<span>护甲 <b>${def.armor}</b></span>`];
      if (def.pop) values.push(`<span>人口 <b>+${def.pop}</b></span>`);
      if (def.drop) values.push(`<span>交卸 <b>${def.drop.length} 类</b></span>`);
      if (!primary.complete) values.push(`<span>营造 <b>${Math.floor(primary.constructionProgress)}%</b></span>`);
      if (primary.research) values.push(`<span>${escapeHtml(primary.research.name)} <b>${Math.floor(primary.research.progress)}%</b></span>`);
      return values.join("");
    }
    if (!sameType) {
      const worker = selected.filter((entity) => entity.type === "villager").length;
      const army = selected.length - worker;
      return `<span>乡勇 <b>${worker}</b></span><span>军队 <b>${army}</b></span><span>右键下令 <b>移动 / 交战</b></span>`;
    }
    const def = UNIT_DEFS[primary.type];
    const stats = this.game.getUnitStats(primary);
    const values = [
      `<span>攻击 <b>${stats.damage.toFixed(1)}</b></span>`,
      `<span>护甲 <b>${stats.armor}</b></span>`,
      `<span>射程 <b>${stats.range.toFixed(1)}</b></span>`,
      `<span>移速 <b>${stats.speed.toFixed(1)}</b></span>`,
    ];
    if (primary.type === "villager") {
      values.push(`<span>携行 <b>${Math.floor(primary.carry)} / 10</b></span>`);
      if (primary.task.type === "gather") values.push(`<span>采集 <b>${this.taskLabel(primary.task)}</b></span>`);
    }
    return values.join("");
  }

  taskLabel(task) {
    if (task.phase === "gathering") return UNIT_DEFS.villager.name;
    if (task.phase === "returning") return "运送资源";
    return "前往资源点";
  }

  renderUnitChips(selected) {
    const units = selected.filter((entity) => entity.kind === "unit");
    this.elements.unitGrid.innerHTML = units
      .slice(0, 11)
      .map((unit) => `<button class="unit-chip" data-id="${unit.id}" title="${escapeHtml(UNIT_DEFS[unit.type].name)}">${svgIcon(UNIT_DEFS[unit.type].icon)}</button>`)
      .join("");
    if (units.length > 11) {
      this.elements.unitGrid.insertAdjacentHTML("beforeend", `<span class="unit-chip more">+${units.length - 11}</span>`);
    }
  }

  refreshCommands(force = false) {
    if (!this.game) return;
    const selected = this.game.getSelectedEntities();
    const resources = this.game.player.resources;
    const ids = selected.map((entity) => entity.id).join(",");
    const building = selected.find((entity) => entity.kind === "building");
    const workers = selected.filter((entity) => entity.kind === "unit" && entity.type === "villager");
    const military = selected.filter((entity) => entity.kind === "unit" && entity.type !== "villager");
    const resKey = Object.values(resources).map((value) => Math.floor(value / 10)).join(",");
    const queueKey = building ? `${building.productionQueue.join(".")}|${building.progress}|${building.research?.progress ?? ""}` : "";
    const signature = `${ids}|${this.game.player.age}|${resKey}|${queueKey}|${building?.complete}`;
    if (!force && signature === this.commandSignature) return;
    this.commandSignature = signature;
    this.commandMap.clear();
    this.hotkeyMap.clear();
    let commands = [];
    let title = "基础命令";
    let hint = "Q W E R";

    if (building) {
      title = BUILD_DEFS[building.type].name;
      hint = "建筑生产";
      commands = this.buildingCommands(building);
    } else if (workers.length) {
      title = "百工营造";
      hint = "Q W E R T / Z X C V B";
      commands = this.buildMenuCommands(workers);
    } else if (military.length) {
      title = "军阵命令";
      hint = "A / S";
      commands = this.militaryCommands(military);
    } else {
      title = "基础命令";
      hint = "选择单位";
    }
    this.elements.commandTitle.textContent = title;
    this.elements.commandHint.textContent = hint;
    this.renderCommands(commands);
  }

  buildMenuCommands(workers) {
    return BUILD_MENU.map((type, index) => {
      const def = BUILD_DEFS[type];
      const hotkey = BUILD_HOTKEYS[index];
      const locked = (def.unlockAge ?? 0) > this.game.player.age;
      const affordable = this.game.canSpend("player", def.cost);
      return {
        id: `build_${type}`,
        label: def.name,
        icon: def.icon,
        hotkey,
        cost: def.cost,
        description: locked ? `需要进入「${AGES[def.unlockAge].name}」时代。` : def.description,
        locked,
        disabled: locked || !affordable || workers.length === 0,
        action: () => {
          this.game.beginPlacement(type);
          this.callbacks.onPlacementMode?.(true);
        },
      };
    });
  }

  militaryCommands(units) {
    return [
      {
        id: "attack_move",
        label: "攻击移动",
        icon: "i-target",
        hotkey: "a",
        description: "向指定地点进军，沿途主动攻击遭遇的敌人。",
        action: () => {
          this.game.commandMode = "attackMove";
          this.callbacks.onAttackMoveMode?.(true);
        },
      },
      {
        id: "stop",
        label: "停止",
        icon: "i-stop",
        hotkey: "s",
        description: "让所选部队立即停止当前行动。",
        action: () => {
          this.game.stopUnits(units);
          this.audio.play("command");
        },
      },
      {
        id: "select_army",
        label: "召集全军",
        icon: "i-sword",
        description: "快速选择战场上的全部军队，不包括乡勇。",
        action: () => {
          this.game.selectAllArmy();
          this.audio.play("select");
        },
      },
    ];
  }

  buildingCommands(building) {
    const def = BUILD_DEFS[building.type];
    const commands = [];
    if (!building.complete) return commands;
    if (def.train) {
      for (const unitType of def.train) {
        const unitDef = UNIT_DEFS[unitType];
        const locked = (unitDef.unlockAge ?? 0) > this.game.player.age;
        const cost = getUnitCost(unitType, this.game.player.civId);
        const affordable = this.game.canSpend("player", cost);
        const pop = this.game.getPopulation("player");
        const popFull = pop.population + building.productionQueue.length >= pop.capacity;
        commands.push({
          id: `train_${unitType}`,
          label: unitDef.name,
          icon: unitDef.icon,
          hotkey: UNIT_HOTKEYS[unitType],
          cost,
          time: unitDef.buildTime,
          description: `${unitDef.subtitle}。${unitDef.bonus}`,
          locked,
          disabled: locked || !affordable || popFull || building.productionQueue.length >= 6,
          status: popFull ? "人口已满" : locked ? `需${AGES[unitDef.unlockAge].name}时代` : "",
          action: () => {
            if (this.game.startTraining(building.id, unitType)) this.audio.play("train");
          },
        });
      }
    }
    if (def.research) {
      for (const techId of def.research) {
        const tech = TECH_DEFS[techId];
        const researched = this.game.player.techs[techId];
        const affordable = this.game.canSpend("player", tech.cost);
        commands.push({
          id: `tech_${techId}`,
          label: tech.name,
          icon: tech.icon,
          hotkey: TECH_HOTKEYS[techId],
          cost: tech.cost,
          time: tech.time,
          description: tech.description,
          disabled: researched || !!building.research || !affordable,
          status: researched ? "已研习" : "",
          action: () => {
            if (this.game.startResearch(building.id, techId)) this.audio.play("complete");
          },
        });
      }
    }
    if (building.type === "townCenter") {
      const nextAge = AGES[this.game.player.age + 1];
      if (nextAge && !building.research) {
        commands.push({
          id: "advance_age",
          label: nextAge.name,
          icon: "i-crown",
          hotkey: "r",
          cost: nextAge.cost,
          time: nextAge.time,
          description: `${nextAge.description} ${nextAge.passive}`,
          disabled: !this.game.canSpend("player", nextAge.cost),
          action: () => {
            if (this.game.startAgeAdvance(building.id)) this.audio.play("age");
          },
        });
      } else if (building.research?.kind === "age") {
        commands.push({
          id: "cancel_age",
          label: "停止演进",
          icon: "i-stop",
          hotkey: "r",
          description: "中止时代演进并返还资源。",
          action: () => {
            this.game.cancelAgeAdvance(building.id);
            this.audio.play("click");
          },
        });
      }
    }
    return commands;
  }

  renderCommands(commands) {
    this.elements.commandGrid.innerHTML = "";
    commands.forEach((command, index) => {
      const button = document.createElement("button");
      button.className = `command-button${command.disabled ? " disabled" : ""}${command.locked ? " locked" : ""}${command.id === "attack_move" ? " primary-command" : ""}`;
      button.dataset.commandId = command.id;
      button.dataset.tipTitle = command.label;
      button.dataset.tipDescription = command.description;
      button.dataset.tipCost = command.cost ? formatCost(command.cost) : "";
      button.dataset.tipStatus = command.status || "";
      button.dataset.tipTime = command.time ? `${command.time} 秒` : "";
      button.innerHTML = `${command.hotkey ? `<kbd>${command.hotkey.toUpperCase()}</kbd>` : ""}${svgIcon(command.icon)}<span>${escapeHtml(command.label)}</span>${
        command.cost ? `<small>${escapeHtml(formatCost(command.cost))}</small>` : ""
      }`;
      this.commandMap.set(command.id, command);
      if (command.hotkey) this.hotkeyMap.set(command.hotkey.toLowerCase(), command);
      this.elements.commandGrid.appendChild(button);
    });
    if (!commands.length) {
      this.elements.commandGrid.innerHTML =
        '<div class="command-button disabled"><svg><use href="#i-tower"></use></svg><span>营造中</span><small>等待乡勇</small></div>';
    }
  }

  executeCommand(command) {
    if (!command) return false;
    command.action();
    this.audio.play("click");
    this.hideTip();
    this.commandSignature = "";
    return true;
  }

  executeHotkey(key) {
    const command = this.hotkeyMap.get(key.toLowerCase());
    return command ? this.executeCommand(command) : false;
  }

  refreshQueue() {
    if (!this.game) return;
    const selected = this.game.getSelectedEntities();
    const building = selected.find((entity) => entity.kind === "building");
    if (!building || (!building.productionQueue.length && !building.research)) {
      this.elements.queuePanel.classList.add("hidden");
      return;
    }
    this.elements.queuePanel.classList.remove("hidden");
    const progress = building.productionQueue.length ? building.productionProgress : building.research?.progress ?? 0;
    const queue = building.productionQueue.map(
      (type, index) => `<div class="queue-item" title="${escapeHtml(UNIT_DEFS[type].name)}">${svgIcon(UNIT_DEFS[type].icon)}${
        index === 0 ? `<i class="queue-progress" style="transform:scaleX(${progress / 100})"></i>` : ""
      }</div>`,
    );
    if (building.research) {
      const icon = building.research.kind === "age" ? "i-crown" : TECH_DEFS[building.research.id]?.icon ?? "i-book";
      queue.unshift(
        `<div class="queue-item" title="${escapeHtml(building.research.name)}">${svgIcon(icon)}<i class="queue-progress" style="transform:scaleX(${progress / 100})"></i></div>`,
      );
    }
    this.elements.queuePanel.innerHTML = `<span class="queue-label">队列</span>${queue.join("")}`;
  }

  refreshObjectives() {
    if (!this.game) return;
    const own = this.game.unitList.filter((unit) => unit.alive && unit.owner === "player");
    const military = own.filter((unit) => UNIT_DEFS[unit.type].category !== "worker");
    const houses = this.game.buildingList.filter(
      (building) => building.alive && building.owner === "player" && building.type === "house" && building.complete,
    );
    const barracks = this.game.buildingList.filter(
      (building) => building.alive && building.owner === "player" && building.type === "barracks" && building.complete,
    );
    this.objectives = [
      { id: "pop", text: "人口达到 10", done: this.game.getPopulation("player").population >= 10 },
      { id: "house", text: "营造一座民居", done: houses.length >= 1 },
      { id: "army", text: "兵营建成，军队达到 6 人", done: barracks.length > 0 && military.length >= 6 },
      { id: "victory", text: "摧毁敌军城镇中心", done: !this.game.getTownCenter("enemy") },
    ];
    const signature = this.objectives.map((objective) => `${objective.done}`).join("");
    if (signature === this.objectiveSignature) return;
    this.objectiveSignature = signature;
    this.elements.objectiveBody.innerHTML = `<ul class="objectives">${this.objectives
      .map((objective) => `<li class="${objective.done ? "done" : ""}">${objective.text}</li>`)
      .join("")}</ul><p class="objective-note">守住中军大营，发展经济并攻破东境敌军本阵。历史难度不会改变胜负目标。</p>`;
  }

  refreshCounters() {
    const idle = this.game.getIdleVillagers().length;
    this.elements.idleCount.textContent = idle;
    const army = this.game.unitList.filter(
      (unit) => unit.alive && unit.owner === "player" && UNIT_DEFS[unit.type].category !== "worker",
    ).length;
    this.elements.armyCount.textContent = army;
    const center = this.renderer?.screenToWorld(this.renderer.width / 2, this.renderer.height / 2);
    if (center) {
      const region = center.x < 22 ? "西营平野" : center.x > 34 ? "东境驿道" : center.y < 22 ? "北邙林麓" : center.y > 35 ? "南榆川" : "颍水河湾";
      this.elements.mapCoordinate.textContent = `中原 · ${region}`;
    }
  }

  addAlert(message, type = "info") {
    if (!this.elements.alertFeed) return;
    const alert = document.createElement("div");
    alert.className = `alert ${type}`;
    alert.textContent = message;
    this.elements.alertFeed.appendChild(alert);
    while (this.elements.alertFeed.children.length > 3) this.elements.alertFeed.firstElementChild.remove();
    const timeout = window.setTimeout(() => {
      alert.classList.add("leaving");
      window.setTimeout(() => alert.remove(), 320);
      this.alertTimeouts.delete(timeout);
    }, 4400);
    this.alertTimeouts.add(timeout);
    if (type === "warning") this.audio.play("warning");
  }

  underAttack() {
    if (document.querySelector(".damage-toast")) return;
    const toast = document.createElement("div");
    toast.className = "damage-toast";
    toast.textContent = "军垒遇袭";
    document.getElementById("app").appendChild(toast);
    window.setTimeout(() => toast.remove(), 1700);
  }

  showTip(button, event) {
    const tip = this.elements.tooltip;
    if (!button) return;
    tip.dataset.title = button.dataset.tipTitle ?? "";
    tip.innerHTML = `${escapeHtml(button.dataset.tipDescription ?? "")}${
      button.dataset.tipStatus ? `<div class="tip-warning">${escapeHtml(button.dataset.tipStatus)}</div>` : ""
    }${button.dataset.tipCost ? `<div class="tip-cost"><strong>${escapeHtml(button.dataset.tipCost)}</strong>${
      button.dataset.tipTime ? `　${escapeHtml(button.dataset.tipTime)}` : ""
    }</div>` : ""}`;
    tip.classList.remove("hidden");
    const rect = button.getBoundingClientRect();
    const width = 245;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
    const top = Math.max(8, rect.top - tip.offsetHeight - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  hideTip() {
    this.elements.tooltip.classList.add("hidden");
  }

  updateSoundButton() {
    const use = this.elements.soundButton.querySelector("use");
    use.setAttribute("href", this.soundMuted ? "#i-mute" : "#i-sound");
    this.elements.soundButton.classList.toggle("active", !this.soundMuted);
    this.elements.soundButton.title = this.soundMuted ? "开启声音" : "静音";
  }

  setCommandCursor(mode, mouseX, mouseY) {
    if (!mode) {
      this.elements.commandCursor.classList.add("hidden");
      this.elements.gameCanvas.classList.remove("command-mode");
      return;
    }
    this.elements.commandCursor.classList.remove("hidden");
    this.elements.gameCanvas.classList.add("command-mode");
    const icon = mode === "attackMove" ? "i-target" : mode === "placement" ? "i-house" : "i-sword";
    this.elements.commandCursor.querySelector("use").setAttribute("href", `#${icon}`);
    this.elements.commandCursor.querySelector("span").textContent = mode === "attackMove" ? "攻击移动" : mode === "placement" ? "安排营造" : "攻击";
    this.moveCommandCursor(mouseX, mouseY);
  }

  moveCommandCursor(x, y) {
    this.elements.commandCursor.style.left = `${x}px`;
    this.elements.commandCursor.style.top = `${y}px`;
  }

  togglePause(force = null) {
    if (!this.game || this.game.state === "menu" || this.game.matchEnded) return;
    const shouldPause = force === null ? !this.pauseOpen : force;
    if (shouldPause) {
      this.game.pause();
      this.elements.pauseOverlay.classList.remove("hidden");
      this.pauseOpen = true;
    } else {
      this.game.resume();
      this.elements.pauseOverlay.classList.add("hidden");
      this.pauseOpen = false;
      if (this.codexOpen) this.closeCodex(true);
    }
  }

  openCodex(page = "history") {
    this.codexOpen = true;
    this.setCodexPage(page);
    this.elements.codexOverlay.classList.remove("hidden");
    if (this.game?.state === "playing") {
      this.game.pause();
      this.resumeAfterCodex = true;
    }
    this.audio.play("click");
  }

  closeCodex(forceNoResume = false) {
    this.elements.codexOverlay.classList.add("hidden");
    this.codexOpen = false;
    if (this.resumeAfterCodex && !forceNoResume && this.game?.state === "paused" && !this.pauseOpen) this.game.resume();
    this.resumeAfterCodex = false;
  }

  setCodexPage(page) {
    this.codexPage = page;
    document.querySelectorAll(".codex-nav [data-codex-page]").forEach((button) => button.classList.toggle("active", button.dataset.codexPage === page));
    this.showCodexPage(page);
  }

  showCodexPage(page) {
    const content = this._elements.codexContent;
    if (!content) return;
    if (page === "history") {
      content.innerHTML = `
        <span class="codex-overline">ANNALES · SHAOXING 10</span>
        <h2>山河纪事</h2>
        <div class="codex-rule"></div>
        <p>绍兴十年（1140）夏，宋金战事再起。岳飞率军北上，连复颍昌、陈州、郑州等地；完颜宗弼调集骑军南下，双方在郾城、颍昌一带交锋。本作以这场战争为灵感，将庞大的战场压缩为一局可掌控的营垒攻防。</p>
        <p class="codex-quote">“兵者，国之大事，死生之地，存亡之道，不可不察也。”——《孙子兵法·始计》</p>
        <p>你将从一座城镇中心起步：安抚百姓、开垦田亩、砍伐林木、开采金石；再兴兵营、筑箭塔、修甲砺兵。对岸的敌军也会发展经济并集结军队，战机不会长久停留在你这一边。</p>
        <div class="codex-grid">
          <div class="codex-entry"><h3>${svgIcon("i-flag")}战场</h3><p>颍水纵贯中原，两条石桥是主要渡口。树林、矿脉与河道共同塑造了攻守路线。</p></div>
          <div class="codex-entry"><h3>${svgIcon("i-crown")}时代</h3><p>开国、承平、鼎盛三个阶段逐步解锁骑军、军械坊、箭塔与攻城器械，并强化全军。</p></div>
          <div class="codex-entry"><h3>${svgIcon("i-pop")}胜负</h3><p>摧毁敌军城镇中心即可取得胜利；自己的城镇中心陷落则战败。奇袭与正面推进都由你决定。</p></div>
          <div class="codex-entry"><h3>${svgIcon("i-book")}史实边界</h3><p>资源数值、建筑形制与战术机制为可玩性设计。史料中的编制、装备与地名随时代和记载存在差异，不以本作代替史学研究。</p></div>
        </div>`;
    } else if (page === "army") {
      content.innerHTML = `
        <span class="codex-overline">MILITARY TREATISE</span>
        <h2>兵戈谱</h2>
        <div class="codex-rule"></div>
        <p>单靠一种兵种难以取胜。长枪兵抵住铁骑，弓手在阵后输出，铁骑绕后袭击弓手；到了鼎盛时代，旋风炮能迅速撕开营垒与箭塔。观察敌军编成，再决定你的阵列。</p>
        <div class="codex-grid">
          ${Object.values(UNIT_DEFS)
            .map(
              (unit) => `<div class="codex-entry"><h3>${svgIcon(unit.icon)}${unit.name}</h3><p>${unit.bonus}</p><div class="entry-stat">生命 ${unit.hp} · 攻击 ${unit.damage} · 护甲 ${unit.armor} · ${formatCost(unit.cost)}</div></div>`,
            )
            .join("")}
        </div>
        <p style="margin-top:18px">文明特色：大宋弓手射程增加，农田采集更快；大金铁骑拥有更高移速与护甲，且造价更低。</p>`;
    } else if (page === "economy") {
      content.innerHTML = `
        <span class="codex-overline">CRAFT &amp; PROVISION</span>
        <h2>百工录</h2>
        <div class="codex-rule"></div>
        <p>乡勇会把采得的资源送回城镇中心或相应交卸建筑。伐木场、磨坊与矿作营能缩短往返路程，是扩大经济效率的关键。民居提供人口上限；人口已满时无法继续训练军队。</p>
        <div class="codex-grid">
          ${["house", "farm", "lumberCamp", "mill", "miningCamp", "barracks", "archeryRange", "stable", "blacksmith", "tower"]
            .map((type) => {
              const def = BUILD_DEFS[type];
              return `<div class="codex-entry"><h3>${svgIcon(def.icon)}${def.name}</h3><p>${def.description}</p><div class="entry-stat">生命 ${def.hp} · 占地 ${def.size}×${def.size} · ${formatCost(def.cost)}</div></div>`;
            })
            .join("")}
        </div>`;
    } else {
      content.innerHTML = `
        <span class="codex-overline">FIELD MANUAL</span>
        <h2>行军要略</h2>
        <div class="codex-rule"></div>
        <p>熟练运用编队、攻击移动与集结点，可以显著提升作战效率。右键是情境命令：点在树上即采集，点在敌人上即攻击，点在受损友军建筑上即修理。</p>
        <div class="controls-grid">
          ${CONTROL_GROUPS.map(
            (group) => `<div class="control-group"><h3>${group.title}</h3>${group.rows
              .map(([action, key]) => `<div class="control-row"><span>${action}</span><kbd>${key}</kbd></div>`)
              .join("")}</div>`,
          ).join("")}
        </div>`;
    }
    content.scrollTop = 0;
  }

  showTutorial(text, kicker = "军中新令") {
    this.elements.tutorialText.textContent = text;
    this.elements.tutorialKicker.textContent = kicker;
    this.elements.tutorialToast.classList.remove("hidden");
    window.clearTimeout(this.tutorialTimer);
    this.tutorialTimer = window.setTimeout(() => this.hideTutorial(), 10500);
  }

  hideTutorial() {
    this.elements.tutorialToast.classList.add("hidden");
    window.clearTimeout(this.tutorialTimer);
  }

  showBattleIntro(civ, callback) {
    const intro = document.createElement("div");
    intro.className = "battle-intro";
    intro.innerHTML = `
      <div class="battle-intro-kicker">绍兴十年 · 中原</div>
      <div class="battle-intro-title">郾城风云</div>
      <div class="battle-intro-line"></div>
      <p>${civ.name}营垒 · 颍水西岸</p>
      <small>摧毁敌军城镇中心，平定东境</small>`;
    document.getElementById("app").appendChild(intro);
    requestAnimationFrame(() => intro.classList.add("visible"));
    window.setTimeout(() => {
      intro.classList.add("leaving");
      callback?.();
      window.setTimeout(() => intro.remove(), 900);
    }, 2350);
  }

  showEnd(winner, game) {
    const victory = winner === "player";
    this.elements.endOverlay.classList.remove("hidden");
    this.elements.endOverlay.querySelector(".end-card").classList.toggle("defeat", !victory);
    this.elements.endSeal.textContent = victory ? "捷" : "殇";
    this.elements.endKicker.textContent = victory ? "郾城既定" : "中军失守";
    this.elements.endTitle.textContent = victory ? "山河重定" : "长河落日";
    this.elements.endDescription.textContent = victory
      ? "敌军中军大营已经陷落。颍水两岸旌旗尽归麾下，这一战的功过将写进你亲手铺开的山河。"
      : "城镇中心已经失守，王师被迫退往南岸。重整旗鼓，再图北伐。";
    const gathered = Object.values(game.player.stats.gathered).reduce((a, b) => a + b, 0);
    this.elements.endStats.innerHTML = `
      <div class="end-stat"><b>${formatTime(game.time)}</b><span>战局时长</span></div>
      <div class="end-stat"><b>${game.player.stats.killed}</b><span>歼敌数量</span></div>
      <div class="end-stat"><b>${game.player.stats.trained}</b><span>训练兵力</span></div>
      <div class="end-stat"><b>${Math.floor(gathered)}</b><span>采集资源</span></div>`;
    this.audio.play(victory ? "victory" : "defeat");
  }

  getHotkeyCommand(key) {
    return this.hotkeyMap.get(key.toLowerCase()) ?? null;
  }

  hasOverlayOpen() {
    return this.pauseOpen || this.codexOpen || this.game?.matchEnded;
  }
}
