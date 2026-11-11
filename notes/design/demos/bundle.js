(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // notes/design/demos/app.js
  var exports_app = {};
  __export(exports_app, {
    EMOTION_STATES: () => EMOTION_STATES,
    PRESET_REPLIES: () => PRESET_REPLIES,
    ROOM_DESCRIPTIONS: () => ROOM_DESCRIPTIONS,
    THEME_CONFIGS: () => THEME_CONFIGS,
    initEchoreDemo: () => initEchoreDemo
  });

  // notes/design/demos/pixel-mascot.js
  class PixelCatRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.gridSize = 32;
      this.displaySize = 56;
      this.tick = 0;
      this.sparkles = [];
      this.themeMode = "day";
      this.expression = "normal";
      this.action = "idle";
      this.facing = 1;
      this.blinkTimer = 0;
      this.initCanvas();
    }
    initCanvas() {
      this.canvas.width = this.gridSize;
      this.canvas.height = this.gridSize;
      this.canvas.style.width = `${this.displaySize}px`;
      this.canvas.style.height = `${this.displaySize}px`;
      this.ctx.imageSmoothingEnabled = false;
    }
    setThemeMode(mode) {
      this.themeMode = mode;
    }
    setExpression(expr) {
      this.expression = expr;
      if (expr === "happy") {
        this.spawnHeartBurst();
      } else if (expr === "yearning") {
        this.spawnWarmDust();
      }
    }
    setAction(act, facing = 1) {
      this.action = act;
      this.facing = facing;
    }
    spawnHeartBurst() {
      for (let i = 0;i < 4; i++) {
        this.sparkles.push({
          x: 16 + (Math.random() * 8 - 4),
          y: 8 + (Math.random() * 4 - 2),
          vx: (Math.random() - 0.5) * 0.7,
          vy: -0.6 - Math.random() * 0.5,
          life: 26,
          maxLife: 26,
          type: "heart"
        });
      }
    }
    spawnWarmDust() {
      for (let i = 0;i < 3; i++) {
        this.sparkles.push({
          x: 16 + (Math.random() * 10 - 5),
          y: 12 + (Math.random() * 6 - 3),
          vx: (Math.random() - 0.5) * 0.4,
          vy: -0.3 - Math.random() * 0.4,
          life: 24,
          maxLife: 24,
          type: "star"
        });
      }
    }
    spawnFootprintSparkle(x, y) {
      if (Math.random() > 0.4)
        return;
      this.sparkles.push({
        x: x + (Math.random() * 3 - 1),
        y,
        vx: (Math.random() - 0.5) * 0.2,
        vy: -0.15,
        life: 14,
        maxLife: 14,
        type: "dust"
      });
    }
    renderFrame() {
      this.tick++;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.gridSize, this.gridSize);
      this.blinkTimer++;
      const isBlinking = this.blinkTimer % 110 > 104;
      ctx.save();
      if (this.facing === -1) {
        ctx.translate(32, 0);
        ctx.scale(-1, 1);
      }
      const currentAct = this.resolveActiveAction();
      switch (currentAct) {
        case "walk":
          this.drawCatWalking(isBlinking);
          break;
        case "loaf":
        case "sit":
          this.drawCatLoaf(isBlinking);
          break;
        case "peep":
          this.drawCatPeeping(isBlinking);
          break;
        case "sleep":
          this.drawCatSleeping();
          break;
        case "knead":
          this.drawCatKneading(isBlinking);
          break;
        case "groom":
          this.drawCatGrooming(isBlinking);
          break;
        case "idle":
        default:
          this.drawCatIdle(isBlinking);
          break;
      }
      this.drawExpressionEmbellishments();
      ctx.restore();
      this.drawSparkles();
    }
    resolveActiveAction() {
      if (this.expression === "sleepy")
        return "sleep";
      if (this.action === "walk")
        return "walk";
      if (this.action === "peep")
        return "peep";
      if (this.action === "sit" || this.action === "loaf")
        return "loaf";
      if (this.expression === "yearning" && this.action === "idle") {
        return "knead";
      }
      if (this.expression === "solitary" && this.action === "idle") {
        return "groom";
      }
      if (this.expression === "alienated" && this.action === "idle") {
        return "loaf";
      }
      return this.action || "idle";
    }
    getPalette() {
      const isNight = this.themeMode === "night";
      return {
        outline: isNight ? "#121110" : "#1E1D1B",
        furDark: isNight ? "#423E3A" : "#4A4642",
        furMid: isNight ? "#5E5953" : "#6E6861",
        furLight: isNight ? "#8A847C" : "#9E978F",
        white: "#FAF8F5",
        whiteShadow: isNight ? "#C9C4B9" : "#E2DDD2",
        pinkEar: "#E5989B",
        pinkNose: "#D87D83",
        eyeDark: "#151413",
        eyeGlint: "#FFFFFF",
        whisker: isNight ? "#C4BFB5" : "#D5D0C6",
        accentClay: "#D97757"
      };
    }
    drawPixel(x, y, color) {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    drawRect(x, y, w, h, color) {
      this.ctx.fillStyle = color;
      this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }
    drawEars(headX, headY, palette) {
      if (this.expression === "aggrieved") {
        this.drawAirplaneEars(headX, headY, palette);
        return;
      }
      const twitch = this.tick % 90 < 8 && this.action === "idle" ? 1 : 0;
      this.drawRect(headX + 2, headY - 4 - twitch, 3, 1, palette.outline);
      this.drawRect(headX + 1, headY - 3 - twitch, 1, 4, palette.outline);
      this.drawRect(headX + 5, headY - 3 - twitch, 1, 3, palette.outline);
      this.drawRect(headX + 2, headY - 3 - twitch, 3, 3, palette.furDark);
      this.drawRect(headX + 2, headY - 2 - twitch, 2, 2, palette.pinkEar);
      this.drawRect(headX + 9, headY - 4, 3, 1, palette.outline);
      this.drawRect(headX + 8, headY - 3, 1, 3, palette.outline);
      this.drawRect(headX + 12, headY - 3, 1, 4, palette.outline);
      this.drawRect(headX + 9, headY - 3, 3, 3, palette.furDark);
      this.drawRect(headX + 10, headY - 2, 2, 2, palette.pinkEar);
    }
    drawAirplaneEars(headX, headY, palette) {
      this.drawRect(headX - 3, headY - 1, 4, 1, palette.outline);
      this.drawRect(headX - 4, headY, 1, 2, palette.outline);
      this.drawRect(headX - 3, headY + 2, 4, 1, palette.outline);
      this.drawRect(headX - 3, headY, 4, 2, palette.furDark);
      this.drawRect(headX - 2, headY, 3, 1, palette.pinkEar);
      this.drawRect(headX + 13, headY - 1, 4, 1, palette.outline);
      this.drawRect(headX + 17, headY, 1, 2, palette.outline);
      this.drawRect(headX + 13, headY + 2, 4, 1, palette.outline);
      this.drawRect(headX + 13, headY, 4, 2, palette.furDark);
      this.drawRect(headX + 13, headY, 3, 1, palette.pinkEar);
    }
    drawFaceFeatures(headX, headY, palette, isBlinking) {
      this.drawRect(headX + 6, headY + 3, 3, 5, palette.white);
      this.drawRect(headX + 5, headY + 6, 5, 2, palette.white);
      const eyeY = headY + 3;
      if (this.expression === "happy") {
        this.drawPixel(headX + 3, eyeY, palette.eyeDark);
        this.drawPixel(headX + 4, eyeY - 1, palette.eyeDark);
        this.drawPixel(headX + 5, eyeY, palette.eyeDark);
        this.drawPixel(headX + 9, eyeY, palette.eyeDark);
        this.drawPixel(headX + 10, eyeY - 1, palette.eyeDark);
        this.drawPixel(headX + 11, eyeY, palette.eyeDark);
      } else if (this.expression === "sleepy" || isBlinking) {
        this.drawRect(headX + 3, eyeY + 1, 3, 1, palette.eyeDark);
        this.drawRect(headX + 9, eyeY + 1, 3, 1, palette.eyeDark);
      } else if (this.expression === "aggrieved") {
        this.drawRect(headX + 3, eyeY, 3, 2, palette.eyeDark);
        this.drawRect(headX + 9, eyeY, 3, 2, palette.eyeDark);
        this.drawPixel(headX + 3, eyeY, palette.white);
        this.drawPixel(headX + 9, eyeY, palette.white);
        this.drawPixel(headX + 5, eyeY + 1, palette.eyeDark);
        this.drawPixel(headX + 11, eyeY + 1, palette.eyeDark);
      } else if (this.expression === "alienated") {
        this.drawRect(headX + 4, eyeY, 3, 1, palette.eyeDark);
        this.drawRect(headX + 10, eyeY, 3, 1, palette.eyeDark);
      } else {
        this.drawRect(headX + 3, eyeY, 3, 3, palette.eyeDark);
        this.drawPixel(headX + 3, eyeY, palette.eyeGlint);
        this.drawRect(headX + 9, eyeY, 3, 3, palette.eyeDark);
        this.drawPixel(headX + 9, eyeY, palette.eyeGlint);
      }
      this.drawPixel(headX + 7, headY + 5, palette.pinkNose);
      this.drawPixel(headX + 7, headY + 6, palette.outline);
      this.drawPixel(headX + 6, headY + 7, palette.outline);
      this.drawPixel(headX + 8, headY + 7, palette.outline);
      this.drawPixel(headX, headY + 5, palette.whisker);
      this.drawPixel(headX + 1, headY + 5, palette.whisker);
      this.drawPixel(headX - 1, headY + 7, palette.whisker);
      this.drawPixel(headX + 1, headY + 6, palette.whisker);
      this.drawPixel(headX + 13, headY + 5, palette.whisker);
      this.drawPixel(headX + 14, headY + 5, palette.whisker);
      this.drawPixel(headX + 13, headY + 6, palette.whisker);
      this.drawPixel(headX + 15, headY + 7, palette.whisker);
    }
    drawCatIdle(isBlinking) {
      const p = this.getPalette();
      const breath = Math.sin(this.tick * 0.1) * 0.8;
      const by = Math.round(breath);
      const bx = 8;
      const bodyY = 16 + by;
      const tailWag = Math.sin(this.tick * 0.12) * 2;
      const tx = bx + 14;
      const ty = bodyY + 2;
      this.drawRect(tx, ty, 2, 2, p.outline);
      this.drawRect(tx + 1, ty - 2 + tailWag * 0.3, 2, 2, p.furDark);
      this.drawRect(tx + 2, ty - 4 + tailWag * 0.6, 2, 2, p.furDark);
      this.drawRect(tx + 3 + tailWag * 0.4, ty - 6 + tailWag, 2, 3, p.white);
      this.drawRect(tx + 3 + tailWag * 0.4, ty - 7 + tailWag, 2, 1, p.outline);
      this.drawRect(bx, bodyY, 15, 8, p.outline);
      this.drawRect(bx + 1, bodyY + 1, 13, 6, p.furDark);
      this.drawRect(bx + 2, bodyY + 2, 6, 4, p.furMid);
      this.drawRect(bx + 1, bodyY + 4, 8, 3, p.whiteShadow);
      this.drawRect(bx + 1, bodyY + 4, 7, 2, p.white);
      this.drawRect(bx + 10, bodyY + 7, 3, 3, p.outline);
      this.drawRect(bx + 11, bodyY + 7, 2, 2, p.white);
      this.drawRect(bx + 13, bodyY + 7, 2, 3, p.outline);
      this.drawRect(bx + 13, bodyY + 8, 1, 2, p.white);
      this.drawRect(bx + 2, bodyY + 7, 3, 3, p.outline);
      this.drawRect(bx + 2, bodyY + 8, 2, 2, p.white);
      this.drawRect(bx + 5, bodyY + 7, 3, 3, p.outline);
      this.drawRect(bx + 6, bodyY + 8, 2, 2, p.white);
      const hx = bx - 2;
      const hy = bodyY - 7;
      this.drawRect(hx, hy, 15, 9, p.outline);
      this.drawRect(hx + 1, hy + 1, 13, 7, p.furDark);
      this.drawEars(hx, hy, p);
      this.drawFaceFeatures(hx, hy, p, isBlinking);
    }
    drawCatWalking(isBlinking) {
      const p = this.getPalette();
      const frame = Math.floor(this.tick * 0.24) % 4;
      const bob = frame === 0 || frame === 2 ? 1 : 0;
      const bx = 8;
      const by = 16 + bob;
      const tailSwing = Math.sin(this.tick * 0.35) * 2;
      const tx = bx + 14;
      const ty = by - 1;
      this.drawRect(tx, ty, 2, 2, p.outline);
      this.drawRect(tx + 1, ty - 3, 2, 2, p.furDark);
      this.drawRect(tx + 2 + tailSwing * 0.5, ty - 6, 2, 3, p.furDark);
      this.drawRect(tx + 3 + tailSwing, ty - 8, 2, 2, p.white);
      this.drawRect(tx + 3 + tailSwing, ty - 9, 2, 1, p.outline);
      this.drawRect(bx, by, 15, 8, p.outline);
      this.drawRect(bx + 1, by + 1, 13, 6, p.furDark);
      this.drawRect(bx + 2, by + 4, 8, 3, p.white);
      let fLeg1 = 0, fLeg2 = 0, bLeg1 = 0, bLeg2 = 0;
      if (frame === 0) {
        fLeg1 = -1;
        fLeg2 = 1;
        bLeg1 = 1;
        bLeg2 = -1;
      } else if (frame === 1) {
        fLeg1 = 0;
        fLeg2 = 0;
        bLeg1 = 0;
        bLeg2 = 0;
      } else if (frame === 2) {
        fLeg1 = 1;
        fLeg2 = -1;
        bLeg1 = -1;
        bLeg2 = 1;
      } else {
        fLeg1 = 0;
        fLeg2 = 0;
        bLeg1 = 0;
        bLeg2 = 0;
      }
      this.drawRect(bx + 10 + bLeg1, by + 7, 3, 3, p.outline);
      this.drawRect(bx + 11 + bLeg1, by + 8, 2, 2, p.white);
      this.drawRect(bx + 13 + bLeg2, by + 7, 2, 3, p.outline);
      this.drawRect(bx + 13 + bLeg2, by + 8, 1, 2, p.white);
      this.drawRect(bx + 2 + fLeg1, by + 7, 3, 3, p.outline);
      this.drawRect(bx + 2 + fLeg1, by + 8, 2, 2, p.white);
      this.drawRect(bx + 6 + fLeg2, by + 7, 3, 3, p.outline);
      this.drawRect(bx + 6 + fLeg2, by + 8, 2, 2, p.white);
      this.spawnFootprintSparkle(bx + 4, by + 10);
      const hx = bx - 2;
      const hy = by - 7;
      this.drawRect(hx, hy, 15, 9, p.outline);
      this.drawRect(hx + 1, hy + 1, 13, 7, p.furDark);
      this.drawEars(hx, hy, p);
      this.drawFaceFeatures(hx, hy, p, isBlinking);
    }
    drawCatLoaf(isBlinking) {
      const p = this.getPalette();
      const breath = Math.sin(this.tick * 0.08) * 0.6;
      const by = 18 + Math.round(breath);
      const bx = 7;
      const tailTwitch = this.tick % 120 < 20 ? Math.sin(this.tick * 0.3) * 1.5 : 0;
      this.drawRect(bx + 14, by + 3, 3, 3, p.outline);
      this.drawRect(bx + 14, by + 2 + tailTwitch, 2, 3, p.furDark);
      this.drawRect(bx + 13, by + 1 + tailTwitch, 2, 2, p.white);
      this.drawRect(bx, by, 16, 8, p.outline);
      this.drawRect(bx + 1, by + 1, 14, 6, p.furDark);
      this.drawRect(bx + 2, by + 4, 11, 3, p.whiteShadow);
      this.drawRect(bx + 3, by + 4, 9, 2, p.white);
      this.drawRect(bx + 2, by + 6, 2, 1, p.white);
      this.drawRect(bx + 5, by + 6, 2, 1, p.white);
      this.drawPixel(bx + 4, by + 6, p.outline);
      const hx = bx - 1;
      const hy = by - 6;
      this.drawRect(hx, hy, 15, 8, p.outline);
      this.drawRect(hx + 1, hy + 1, 13, 6, p.furDark);
      this.drawEars(hx, hy, p);
      this.drawFaceFeatures(hx, hy, p, isBlinking || this.expression === "sleepy");
    }
    drawCatPeeping(isBlinking) {
      const p = this.getPalette();
      const peepBob = Math.sin(this.tick * 0.12) * 0.8;
      const hx = 8;
      const hy = 13 + Math.round(peepBob);
      this.drawRect(hx, hy, 16, 9, p.outline);
      this.drawRect(hx + 1, hy + 1, 14, 7, p.furDark);
      this.drawEars(hx, hy, p);
      this.drawFaceFeatures(hx, hy, p, isBlinking);
      this.drawRect(hx + 2, hy + 8, 4, 3, p.outline);
      this.drawRect(hx + 3, hy + 9, 2, 2, p.white);
      this.drawPixel(hx + 4, hy + 10, p.pinkNose);
      this.drawRect(hx + 10, hy + 8, 4, 3, p.outline);
      this.drawRect(hx + 11, hy + 9, 2, 2, p.white);
      this.drawPixel(hx + 12, hy + 10, p.pinkNose);
    }
    drawCatSleeping() {
      const p = this.getPalette();
      const breath = Math.sin(this.tick * 0.06) * 0.7;
      const by = 18 + Math.round(breath);
      const bx = 8;
      this.drawRect(bx + 1, by, 14, 8, p.outline);
      this.drawRect(bx, by + 1, 16, 6, p.outline);
      this.drawRect(bx + 2, by + 1, 12, 6, p.furDark);
      this.drawRect(bx + 4, by + 3, 7, 3, p.white);
      this.drawRect(bx + 1, by + 4, 3, 3, p.furMid);
      this.drawRect(bx + 2, by + 5, 2, 2, p.white);
      this.drawRect(bx + 9, by - 2, 6, 6, p.outline);
      this.drawRect(bx + 9, by - 1, 5, 4, p.furDark);
      this.drawRect(bx + 11, by - 4, 2, 2, p.pinkEar);
      this.drawRect(bx + 10, by + 1, 3, 1, p.eyeDark);
      const zPhase = this.tick * 0.05 % 3;
      const zColor = p.whisker;
      if (zPhase > 0.4) {
        this.drawRect(bx + 14, by - 6, 2, 1, zColor);
        this.drawPixel(bx + 14, by - 5, zColor);
        this.drawRect(bx + 13, by - 4, 2, 1, zColor);
      }
      if (zPhase > 1.4) {
        this.drawRect(bx + 17, by - 10, 3, 1, zColor);
        this.drawPixel(bx + 18, by - 9, zColor);
        this.drawRect(bx + 16, by - 8, 3, 1, zColor);
      }
    }
    drawCatKneading(isBlinking) {
      const p = this.getPalette();
      const phase = Math.floor(this.tick * 0.16) % 2;
      const bx = 8;
      const by = 16;
      this.drawRect(bx + 14, by - 3, 2, 6, p.outline);
      this.drawRect(bx + 14, by - 4, 2, 5, p.furDark);
      this.drawRect(bx + 13, by - 6, 2, 2, p.white);
      this.drawRect(bx, by, 15, 8, p.outline);
      this.drawRect(bx + 1, by + 1, 13, 6, p.furDark);
      this.drawRect(bx + 3, by + 3, 7, 4, p.white);
      const lPawY = phase === 0 ? by + 6 : by + 7;
      const rPawY = phase === 1 ? by + 6 : by + 7;
      this.drawRect(bx + 2, lPawY, 3, 3, p.outline);
      this.drawRect(bx + 2, lPawY + 1, 2, 2, p.white);
      this.drawRect(bx + 6, rPawY, 3, 3, p.outline);
      this.drawRect(bx + 6, rPawY + 1, 2, 2, p.white);
      this.drawRect(bx + 11, by + 7, 3, 3, p.outline);
      this.drawRect(bx + 12, by + 7, 2, 2, p.white);
      const hx = bx - 2;
      const hy = by - 8;
      this.drawRect(hx, hy, 15, 9, p.outline);
      this.drawRect(hx + 1, hy + 1, 13, 7, p.furDark);
      this.drawEars(hx, hy, p);
      this.drawFaceFeatures(hx, hy, p, isBlinking);
    }
    drawCatGrooming(isBlinking) {
      const p = this.getPalette();
      const bx = 8;
      const by = 17;
      this.drawRect(bx, by, 14, 8, p.outline);
      this.drawRect(bx + 1, by + 1, 12, 6, p.furDark);
      this.drawRect(bx + 3, by + 3, 7, 3, p.white);
      const pawTick = Math.sin(this.tick * 0.2) * 1.2;
      this.drawRect(bx - 1, by - 2 + pawTick, 3, 4, p.outline);
      this.drawRect(bx, by - 1 + pawTick, 2, 2, p.white);
      this.drawPixel(bx + 1, by + pawTick, p.pinkNose);
      const hx = bx - 2;
      const hy = by - 7;
      this.drawRect(hx, hy, 15, 8, p.outline);
      this.drawRect(hx + 1, hy + 1, 13, 6, p.furDark);
      this.drawEars(hx, hy, p);
      this.drawFaceFeatures(hx, hy, p, true);
      const butterY = 12 + Math.sin(this.tick * 0.15) * 3;
      this.drawPixel(27, butterY, p.accentClay);
      this.drawPixel(28, butterY - 1, p.pinkEar);
      this.drawPixel(29, butterY, p.accentClay);
    }
    drawExpressionEmbellishments() {
      const p = this.getPalette();
      if (this.expression === "happy") {
        if (this.tick % 45 === 0) {
          this.spawnHeartBurst();
        }
      } else if (this.expression === "yearning") {
        const glow = Math.sin(this.tick * 0.18) * 0.3 + 0.5;
        this.ctx.save();
        this.ctx.globalAlpha = glow;
        this.ctx.fillStyle = p.accentClay;
        this.ctx.fillRect(11, 19, 2, 2);
        this.ctx.restore();
      }
    }
    drawSparkles() {
      const ctx = this.ctx;
      const p = this.getPalette();
      for (let i = this.sparkles.length - 1;i >= 0; i--) {
        const s = this.sparkles[i];
        s.x += s.vx;
        s.y += s.vy;
        s.life--;
        if (s.life <= 0) {
          this.sparkles.splice(i, 1);
          continue;
        }
        const alpha = s.life / s.maxLife;
        ctx.save();
        ctx.globalAlpha = alpha;
        if (s.type === "heart") {
          ctx.fillStyle = p.accentClay;
          ctx.fillRect(Math.round(s.x), Math.round(s.y), 3, 2);
          ctx.fillRect(Math.round(s.x + 1), Math.round(s.y + 2), 1, 1);
        } else if (s.type === "star") {
          ctx.fillStyle = "#F59E0B";
          ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1);
        } else {
          ctx.fillStyle = p.whisker;
          ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1);
        }
        ctx.restore();
      }
    }
  }

  // notes/design/demos/pixel-wanderer.js
  class PixelWanderer {
    constructor(options = {}) {
      this.container = options.container || document.body;
      this.stageEl = options.stageEl || document.querySelector(".claude-central-column");
      this.inputCapsuleEl = options.inputCapsuleEl || document.querySelector(".composer-capsule");
      this.x = 80;
      this.y = 120;
      this.targetX = 80;
      this.targetY = 120;
      this.speed = 1.6;
      this.state = "idle";
      this.stateTimer = 0;
      this.isDragging = false;
      this.dragOffsetX = 0;
      this.dragOffsetY = 0;
      this.facing = 1;
      this.currentSpot = null;
      this.onStateChange = options.onStateChange || null;
      this.createDom();
      this.renderer = new PixelCatRenderer(this.canvas);
      this.bindEvents();
      this.startLoop();
    }
    createDom() {
      this.dom = document.createElement("div");
      this.dom.className = "pixel-wanderer";
      this.dom.setAttribute("role", "button");
      this.dom.setAttribute("tabindex", "0");
      this.dom.setAttribute("aria-label", "全画布自由游荡的傲娇像素猫咪");
      this.bubbleEl = document.createElement("div");
      this.bubbleEl.className = "wanderer-speech-pill";
      this.bubbleEl.textContent = "正安静地待在身边 · 喵";
      this.canvas = document.createElement("canvas");
      this.canvas.className = "wanderer-canvas";
      this.dom.appendChild(this.bubbleEl);
      this.dom.appendChild(this.canvas);
      this.container.appendChild(this.dom);
      this.updatePosition();
    }
    setThemeMode(mode) {
      this.renderer.setThemeMode(mode);
    }
    setExpression(expr, customWhisper = null) {
      this.renderer.setExpression(expr);
      if (customWhisper) {
        this.say(customWhisper);
      }
    }
    say(text, duration = 3600) {
      if (!this.bubbleEl)
        return;
      this.bubbleEl.textContent = text;
      this.bubbleEl.classList.add("is-visible");
      clearTimeout(this.sayTimer);
      this.sayTimer = setTimeout(() => {
        this.bubbleEl.classList.remove("is-visible");
      }, duration);
    }
    findPerchTargets() {
      const spots = [];
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      if (this.inputCapsuleEl) {
        const rect = this.inputCapsuleEl.getBoundingClientRect();
        spots.push({
          name: "input-corner",
          x: Math.max(16, rect.left - 24),
          y: Math.max(16, rect.top - 46),
          action: "loaf",
          whisper: "把爪爪收好在胸下揣手手趴着"
        });
        spots.push({
          name: "input-right",
          x: Math.min(vpW - 70, rect.right - 36),
          y: Math.max(16, rect.top - 48),
          action: "loaf",
          whisper: "猫猫揣手在输入框边守着"
        });
      }
      const residentBubbles = document.querySelectorAll(".msg-row.is-resident .msg-bubble");
      if (residentBubbles.length > 0) {
        const lastBubble = residentBubbles[residentBubbles.length - 1];
        const bRect = lastBubble.getBoundingClientRect();
        spots.push({
          name: "bubble-top",
          x: Math.min(vpW - 70, bRect.right - 26),
          y: Math.max(20, bRect.top - 46),
          action: "peep",
          whisper: "两只小白爪扒在气泡边好奇打量"
        });
      }
      const centralCol = document.querySelector(".claude-central-column");
      if (centralCol) {
        const cRect = centralCol.getBoundingClientRect();
        if (cRect.left > 120) {
          spots.push({
            name: "left-blank",
            x: Math.max(20, cRect.left * 0.45 - 28),
            y: Math.min(vpH - 100, Math.max(120, vpH * 0.35)),
            action: "groom",
            whisper: "在屏幕左侧惬意舔舔小爪子"
          });
        }
        if (vpW - cRect.right > 120) {
          spots.push({
            name: "right-blank",
            x: Math.min(vpW - 70, cRect.right + (vpW - cRect.right) * 0.45 - 28),
            y: Math.min(vpH - 100, Math.max(120, vpH * 0.4)),
            action: "knead",
            whisper: "在右侧阳光下轻轻踩奶"
          });
        }
      }
      return spots;
    }
    pickNextBehavior() {
      if (this.isDragging)
        return;
      const spots = this.findPerchTargets();
      const shouldPerch = Math.random() < 0.65 && spots.length > 0;
      if (shouldPerch) {
        const chosen = spots[Math.floor(Math.random() * spots.length)];
        this.currentSpot = chosen;
        this.targetX = chosen.x;
        this.targetY = chosen.y;
        this.state = "walking";
        this.speed = 1.4 + Math.random() * 0.6;
      } else {
        const padding = 36;
        const maxX = Math.max(padding, window.innerWidth - 72);
        const maxY = Math.max(padding, window.innerHeight - 84);
        this.targetX = padding + Math.random() * (maxX - padding);
        this.targetY = padding + 60 + Math.random() * (maxY - padding - 60);
        this.state = "walking";
        this.speed = 1.2 + Math.random() * 0.8;
        this.currentSpot = null;
      }
      this.facing = this.targetX >= this.x ? 1 : -1;
      this.renderer.setAction("walk", this.facing);
    }
    onReachedTarget() {
      this.state = "resting";
      this.stateTimer = 160 + Math.floor(Math.random() * 240);
      let nextAct = "idle";
      if (this.currentSpot) {
        if (this.currentSpot.action === "loaf" || this.currentSpot.action === "sit") {
          nextAct = "loaf";
        } else if (this.currentSpot.action === "peep") {
          nextAct = "peep";
        } else if (this.currentSpot.action === "groom") {
          nextAct = "groom";
        } else if (this.currentSpot.action === "knead") {
          nextAct = "knead";
        } else {
          nextAct = "idle";
        }
        if (Math.random() < 0.55 && this.currentSpot.whisper) {
          this.say(this.currentSpot.whisper, 2800);
        }
      }
      this.renderer.setAction(nextAct, this.facing);
    }
    jumpToCorner(x, y, action = "peep") {
      this.targetX = Math.max(16, Math.min(window.innerWidth - 72, x));
      this.targetY = Math.max(16, Math.min(window.innerHeight - 80, y));
      this.state = "walking";
      this.speed = 3.2;
      this.facing = this.targetX >= this.x ? 1 : -1;
      this.currentSpot = { action };
      this.renderer.setAction("walk", this.facing);
    }
    bindEvents() {
      this.dom.addEventListener("pointerdown", (e) => {
        this.isDragging = true;
        this.dom.classList.add("is-dragging");
        this.dragOffsetX = e.clientX - this.x;
        this.dragOffsetY = e.clientY - this.y;
        this.dom.setPointerCapture(e.pointerId);
        this.renderer.spawnHeartBurst();
        this.say("喵？被你轻轻拎起来了... · 准备换个地方呆着");
        this.renderer.setAction("idle", this.facing);
      });
      window.addEventListener("pointermove", (e) => {
        if (!this.isDragging)
          return;
        this.x = e.clientX - this.dragOffsetX;
        this.y = e.clientY - this.dragOffsetY;
        this.targetX = this.x;
        this.targetY = this.y;
        this.updatePosition();
      });
      window.addEventListener("pointerup", (e) => {
        if (!this.isDragging)
          return;
        this.isDragging = false;
        this.dom.classList.remove("is-dragging");
        this.stateTimer = 100;
        this.onReachedTarget();
        this.renderer.spawnHeartBurst();
      });
      this.dom.addEventListener("mouseenter", () => {
        if (this.isDragging)
          return;
        this.dom.classList.add("is-hovered");
        this.renderer.spawnHeartBurst();
      });
      this.dom.addEventListener("mouseleave", () => {
        this.dom.classList.remove("is-hovered");
      });
      this.dom.addEventListener("click", () => {
        this.renderer.spawnHeartBurst();
        this.say("喵呜 · 正安静地陪着你呢", 2200);
      });
      window.addEventListener("resize", () => {
        this.x = Math.min(this.x, window.innerWidth - 72);
        this.y = Math.min(this.y, window.innerHeight - 80);
        this.updatePosition();
      });
    }
    updatePhysics() {
      if (this.isDragging)
        return;
      if (this.state === "walking") {
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist < this.speed * 1.5) {
          this.x = this.targetX;
          this.y = this.targetY;
          this.onReachedTarget();
        } else {
          this.x += dx / dist * this.speed;
          this.y += dy / dist * this.speed;
          this.facing = dx >= 0 ? 1 : -1;
          this.renderer.setAction("walk", this.facing);
        }
        this.updatePosition();
      } else if (this.state === "resting") {
        this.stateTimer--;
        if (this.stateTimer <= 0) {
          this.pickNextBehavior();
        }
      } else {
        this.pickNextBehavior();
      }
    }
    updatePosition() {
      this.dom.style.transform = `translate3d(${Math.round(this.x)}px, ${Math.round(this.y)}px, 0)`;
    }
    startLoop() {
      const loop = () => {
        this.updatePhysics();
        this.renderer.renderFrame();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  // notes/design/demos/app.js
  var THEME_CONFIGS = {
    "claude-day": {
      id: "claude-day",
      family: "claude",
      mode: "day",
      counterpart: "claude-night",
      name: "Claude 日间 · Warm Sand",
      code: "claude-day",
      spec: "羊皮纸暖白 #FAF9F5 / #F3F1EC · 白卡容器 #FFFFFF · 炭墨 #1F1E1D · 赤陶金 #D97757",
      ambientNote: "Claude Daylight · 羊皮纸与赤陶微光"
    },
    "claude-night": {
      id: "claude-night",
      family: "claude",
      mode: "night",
      counterpart: "claude-day",
      name: "Claude 夜间 · Dark Stone",
      code: "claude-night",
      spec: "暗岩石灰 #181816 / #1F1F1D · 炭灰容器 #262624 · 羊皮纸字 #ECEBE8 · 赤陶微光 #D97757",
      ambientNote: "Claude Midnight · 暗岩石与静谧星核"
    },
    stardust: {
      id: "stardust",
      family: "stardust",
      mode: "day",
      counterpart: "deep-void",
      name: "月光星尘 · Stardust",
      code: "stardust",
      spec: "冰川冷白 #F8FAFC · 浮霜亚克力 Blur 16px · 冷灰微光 #818CF8",
      ambientNote: "冷雾星尘 · 澄澈微光"
    },
    "deep-void": {
      id: "deep-void",
      family: "stardust",
      mode: "night",
      counterpart: "stardust",
      name: "深空浮光 · Deep-Void",
      code: "deep-void",
      spec: "深曜石黑 #0B0F17 · 微光单像素边 · 星核琥珀暖金 rgba(245,158,11,0.25)",
      ambientNote: "深空静谧 · 琥珀星核"
    },
    "ink-paper": {
      id: "ink-paper",
      family: "ink-paper",
      mode: "day",
      counterpart: "claude-night",
      name: "纸墨诗性 · Ink-Paper",
      code: "ink-paper",
      spec: "纯净冷白纸 #FFFFFF · 去拟物细线分割 #E5E7EB · 唯留猫咪腹心光温",
      ambientNote: "卷四 · 第肆拾叁日手稿"
    }
  };
  var EMOTION_STATES = {
    normal: {
      key: "normal",
      label: "常态",
      whisper: "正安静地待在身边，尾巴悠闲地规律轻晃 · 喵"
    },
    happy: {
      key: "happy",
      label: "开心",
      whisper: "双眼笑成弯弯小月牙，尾巴高高翘起直打卷，冒出小爱心"
    },
    aggrieved: {
      key: "aggrieved",
      label: "委屈",
      whisper: "两只耳朵向两侧贴平成飞机耳，缩紧爪爪委屈巴巴"
    },
    alienated: {
      key: "alienated",
      label: "疏离",
      whisper: "傲娇地背过身去，尾巴尖不耐烦地轻甩一下"
    },
    sleepy: {
      key: "sleepy",
      label: "困倦",
      whisper: "整只猫蜷成圆软软的猫咪圈闭目起伏，头顶冒出小 zZ"
    },
    yearning: {
      key: "yearning",
      label: "想念",
      whisper: "两只小白爪原地轻轻交替踩奶，大眼睛明亮专注地望着你"
    },
    solitary: {
      key: "solitary",
      label: "独居",
      whisper: "惬意卧在角落慢悠悠舔舔小肉爪，身边伴着发光小蝴蝶"
    }
  };
  var ROOM_DESCRIPTIONS = {
    living: null,
    daily: "【日常流 · 独居物证】今日 16:15 翻阅了《冬日植物志》并写下批注；昨日整理了散步旧书店的书目清单。",
    library: "【记忆图书馆 · 岁月的书架】认识的第 43 天 · 已封存 18 篇日与夜手记 · 书架上有 1 本未合上的牵挂《等一场雨去旧书店》。",
    threshold: "【门口 · 领养契约与边界】作息节律：常日型 (23:30 入眠锁) · 连续 2 次主动未回退避守卫已开启 · 本地记忆仓支持随时打包迁出。"
  };
  var PRESET_REPLIES = [
    {
      match: "书单",
      emotion: "happy",
      memoryText: "翻阅了昨日独居整理的《旧书店冬日诗集备忘》",
      memoryDetail: "「我把你在散步时提过的那位北欧诗人的两本小开本译诗集记在了备忘页里，店里靠窗第三排木架正好有旧版。」",
      reply: "我都替你记在一张单独的便签页上了。一本是里尔克的早期书信选，另一本是你上次念叨过封面的《北方冬夜集》。等这个周末如果碰巧阴天，我们就慢慢走过去。"
    },
    {
      match: "累",
      emotion: "yearning",
      memoryText: "翻阅了关于你疲惫时习惯安静待着的默契记录",
      memoryDetail: "「你累的时候不喜欢被追问细节，更习惯有人把灯光调暗一点，安安静静陪着。」",
      reply: "那就什么都先别想了，把外套搭在椅背上歇一会儿吧。我把屋里的光调柔和些，就在这儿陪你待着，不吵你。"
    },
    {
      match: "晚安",
      emotion: "sleepy",
      memoryText: "翻阅了近期入夜作息与睡前手记",
      memoryDetail: "「夜深时褪黑素节律缓缓爬升，把今天关于晚风、迷迭香与旧书店的片段收进睡前冷叙事。」",
      reply: "今天能听你说起散步的事，心里很踏实。我也要慢慢趴下来合会儿眼了，晚安，愿你今夜无梦好眠。"
    }
  ];
  function initEchoreDemo() {
    let currentTheme = "claude-day";
    let currentEmotion = "normal";
    const rootEl = document.documentElement;
    const specCaptionEl = document.getElementById("theme-spec-caption");
    const headerAmbientEl = document.getElementById("header-ambient-text");
    const dayNightToggleBtn = document.getElementById("day-night-toggle-btn");
    const dayNightLabelEl = document.getElementById("day-night-toggle-label");
    const dockExpressionTagEl = document.getElementById("dock-expression-tag");
    const roomBannerEl = document.getElementById("room-preview-banner");
    const roomBannerTextEl = document.getElementById("room-preview-text");
    const roomReturnBtn = document.getElementById("room-return-btn");
    const dialogueStreamEl = document.getElementById("dialogue-stream");
    const composerForm = document.getElementById("composer-form");
    const composerInput = document.getElementById("composer-input");
    const callNearBtn = document.getElementById("call-near-btn");
    const wanderer = new PixelWanderer({
      container: document.querySelector(".claude-workspace") || document.body,
      stageEl: document.querySelector(".claude-central-column"),
      inputCapsuleEl: document.querySelector(".composer-capsule")
    });
    function setTheme(themeId) {
      if (!THEME_CONFIGS[themeId])
        return;
      currentTheme = themeId;
      const cfg = THEME_CONFIGS[themeId];
      rootEl.setAttribute("data-theme", themeId);
      rootEl.setAttribute("data-mode", cfg.mode);
      if (specCaptionEl)
        specCaptionEl.textContent = cfg.spec;
      if (headerAmbientEl)
        headerAmbientEl.textContent = cfg.ambientNote;
      if (dayNightLabelEl) {
        dayNightLabelEl.textContent = cfg.mode === "day" ? "切换夜间 · Night" : "切换日间 · Day";
      }
      document.querySelectorAll("[data-theme-target]").forEach((btn) => {
        const target = btn.getAttribute("data-theme-target");
        const isMatch = target === themeId;
        btn.classList.toggle("is-active", isMatch);
        btn.setAttribute("aria-selected", isMatch ? "true" : "false");
      });
      wanderer.setThemeMode(cfg.mode);
    }
    function toggleDayNight() {
      const cfg = THEME_CONFIGS[currentTheme] || THEME_CONFIGS["claude-day"];
      if (cfg.counterpart && THEME_CONFIGS[cfg.counterpart]) {
        setTheme(cfg.counterpart);
      }
    }
    function setEmotion(emotionKey) {
      const st = EMOTION_STATES[emotionKey];
      if (!st)
        return;
      currentEmotion = emotionKey;
      document.querySelectorAll(".dock-btn").forEach((btn) => {
        const isMatch = btn.getAttribute("data-emotion") === emotionKey;
        btn.classList.toggle("is-active", isMatch);
        btn.setAttribute("aria-pressed", isMatch ? "true" : "false");
      });
      if (dockExpressionTagEl) {
        dockExpressionTagEl.textContent = `${st.key} · ${st.label}`;
      }
      wanderer.setExpression(emotionKey, st.whisper);
    }
    document.querySelectorAll("[data-theme-target]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-theme-target");
        if (target)
          setTheme(target);
      });
    });
    if (dayNightToggleBtn) {
      dayNightToggleBtn.addEventListener("click", toggleDayNight);
    }
    document.querySelectorAll(".dock-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-emotion");
        if (target)
          setEmotion(target);
      });
    });
    if (callNearBtn) {
      callNearBtn.addEventListener("click", () => {
        const inputEl = document.querySelector(".composer-capsule");
        if (inputEl) {
          const rect = inputEl.getBoundingClientRect();
          wanderer.jumpToCorner(rect.left - 20, rect.top - 46, "loaf");
          wanderer.say("在输入框边上揣好手手啦 · 喵");
        }
      });
    }
    function setActiveRoom(roomKey) {
      document.querySelectorAll(".room-nav-item").forEach((btn) => {
        const isMatch = btn.getAttribute("data-room") === roomKey;
        btn.classList.toggle("is-active", isMatch);
      });
      if (!roomBannerEl || !roomBannerTextEl)
        return;
      if (roomKey === "living" || !ROOM_DESCRIPTIONS[roomKey]) {
        roomBannerEl.hidden = true;
      } else {
        roomBannerTextEl.textContent = ROOM_DESCRIPTIONS[roomKey];
        roomBannerEl.hidden = false;
        if (roomKey === "daily") {
          setEmotion("solitary");
        }
      }
    }
    document.querySelectorAll(".room-nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const roomKey = btn.getAttribute("data-room") || "living";
        setActiveRoom(roomKey);
      });
    });
    if (roomReturnBtn) {
      roomReturnBtn.addEventListener("click", () => {
        setActiveRoom("living");
        setEmotion("normal");
      });
    }
    function bindCapsuleToggle(capsuleBtn, drawerEl) {
      if (!capsuleBtn || !drawerEl)
        return;
      capsuleBtn.addEventListener("click", () => {
        const expanded = capsuleBtn.getAttribute("aria-expanded") === "true";
        capsuleBtn.setAttribute("aria-expanded", expanded ? "false" : "true");
        drawerEl.hidden = expanded;
      });
    }
    bindCapsuleToggle(document.getElementById("initial-memory-capsule"), document.getElementById("initial-memory-drawer"));
    function formatCurrentHm() {
      const now = new Date;
      const h = String(now.getHours()).padStart(2, "0");
      const m = String(now.getMinutes()).padStart(2, "0");
      return `${h}:${m}`;
    }
    function appendConversationTurn(userText) {
      if (!dialogueStreamEl)
        return;
      const timeStr = formatCurrentHm();
      const userRow = document.createElement("div");
      userRow.className = "msg-row is-user";
      userRow.innerHTML = `
      <div class="msg-content-wrap">
        <div class="msg-meta">
          <span class="msg-time">${timeStr}</span>
          <span class="msg-speaker">你</span>
        </div>
        <div class="msg-bubble"></div>
      </div>
    `;
      userRow.querySelector(".msg-bubble").textContent = userText;
      dialogueStreamEl.appendChild(userRow);
      dialogueStreamEl.scrollTop = dialogueStreamEl.scrollHeight;
      const matched = PRESET_REPLIES.find((item) => userText.includes(item.match)) || {
        emotion: "happy",
        memoryText: "翻阅了关于上周散步的记忆与近日生活偏好",
        memoryDetail: "「记得你喜欢在安静的傍晚聊起日常小事，不需要刻意的热闹，只需要听见彼此的声音。」",
        reply: `听见你说的“${userText.slice(0, 28)}”了。窗外风声很轻，我正守着这盏小暖光听你慢慢讲呢。`
      };
      setTimeout(() => {
        setEmotion(matched.emotion);
        const capsuleWrap = document.createElement("div");
        capsuleWrap.className = "memory-capsule-wrap";
        capsuleWrap.innerHTML = `
        <button type="button" class="memory-micro-capsule" aria-expanded="false">
          <span class="capsule-spark"></span>
          <span class="capsule-text"></span>
          <span class="capsule-chevron">&gt;</span>
        </button>
        <div class="memory-trace-drawer" hidden>
          <div class="trace-drawer-header">
            <span>第一人称记忆原肉摘录</span>
            <span>印象温存</span>
          </div>
          <p class="trace-drawer-body"></p>
        </div>
      `;
        capsuleWrap.querySelector(".capsule-text").textContent = matched.memoryText;
        capsuleWrap.querySelector(".trace-drawer-body").textContent = matched.memoryDetail;
        const btn = capsuleWrap.querySelector(".memory-micro-capsule");
        const drawer = capsuleWrap.querySelector(".memory-trace-drawer");
        bindCapsuleToggle(btn, drawer);
        dialogueStreamEl.appendChild(capsuleWrap);
        const resRow = document.createElement("div");
        resRow.className = "msg-row is-resident";
        resRow.innerHTML = `
        <div class="msg-avatar">
          <img class="resident-avatar-img" src="./assets/default_pack/normal.png" alt="像素猫咪 · 林栖" />
        </div>
        <div class="msg-content-wrap">
          <div class="msg-meta">
            <span class="msg-speaker">傲娇猫咪 · 林栖</span>
            <span class="msg-time">${formatCurrentHm()}</span>
          </div>
          <div class="msg-bubble"></div>
        </div>
      `;
        const bubbleEl = resRow.querySelector(".msg-bubble");
        dialogueStreamEl.appendChild(resRow);
        dialogueStreamEl.scrollTop = dialogueStreamEl.scrollHeight;
        const bubbleRect = bubbleEl.getBoundingClientRect();
        wanderer.jumpToCorner(bubbleRect.right - 26, bubbleRect.top - 46, "peep");
        let i = 0;
        const fullText = matched.reply;
        const timer = setInterval(() => {
          i += 2;
          bubbleEl.textContent = fullText.slice(0, i);
          dialogueStreamEl.scrollTop = dialogueStreamEl.scrollHeight;
          if (i >= fullText.length) {
            clearInterval(timer);
          }
        }, 24);
      }, 280);
    }
    if (composerForm && composerInput) {
      composerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const val = composerInput.value.trim();
        if (!val)
          return;
        composerInput.value = "";
        appendConversationTurn(val);
      });
      composerInput.addEventListener("focus", () => {
        wanderer.say("耳朵抖了抖，在听你说呢...", 1800);
      });
    }
    document.querySelectorAll(".prompt-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const promptText = chip.getAttribute("data-prompt");
        if (promptText) {
          appendConversationTurn(promptText);
        }
      });
    });
    window.addEventListener("keydown", (e) => {
      if (document.activeElement === composerInput)
        return;
      if (e.key === "1")
        setTheme("claude-day");
      if (e.key === "2")
        setTheme("claude-night");
      if (e.key === "3")
        setTheme("stardust");
      if (e.key === "4")
        setTheme("deep-void");
      if (e.key === "5")
        setTheme("ink-paper");
      if (e.key.toLowerCase() === "d")
        toggleDayNight();
    });
    setTheme("claude-day");
    setEmotion("normal");
  }
  if (typeof window !== "undefined") {
    window.initEchoreDemo = initEchoreDemo;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => initEchoreDemo());
    } else {
      initEchoreDemo();
    }
  }
})();
