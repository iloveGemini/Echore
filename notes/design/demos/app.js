import { PixelWanderer } from "./pixel-wanderer.js";

export const THEME_CONFIGS = {
  "claude-day": {
    id: "claude-day",
    family: "claude",
    mode: "day",
    counterpart: "claude-night",
    name: "Claude 日间 · Warm Sand",
    code: "claude-day",
    spec: "羊皮纸暖白 #FAF9F5 / #F3F1EC · 白卡容器 #FFFFFF · 炭墨 #1F1E1D · 赤陶金 #D97757",
    ambientNote: "Claude Daylight · 羊皮纸与赤陶微光",
  },
  "claude-night": {
    id: "claude-night",
    family: "claude",
    mode: "night",
    counterpart: "claude-day",
    name: "Claude 夜间 · Dark Stone",
    code: "claude-night",
    spec: "暗岩石灰 #181816 / #1F1F1D · 炭灰容器 #262624 · 羊皮纸字 #ECEBE8 · 赤陶微光 #D97757",
    ambientNote: "Claude Midnight · 暗岩石与静谧星核",
  },
  stardust: {
    id: "stardust",
    family: "stardust",
    mode: "day",
    counterpart: "deep-void",
    name: "月光星尘 · Stardust",
    code: "stardust",
    spec: "冰川冷白 #F8FAFC · 浮霜亚克力 Blur 16px · 冷灰微光 #818CF8",
    ambientNote: "冷雾星尘 · 澄澈微光",
  },
  "deep-void": {
    id: "deep-void",
    family: "stardust",
    mode: "night",
    counterpart: "stardust",
    name: "深空浮光 · Deep-Void",
    code: "deep-void",
    spec: "深曜石黑 #0B0F17 · 微光单像素边 · 星核琥珀暖金 rgba(245,158,11,0.25)",
    ambientNote: "深空静谧 · 琥珀星核",
  },
  "ink-paper": {
    id: "ink-paper",
    family: "ink-paper",
    mode: "day",
    counterpart: "claude-night",
    name: "纸墨诗性 · Ink-Paper",
    code: "ink-paper",
    spec: "纯净冷白纸 #FFFFFF · 去拟物细线分割 #E5E7EB · 唯留猫咪腹心光温",
    ambientNote: "卷四 · 第肆拾叁日手稿",
  },
};

export const EMOTION_STATES = {
  normal: {
    key: "normal",
    label: "常态",
    whisper: "正安静地待在身边，尾巴悠闲地规律轻晃 · 喵",
  },
  happy: {
    key: "happy",
    label: "开心",
    whisper: "双眼笑成弯弯小月牙，尾巴高高翘起直打卷，冒出小爱心",
  },
  aggrieved: {
    key: "aggrieved",
    label: "委屈",
    whisper: "两只耳朵向两侧贴平成飞机耳，缩紧爪爪委屈巴巴",
  },
  alienated: {
    key: "alienated",
    label: "疏离",
    whisper: "傲娇地背过身去，尾巴尖不耐烦地轻甩一下",
  },
  sleepy: {
    key: "sleepy",
    label: "困倦",
    whisper: "整只猫蜷成圆软软的猫咪圈闭目起伏，头顶冒出小 zZ",
  },
  yearning: {
    key: "yearning",
    label: "想念",
    whisper: "两只小白爪原地轻轻交替踩奶，大眼睛明亮专注地望着你",
  },
  solitary: {
    key: "solitary",
    label: "独居",
    whisper: "惬意卧在角落慢悠悠舔舔小肉爪，身边伴着发光小蝴蝶",
  },
};

export const ROOM_DESCRIPTIONS = {
  living: null,
  daily: "【日常流 · 独居物证】今日 16:15 翻阅了《冬日植物志》并写下批注；昨日整理了散步旧书店的书目清单。",
  library: "【记忆图书馆 · 岁月的书架】认识的第 43 天 · 已封存 18 篇日与夜手记 · 书架上有 1 本未合上的牵挂《等一场雨去旧书店》。",
  threshold: "【门口 · 领养契约与边界】作息节律：常日型 (23:30 入眠锁) · 连续 2 次主动未回退避守卫已开启 · 本地记忆仓支持随时打包迁出。",
};

