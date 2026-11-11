export class PixelCatRenderer {
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
    for (let i = 0; i < 4; i++) {
      this.sparkles.push({
        x: 16 + (Math.random() * 8 - 4),
        y: 8 + (Math.random() * 4 - 2),
        vx: (Math.random() - 0.5) * 0.7,
        vy: -0.6 - Math.random() * 0.5,
        life: 26,
        maxLife: 26,
        type: "heart",
      });
    }
  }

  spawnWarmDust() {
    for (let i = 0; i < 3; i++) {
      this.sparkles.push({
        x: 16 + (Math.random() * 10 - 5),
        y: 12 + (Math.random() * 6 - 3),
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.3 - Math.random() * 0.4,
        life: 24,
        maxLife: 24,
        type: "star",
      });
    }
  }

  spawnFootprintSparkle(x, y) {
    if (Math.random() > 0.4) return;
    this.sparkles.push({
      x: x + (Math.random() * 3 - 1),
      y: y,
      vx: (Math.random() - 0.5) * 0.2,
      vy: -0.15,
      life: 14,
      maxLife: 14,
      type: "dust",
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
    if (this.expression === "sleepy") return "sleep";
    if (this.action === "walk") return "walk";
    if (this.action === "peep") return "peep";
    if (this.action === "sit" || this.action === "loaf") return "loaf";

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
      accentClay: "#D97757",
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

    const twitch = (this.tick % 90 < 8 && this.action === "idle") ? 1 : 0;

    // 左耳 (前)
    this.drawRect(headX + 2, headY - 4 - twitch, 3, 1, palette.outline);
    this.drawRect(headX + 1, headY - 3 - twitch, 1, 4, palette.outline);
    this.drawRect(headX + 5, headY - 3 - twitch, 1, 3, palette.outline);
    this.drawRect(headX + 2, headY - 3 - twitch, 3, 3, palette.furDark);
    this.drawRect(headX + 2, headY - 2 - twitch, 2, 2, palette.pinkEar);

    // 右耳 (后)
    this.drawRect(headX + 9, headY - 4, 3, 1, palette.outline);
    this.drawRect(headX + 8, headY - 3, 1, 3, palette.outline);
    this.drawRect(headX + 12, headY - 3, 1, 4, palette.outline);
    this.drawRect(headX + 9, headY - 3, 3, 3, palette.furDark);
    this.drawRect(headX + 10, headY - 2, 2, 2, palette.pinkEar);
  }

  drawAirplaneEars(headX, headY, palette) {
    // 飞机耳：耳朵向两侧贴平耷拉
    // 左耳向左扁平伸出
    this.drawRect(headX - 3, headY - 1, 4, 1, palette.outline);
    this.drawRect(headX - 4, headY, 1, 2, palette.outline);
    this.drawRect(headX - 3, headY + 2, 4, 1, palette.outline);
    this.drawRect(headX - 3, headY, 4, 2, palette.furDark);
    this.drawRect(headX - 2, headY, 3, 1, palette.pinkEar);

    // 右耳向右扁平伸出
    this.drawRect(headX + 13, headY - 1, 4, 1, palette.outline);
    this.drawRect(headX + 17, headY, 1, 2, palette.outline);
    this.drawRect(headX + 13, headY + 2, 4, 1, palette.outline);
    this.drawRect(headX + 13, headY, 4, 2, palette.furDark);
    this.drawRect(headX + 13, headY, 3, 1, palette.pinkEar);
  }

  drawFaceFeatures(headX, headY, palette, isBlinking) {
    // 面部白斑 (宾士猫典型倒V字或前脸白色)
    this.drawRect(headX + 6, headY + 3, 3, 5, palette.white);
    this.drawRect(headX + 5, headY + 6, 5, 2, palette.white);

    // 眼睛
    const eyeY = headY + 3;
    if (this.expression === "happy") {
      // 弯弯笑眼 ^^
      this.drawPixel(headX + 3, eyeY, palette.eyeDark);
      this.drawPixel(headX + 4, eyeY - 1, palette.eyeDark);
      this.drawPixel(headX + 5, eyeY, palette.eyeDark);

      this.drawPixel(headX + 9, eyeY, palette.eyeDark);
      this.drawPixel(headX + 10, eyeY - 1, palette.eyeDark);
      this.drawPixel(headX + 11, eyeY, palette.eyeDark);
    } else if (this.expression === "sleepy" || isBlinking) {
      // 闭眼细线
      this.drawRect(headX + 3, eyeY + 1, 3, 1, palette.eyeDark);
      this.drawRect(headX + 9, eyeY + 1, 3, 1, palette.eyeDark);
    } else if (this.expression === "aggrieved") {
      // 委屈下垂八字大眼
      this.drawRect(headX + 3, eyeY, 3, 2, palette.eyeDark);
      this.drawRect(headX + 9, eyeY, 3, 2, palette.eyeDark);
      this.drawPixel(headX + 3, eyeY, palette.white);
      this.drawPixel(headX + 9, eyeY, palette.white);
      this.drawPixel(headX + 5, eyeY + 1, palette.eyeDark);
      this.drawPixel(headX + 11, eyeY + 1, palette.eyeDark);
    } else if (this.expression === "alienated") {
      // 疏离半阖眼线、细长蔑视感
      this.drawRect(headX + 4, eyeY, 3, 1, palette.eyeDark);
      this.drawRect(headX + 10, eyeY, 3, 1, palette.eyeDark);
    } else {
      // 常态灵动大眼 + 高光
      this.drawRect(headX + 3, eyeY, 3, 3, palette.eyeDark);
      this.drawPixel(headX + 3, eyeY, palette.eyeGlint);
      this.drawRect(headX + 9, eyeY, 3, 3, palette.eyeDark);
      this.drawPixel(headX + 9, eyeY, palette.eyeGlint);
    }

    // 小粉鼻
    this.drawPixel(headX + 7, headY + 5, palette.pinkNose);

    // 三瓣嘴
    this.drawPixel(headX + 7, headY + 6, palette.outline);
    this.drawPixel(headX + 6, headY + 7, palette.outline);
    this.drawPixel(headX + 8, headY + 7, palette.outline);

    // 两侧精致小胡须
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

    // 尾巴 (右侧/后方悠闲晃动)
    const tailWag = Math.sin(this.tick * 0.12) * 2;
    const tx = bx + 14;
    const ty = bodyY + 2;
    this.drawRect(tx, ty, 2, 2, p.outline);
    this.drawRect(tx + 1, ty - 2 + tailWag * 0.3, 2, 2, p.furDark);
    this.drawRect(tx + 2, ty - 4 + tailWag * 0.6, 2, 2, p.furDark);
    this.drawRect(tx + 3 + tailWag * 0.4, ty - 6 + tailWag, 2, 3, p.white);
    this.drawRect(tx + 3 + tailWag * 0.4, ty - 7 + tailWag, 2, 1, p.outline);

    // 躯干轮廓与主体
    this.drawRect(bx, bodyY, 15, 8, p.outline);
    this.drawRect(bx + 1, bodyY + 1, 13, 6, p.furDark);
    this.drawRect(bx + 2, bodyY + 2, 6, 4, p.furMid);

    // 肚皮白色与阴影
    this.drawRect(bx + 1, bodyY + 4, 8, 3, p.whiteShadow);
    this.drawRect(bx + 1, bodyY + 4, 7, 2, p.white);

    // 四爪 (站立四足 + 白袜)
    // 后脚
    this.drawRect(bx + 10, bodyY + 7, 3, 3, p.outline);
    this.drawRect(bx + 11, bodyY + 7, 2, 2, p.white);
    this.drawRect(bx + 13, bodyY + 7, 2, 3, p.outline);
    this.drawRect(bx + 13, bodyY + 8, 1, 2, p.white);

    // 前脚
    this.drawRect(bx + 2, bodyY + 7, 3, 3, p.outline);
    this.drawRect(bx + 2, bodyY + 8, 2, 2, p.white);
    this.drawRect(bx + 5, bodyY + 7, 3, 3, p.outline);
    this.drawRect(bx + 6, bodyY + 8, 2, 2, p.white);

    // 猫头
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
    const bob = (frame === 0 || frame === 2) ? 1 : 0;

    const bx = 8;
    const by = 16 + bob;

    // 步行动作中尾巴微向上扬起规律轻摆
    const tailSwing = Math.sin(this.tick * 0.35) * 2;
    const tx = bx + 14;
    const ty = by - 1;
    this.drawRect(tx, ty, 2, 2, p.outline);
    this.drawRect(tx + 1, ty - 3, 2, 2, p.furDark);
    this.drawRect(tx + 2 + tailSwing * 0.5, ty - 6, 2, 3, p.furDark);
    this.drawRect(tx + 3 + tailSwing, ty - 8, 2, 2, p.white);
    this.drawRect(tx + 3 + tailSwing, ty - 9, 2, 1, p.outline);

    // 躯干
    this.drawRect(bx, by, 15, 8, p.outline);
    this.drawRect(bx + 1, by + 1, 13, 6, p.furDark);
    this.drawRect(bx + 2, by + 4, 8, 3, p.white);

    // 四足步态交替 (四帧猫步)
    let fLeg1 = 0, fLeg2 = 0, bLeg1 = 0, bLeg2 = 0;
    if (frame === 0) {
      fLeg1 = -1; fLeg2 = 1; bLeg1 = 1; bLeg2 = -1;
    } else if (frame === 1) {
      fLeg1 = 0; fLeg2 = 0; bLeg1 = 0; bLeg2 = 0;
    } else if (frame === 2) {
      fLeg1 = 1; fLeg2 = -1; bLeg1 = -1; bLeg2 = 1;
    } else {
      fLeg1 = 0; fLeg2 = 0; bLeg1 = 0; bLeg2 = 0;
    }

    // 后腿
    this.drawRect(bx + 10 + bLeg1, by + 7, 3, 3, p.outline);
    this.drawRect(bx + 11 + bLeg1, by + 8, 2, 2, p.white);
    this.drawRect(bx + 13 + bLeg2, by + 7, 2, 3, p.outline);
    this.drawRect(bx + 13 + bLeg2, by + 8, 1, 2, p.white);

    // 前腿
    this.drawRect(bx + 2 + fLeg1, by + 7, 3, 3, p.outline);
    this.drawRect(bx + 2 + fLeg1, by + 8, 2, 2, p.white);
    this.drawRect(bx + 6 + fLeg2, by + 7, 3, 3, p.outline);
    this.drawRect(bx + 6 + fLeg2, by + 8, 2, 2, p.white);

    this.spawnFootprintSparkle(bx + 4, by + 10);

    // 头部 (带轻微步伐位移)
    const hx = bx - 2;
    const hy = by - 7;
    this.drawRect(hx, hy, 15, 9, p.outline);
    this.drawRect(hx + 1, hy + 1, 13, 7, p.furDark);

    this.drawEars(hx, hy, p);
    this.drawFaceFeatures(hx, hy, p, isBlinking);
  }

  drawCatLoaf(isBlinking) {
    // 经典猫咪揣手手 (Cat Loaf / 农民揣)
    const p = this.getPalette();
    const breath = Math.sin(this.tick * 0.08) * 0.6;
    const by = 18 + Math.round(breath);
    const bx = 7;

    // 尾巴紧紧盘在身侧
    const tailTwitch = (this.tick % 120 < 20) ? Math.sin(this.tick * 0.3) * 1.5 : 0;
    this.drawRect(bx + 14, by + 3, 3, 3, p.outline);
    this.drawRect(bx + 14, by + 2 + tailTwitch, 2, 3, p.furDark);
    this.drawRect(bx + 13, by + 1 + tailTwitch, 2, 2, p.white);

    // 揣手躯干：圆润面包状，爪子全部收在胸下
    this.drawRect(bx, by, 16, 8, p.outline);
    this.drawRect(bx + 1, by + 1, 14, 6, p.furDark);
    this.drawRect(bx + 2, by + 4, 11, 3, p.whiteShadow);
    this.drawRect(bx + 3, by + 4, 9, 2, p.white);

    // 胸前揣手手折痕 (小肉爪尖微收)
    this.drawRect(bx + 2, by + 6, 2, 1, p.white);
    this.drawRect(bx + 5, by + 6, 2, 1, p.white);
    this.drawPixel(bx + 4, by + 6, p.outline);

    // 猫头略微放低，呈现舒适打盹感
    const hx = bx - 1;
    const hy = by - 6;
    this.drawRect(hx, hy, 15, 8, p.outline);
    this.drawRect(hx + 1, hy + 1, 13, 6, p.furDark);

    this.drawEars(hx, hy, p);
    this.drawFaceFeatures(hx, hy, p, isBlinking || this.expression === "sleepy");
  }

  drawCatPeeping(isBlinking) {
    // 气泡边缘扒拉探头：两只小白爪搭在边缘，露出圆滚滚猫猫头
    const p = this.getPalette();
    const peepBob = Math.sin(this.tick * 0.12) * 0.8;
    const hx = 8;
    const hy = 13 + Math.round(peepBob);

    // 猫头
    this.drawRect(hx, hy, 16, 9, p.outline);
    this.drawRect(hx + 1, hy + 1, 14, 7, p.furDark);

    this.drawEars(hx, hy, p);
    this.drawFaceFeatures(hx, hy, p, isBlinking);

    // 下方两只前爪扒在边缘 (模拟气泡上沿 y = 23)
    this.drawRect(hx + 2, hy + 8, 4, 3, p.outline);
    this.drawRect(hx + 3, hy + 9, 2, 2, p.white);
    this.drawPixel(hx + 4, hy + 10, p.pinkNose);

    this.drawRect(hx + 10, hy + 8, 4, 3, p.outline);
    this.drawRect(hx + 11, hy + 9, 2, 2, p.white);
    this.drawPixel(hx + 12, hy + 10, p.pinkNose);
  }

  drawCatSleeping() {
    // 猫圈 (Cat Donut) 蜷曲沉睡
    const p = this.getPalette();
    const breath = Math.sin(this.tick * 0.06) * 0.7;
    const by = 18 + Math.round(breath);
    const bx = 8;

    // 蜷成一团的深色大轮廓
    this.drawRect(bx + 1, by, 14, 8, p.outline);
    this.drawRect(bx, by + 1, 16, 6, p.outline);
    this.drawRect(bx + 2, by + 1, 12, 6, p.furDark);

    // 腹部奶白
    this.drawRect(bx + 4, by + 3, 7, 3, p.white);

    // 盘起的尾巴裹住身体
    this.drawRect(bx + 1, by + 4, 3, 3, p.furMid);
    this.drawRect(bx + 2, by + 5, 2, 2, p.white);

    // 趴伏闭眼的头
    this.drawRect(bx + 9, by - 2, 6, 6, p.outline);
    this.drawRect(bx + 9, by - 1, 5, 4, p.furDark);
    this.drawRect(bx + 11, by - 4, 2, 2, p.pinkEar);
    this.drawRect(bx + 10, by + 1, 3, 1, p.eyeDark); // 闭眼

    // 冒 zZ 动画
    const zPhase = (this.tick * 0.05) % 3;
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
    // 踩奶动作 (想念专用)：左右前爪交替按压
    const p = this.getPalette();
    const phase = Math.floor(this.tick * 0.16) % 2;
    const bx = 8;
    const by = 16;

    // 高高立起的问号尾巴
    this.drawRect(bx + 14, by - 3, 2, 6, p.outline);
    this.drawRect(bx + 14, by - 4, 2, 5, p.furDark);
    this.drawRect(bx + 13, by - 6, 2, 2, p.white);

    // 身体
    this.drawRect(bx, by, 15, 8, p.outline);
    this.drawRect(bx + 1, by + 1, 13, 6, p.furDark);
    this.drawRect(bx + 3, by + 3, 7, 4, p.white);

    // 前足踩奶
    const lPawY = phase === 0 ? by + 6 : by + 7;
    const rPawY = phase === 1 ? by + 6 : by + 7;

    this.drawRect(bx + 2, lPawY, 3, 3, p.outline);
    this.drawRect(bx + 2, lPawY + 1, 2, 2, p.white);

    this.drawRect(bx + 6, rPawY, 3, 3, p.outline);
    this.drawRect(bx + 6, rPawY + 1, 2, 2, p.white);

    // 后足稳稳站立
    this.drawRect(bx + 11, by + 7, 3, 3, p.outline);
    this.drawRect(bx + 12, by + 7, 2, 2, p.white);

    // 头部 (微微昂头依恋)
    const hx = bx - 2;
    const hy = by - 8;
    this.drawRect(hx, hy, 15, 9, p.outline);
    this.drawRect(hx + 1, hy + 1, 13, 7, p.furDark);

    this.drawEars(hx, hy, p);
    this.drawFaceFeatures(hx, hy, p, isBlinking);
  }

  drawCatGrooming(isBlinking) {
    // 独居/舔爪动作：一只前爪抬到脸颊前舔舐
    const p = this.getPalette();
    const bx = 8;
    const by = 17;

    // 身体侧坐
    this.drawRect(bx, by, 14, 8, p.outline);
    this.drawRect(bx + 1, by + 1, 12, 6, p.furDark);
    this.drawRect(bx + 3, by + 3, 7, 3, p.white);

    // 抬起一只前爪到面颊
    const pawTick = Math.sin(this.tick * 0.2) * 1.2;
    this.drawRect(bx - 1, by - 2 + pawTick, 3, 4, p.outline);
    this.drawRect(bx, by - 1 + pawTick, 2, 2, p.white);
    this.drawPixel(bx + 1, by + pawTick, p.pinkNose); // 舔爪粉红肉垫

    // 头部
    const hx = bx - 2;
    const hy = by - 7;
    this.drawRect(hx, hy, 15, 8, p.outline);
    this.drawRect(hx + 1, hy + 1, 13, 6, p.furDark);

    this.drawEars(hx, hy, p);
    this.drawFaceFeatures(hx, hy, p, true); // 舔爪时享受眯眼

    // 身边一截发光的小猫草 / 像素小蝴蝶
    const butterY = 12 + Math.sin(this.tick * 0.15) * 3;
    this.drawPixel(27, butterY, p.accentClay);
    this.drawPixel(28, butterY - 1, p.pinkEar);
    this.drawPixel(29, butterY, p.accentClay);
  }

  drawExpressionEmbellishments() {
    const p = this.getPalette();
    if (this.expression === "happy") {
      // 偶尔冒个小爱心
      if (this.tick % 45 === 0) {
        this.spawnHeartBurst();
      }
    } else if (this.expression === "yearning") {
      // 腹心微泛微光
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

    for (let i = this.sparkles.length - 1; i >= 0; i--) {
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

export const PixelMascotRenderer = PixelCatRenderer;
