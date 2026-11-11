import { PixelCatRenderer } from "./pixel-mascot.js";

export class PixelWanderer {
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
    if (!this.bubbleEl) return;
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
        whisper: "把爪爪收好在胸下揣手手趴着",
      });
      spots.push({
        name: "input-right",
        x: Math.min(vpW - 70, rect.right - 36),
        y: Math.max(16, rect.top - 48),
        action: "loaf",
        whisper: "猫猫揣手在输入框边守着",
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
        whisper: "两只小白爪扒在气泡边好奇打量",
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
          whisper: "在屏幕左侧惬意舔舔小爪子",
        });
      }
      if (vpW - cRect.right > 120) {
        spots.push({
          name: "right-blank",
          x: Math.min(vpW - 70, cRect.right + (vpW - cRect.right) * 0.45 - 28),
          y: Math.min(vpH - 100, Math.max(120, vpH * 0.4)),
          action: "knead",
          whisper: "在右侧阳光下轻轻踩奶",
        });
      }
    }

    return spots;
  }

  pickNextBehavior() {
    if (this.isDragging) return;

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
      if (!this.isDragging) return;
      this.x = e.clientX - this.dragOffsetX;
      this.y = e.clientY - this.dragOffsetY;
      this.targetX = this.x;
      this.targetY = this.y;
      this.updatePosition();
    });

    window.addEventListener("pointerup", (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.dom.classList.remove("is-dragging");
      this.stateTimer = 100;
      this.onReachedTarget();
      this.renderer.spawnHeartBurst();
    });

    this.dom.addEventListener("mouseenter", () => {
      if (this.isDragging) return;
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
    if (this.isDragging) return;

    if (this.state === "walking") {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.hypot(dx, dy);

      if (dist < this.speed * 1.5) {
        this.x = this.targetX;
        this.y = this.targetY;
        this.onReachedTarget();
      } else {
        this.x += (dx / dist) * this.speed;
        this.y += (dy / dist) * this.speed;
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
