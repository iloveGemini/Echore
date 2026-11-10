import {
  assertNoInternalLeaks,
  type WeatherSnapshot,
  WeatherSnapshotSchema,
} from "../core/schemas.ts";

export interface ChronoAmbientInput {
  now: Date;
  lastUserMessageAt: string | null;
  weather?: WeatherSnapshot;
  isHolidayOrAnniversary?: string;
  userActiveLateNight?: boolean;
}

export interface ChronoAmbientSlice {
  triggered: boolean;
  silenceHours: number;
  isWeatherShock: boolean;
  isSpecialTimeWindow: boolean;
  isLongDisconnect: boolean;
  sliceText: string | null;
}

const SEVERE_CONDITIONS = new Set(["heavy_rain", "storm", "snow"]);
const TEMP_SHOCK_DELTA_C = 6;
const LONG_DISCONNECT_HOURS = 48;

function formatNaturalSilenceDuration(hours: number): string {
  const days = Math.floor(hours / 24);
  if (days >= 5) {
    return "好几天";
  }
  if (days >= 3) {
    return "三四天";
  }
  if (days >= 2) {
    return hours >= 60 ? "两天半" : "两天多";
  }
  return "一天半";
}

function describeWeatherShock(weather: WeatherSnapshot): string | null {
  const parsed = WeatherSnapshotSchema.parse(weather);
  const tempDrop =
    parsed.previousTemperatureC !== undefined
      ? parsed.previousTemperatureC - parsed.temperatureC
      : 0;
  const hasSevereCondition = SEVERE_CONDITIONS.has(parsed.condition);
  const hasTempShock = tempDrop >= TEMP_SHOCK_DELTA_C;
  const hasAlert = Boolean(parsed.alert?.trim());
  const cleanAlert = parsed.alert
    ? parsed.alert.replace(/\blog-\d{4,}[-\w]*\b/gi, "").trim()
    : "";

  if (!hasSevereCondition && !hasTempShock && !hasAlert) {
    return null;
  }

  const parts: string[] = [];
  if (parsed.condition === "heavy_rain") {
    parts.push("窗外刚下起暴雨");
  } else if (parsed.condition === "storm") {
    parts.push("窗外突然刮起雷暴大风");
  } else if (parsed.condition === "snow") {
    parts.push("窗外飘起了雪");
  } else if (cleanAlert) {
    parts.push(`外面刚挂出${cleanAlert}`);
  }

  if (hasTempShock) {
    parts.push("气温一下子掉了好几度");
  } else if (cleanAlert && parts.length === 1 && !parts[0]!.includes(cleanAlert)) {
    parts.push(`天气预警提示${cleanAlert}`);
  }

  return parts.join("，");
}

/**
 * §6.1 通道 1：时空与天气感知（平时静默，突变才报）
 */
export function evaluateChronoAmbient(
  input: ChronoAmbientInput,
): ChronoAmbientSlice {
  const { now, lastUserMessageAt, weather, isHolidayOrAnniversary, userActiveLateNight } =
    input;

  let silenceHours = 0;
  if (lastUserMessageAt) {
    const diffMs = now.getTime() - new Date(lastUserMessageAt).getTime();
    silenceHours = Math.max(0, diffMs / (3600 * 1000));
  }

  const weatherDesc = weather ? describeWeatherShock(weather) : null;
  const isWeatherShock = Boolean(weatherDesc);

  const dayOfWeek = now.getDay(); // 5 = Friday
  const decimalHour = now.getHours() + now.getMinutes() / 60;
  const isFridayOffWork =
    dayOfWeek === 5 && decimalHour >= 17.5 && decimalHour <= 20.0;
  const isLateNightActive =
    decimalHour >= 1.5 &&
    decimalHour <= 4.5 &&
    Boolean(userActiveLateNight || (lastUserMessageAt && silenceHours < 0.5));
  const hasHoliday = Boolean(isHolidayOrAnniversary?.trim());

  const isSpecialTimeWindow =
    isFridayOffWork || isLateNightActive || hasHoliday;
  const isLongDisconnect = silenceHours >= LONG_DISCONNECT_HOURS;

  const clauses: string[] = [];
  if (weatherDesc) {
    clauses.push(weatherDesc);
  }
  if (hasHoliday && isHolidayOrAnniversary) {
    const cleanHoliday = isHolidayOrAnniversary
      .replace(/\blog-\d{4,}[-\w]*\b/gi, "")
      .trim();
    if (cleanHoliday) {
      clauses.push(`今天正好是${cleanHoliday}`);
    }
  } else if (isLateNightActive) {
    clauses.push("已经到了凌晨深更半夜，他居然还没睡");
  } else if (isFridayOffWork) {
    clauses.push("到了周五傍晚快下班松口气的点");
  }

  if (isLongDisconnect) {
    const durationPhrase = formatNaturalSilenceDuration(silenceHours);
    clauses.push(`距离上次和他说话已经过去${durationPhrase}了`);
  }

  if (clauses.length === 0) {
    return {
      triggered: false,
      silenceHours,
      isWeatherShock: false,
      isSpecialTimeWindow: false,
      isLongDisconnect: false,
      sliceText: null,
    };
  }

  const sliceText = clauses.join("；");
  assertNoInternalLeaks(sliceText, "evaluateChronoAmbient");

  return {
    triggered: true,
    silenceHours,
    isWeatherShock,
    isSpecialTimeWindow,
    isLongDisconnect,
    sliceText,
  };
}
