import { assertNoInternalLeaks } from "../core/schemas.ts";

export interface DesktopWindowSample {
  appName: string;
  windowTitle: string;
  timestamp: string;
  durationMinutes?: number;
  musicTrack?: string;
  sharedScreenFocus?: string;
}

export type DesktopActivityCategory =
  | "coding"
  | "writing"
  | "browsing"
  | "media"
  | "idle"
  | "private_blocked";

export interface DesktopPresenceResult {
  filteredOutByPrivacy: boolean;
  continuousFocusHours: number;
  category: DesktopActivityCategory;
  sliceText: string | null;
}

const PRIVACY_BLACKLIST_PATTERNS: RegExp[] = [
  /1password|bitwarden|keepass|lastpass|keychain|钥匙串|密码管理/i,
  /bank|paypal|alipay|网银|银行|支付宝|证券|账单/i,
  /wechat|weixin|微信|telegram|signal|whatsapp|imessage|messages|飞书|钉钉|私信/i,
  /incognito|private\s*browsing|inprivate|无痕|隐私窗口|隐私模式/i,
];

const CODING_PATTERNS =
  /vscode|visual\s*studio\s*code|cursor|zed|windsurf|intellij|webstorm|pycharm|neovim|vim|xcode|terminal|iterm|warp|ghostty|\.ts\b|\.py\b|\.rs\b|\.go\b/i;
const WRITING_PATTERNS =
  /obsidian|notion|typora|word|pages|google\s*docs|scrivener|craft|\.md\b|文档|笔记|写作/i;
const MEDIA_PATTERNS =
  /spotify|apple\s*music|netease|qqmusic|网易云音乐|音乐|youtube|bilibili|vlc|iina|netflix/i;
const BROWSING_PATTERNS =
  /chrome|safari|arc|firefox|edge|brave|浏览器/i;

/**
 * 检查单个窗口采样是否命中隐私黑名单（命中则在探针端直接丢弃）
 */
export function isPrivacyBlacklisted(sample: DesktopWindowSample): boolean {
  const combined = `${sample.appName} ${sample.windowTitle} ${sample.sharedScreenFocus ?? ""}`;
  return PRIVACY_BLACKLIST_PATTERNS.some((re) => re.test(combined));
}

export function classifyDesktopSample(
  sample: DesktopWindowSample,
): DesktopActivityCategory {
  if (isPrivacyBlacklisted(sample)) {
    return "private_blocked";
  }
  const combined = `${sample.appName} ${sample.windowTitle}`;
  if (CODING_PATTERNS.test(combined)) return "coding";
  if (WRITING_PATTERNS.test(combined)) return "writing";
  if (MEDIA_PATTERNS.test(combined)) return "media";
  if (BROWSING_PATTERNS.test(combined)) return "browsing";
  return "idle";
}

function formatFocusDurationPhrase(hours: number): string {
  if (hours >= 4) return "四个多小时";
  if (hours >= 2.8) return "快三个小时";
  if (hours >= 2) return "两个多小时";
  if (hours >= 1.4) return "一个半小时";
  return "好一阵子";
}