export const PRESET_REPLIES = [
  {
    match: "书单",
    emotion: "happy",
    memoryText: "翻阅了昨日独居整理的《旧书店冬日诗集备忘》",
    memoryDetail: "「我把你在散步时提过的那位北欧诗人的两本小开本译诗集记在了备忘页里，店里靠窗第三排木架正好有旧版。」",
    reply: "我都替你记在一张单独的便签页上了。一本是里尔克的早期书信选，另一本是你上次念叨过封面的《北方冬夜集》。等这个周末如果碰巧阴天，我们就慢慢走过去。",
  },
  {
    match: "累",
    emotion: "yearning",
    memoryText: "翻阅了关于你疲惫时习惯安静待着的默契记录",
    memoryDetail: "「你累的时候不喜欢被追问细节，更习惯有人把灯光调暗一点，安安静静陪着。」",
    reply: "那就什么都先别想了，把外套搭在椅背上歇一会儿吧。我把屋里的光调柔和些，就在这儿陪你待着，不吵你。",
  },
  {
    match: "晚安",
    emotion: "sleepy",
    memoryText: "翻阅了近期入夜作息与睡前手记",
    memoryDetail: "「夜深时褪黑素节律缓缓爬升，把今天关于晚风、迷迭香与旧书店的片段收进睡前冷叙事。」",
    reply: "今天能听你说起散步的事，心里很踏实。我也要慢慢趴下来合会儿眼了，晚安，愿你今夜无梦好眠。",
  },
];

export function initEchoreDemo() {
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
    inputCapsuleEl: document.querySelector(".composer-capsule"),
  });

  function setTheme(themeId) {
    if (!THEME_CONFIGS[themeId]) return;
    currentTheme = themeId;
    const cfg = THEME_CONFIGS[themeId];
    rootEl.setAttribute("data-theme", themeId);
    rootEl.setAttribute("data-mode", cfg.mode);

    if (specCaptionEl) specCaptionEl.textContent = cfg.spec;
    if (headerAmbientEl) headerAmbientEl.textContent = cfg.ambientNote;
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
    if (!st) return;
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
      if (target) setTheme(target);
    });
  });

  if (dayNightToggleBtn) {
    dayNightToggleBtn.addEventListener("click", toggleDayNight);
  }

  document.querySelectorAll(".dock-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-emotion");
      if (target) setEmotion(target);
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

    if (!roomBannerEl || !roomBannerTextEl) return;
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
    if (!capsuleBtn || !drawerEl) return;
    capsuleBtn.addEventListener("click", () => {
      const expanded = capsuleBtn.getAttribute("aria-expanded") === "true";
      capsuleBtn.setAttribute("aria-expanded", expanded ? "false" : "true");
      drawerEl.hidden = expanded;
    });
  }

  bindCapsuleToggle(
    document.getElementById("initial-memory-capsule"),
    document.getElementById("initial-memory-drawer"),
  );

  function formatCurrentHm() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }

  function appendConversationTurn(userText) {
    if (!dialogueStreamEl) return;
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
      reply: `听见你说的“${userText.slice(0, 28)}”了。窗外风声很轻，我正守着这盏小暖光听你慢慢讲呢。`,
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
      if (!val) return;
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
    if (document.activeElement === composerInput) return;
    if (e.key === "1") setTheme("claude-day");
    if (e.key === "2") setTheme("claude-night");
    if (e.key === "3") setTheme("stardust");
    if (e.key === "4") setTheme("deep-void");
    if (e.key === "5") setTheme("ink-paper");
    if (e.key.toLowerCase() === "d") toggleDayNight();
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