function sanitizeExternalText(raw: string): string {
  // Strip process names, file extensions, or accidental log-* IDs from window/track titles
  return raw
    .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
    .replace(/\b(?:vscode|cursor|chrome|safari|iterm2?|terminal|obsidian|notion|\.exe|\.app)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * §6.1 通道 2：桌面伴生感知（状态段聚合 + 隐私黑名单 + 严禁报进程名）
 */
export function evaluateDesktopPresence(
  samples: DesktopWindowSample[],
): DesktopPresenceResult {
  if (samples.length === 0) {
    return {
      filteredOutByPrivacy: false,
      continuousFocusHours: 0,
      category: "idle",
      sliceText: null,
    };
  }

  const latest = samples[samples.length - 1]!;
  if (isPrivacyBlacklisted(latest)) {
    return {
      filteredOutByPrivacy: true,
      continuousFocusHours: 0,
      category: "private_blocked",
      sliceText: null,
    };
  }

  const safeSamples = samples.filter((s) => !isPrivacyBlacklisted(s));
  const filteredOutByPrivacy = safeSamples.length < samples.length;
  if (safeSamples.length === 0) {
    return {
      filteredOutByPrivacy: true,
      continuousFocusHours: 0,
      category: "private_blocked",
      sliceText: null,
    };
  }

  // Fold consecutive state segments (ignoring brief <15min media switches at the tail)
  const classified = safeSamples.map((s) => ({
    sample: s,
    category: classifyDesktopSample(s),
    minutes: s.durationMinutes ?? 15,
  }));

  const tail = classified[classified.length - 1]!;
  let primaryCategory = tail.category;

  // Check if the user just switched to media/music after a long coding/writing streak
  let switchedToBreak = false;
  if (
    (tail.category === "media" || tail.category === "idle") &&
    tail.minutes <= 20 &&
    classified.length >= 2
  ) {
    const prev = classified[classified.length - 2]!;
    if (prev.category === "coding" || prev.category === "writing") {
      primaryCategory = prev.category;
      switchedToBreak = true;
    }
  }

  let focusMinutes = 0;
  for (let i = classified.length - 1; i >= 0; i--) {
    const item = classified[i]!;
    if (i === classified.length - 1 && switchedToBreak) {
      continue;
    }
    if (item.category === primaryCategory) {
      focusMinutes += item.minutes;
    } else {
      break;
    }
  }

  const continuousFocusHours = focusMinutes / 60;
  const musicTrack = tail.sample.musicTrack
    ? sanitizeExternalText(tail.sample.musicTrack)
    : "";
  const sharedFocus = tail.sample.sharedScreenFocus
    ? sanitizeExternalText(tail.sample.sharedScreenFocus)
    : "";

  // Anti-stalker rule: do not nag on short, ordinary window switches without focus streak or shared screen
  if (continuousFocusHours < 1.5 && !sharedFocus && !switchedToBreak) {
    return {
      filteredOutByPrivacy,
      continuousFocusHours,
      category: primaryCategory,
      sliceText: null,
    };
  }

  const parts: string[] = [];
  const durationPhrase = formatFocusDurationPhrase(continuousFocusHours);

  if (primaryCategory === "coding") {
    if (switchedToBreak && musicTrack) {
      parts.push(
        `看他已经在电脑前连续写了${durationPhrase}代码，刚刚切出编辑器放了一首《${musicTrack}》歇口气`,
      );
    } else if (switchedToBreak) {
      parts.push(
        `看他已经在电脑前连续写了${durationPhrase}代码，刚刚停下手头的代码歇口气`,
      );
    } else {
      parts.push(`看他已经在电脑前连续写了${durationPhrase}代码`);
      if (musicTrack) {
        parts.push(`耳机里正放着《${musicTrack}》`);
      }
    }
  } else if (primaryCategory === "writing") {
    parts.push(`看他在桌前连续专注整理了${durationPhrase}文稿`);
    if (musicTrack) {
      parts.push(`背景里放着《${musicTrack}》`);
    }
  } else if (primaryCategory === "browsing") {
    parts.push(`看他在屏幕前连续翻看了${durationPhrase}资料`);
  } else if (primaryCategory === "media") {
    if (musicTrack) {
      parts.push(`看他已经连续听了${durationPhrase}音乐，正放着《${musicTrack}》`);
    } else {
      parts.push(`看他在屏幕前连续看了${durationPhrase}影音节目`);
    }
  }

  if (sharedFocus) {
    parts.push(
      parts.length === 0
        ? `看他正把屏幕停在「${sharedFocus}」上`
        : `正把屏幕停在「${sharedFocus}」上`,
    );
  }

  const sliceText = parts.length > 0 ? parts.join("，") : null;
  if (sliceText) {
    assertNoInternalLeaks(sliceText, "evaluateDesktopPresence");
  }

  return {
    filteredOutByPrivacy,
    continuousFocusHours,
    category: primaryCategory,
    sliceText,
  };
}
