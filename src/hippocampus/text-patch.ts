/**
 * Wave 6.3 归一化位置映射补丁（洁净室独立实现）
 * - 不对全文做前置 NFC 重写：逐簇局部归一化并记录 UTF-16 原始区间映射，确保补丁外所有字节 100% 不变；
 * - 按 Unicode 标准将中英文弯直引号、破折号与行内连续空白归一化；
 * - 支持单处 `...` 同一行内首尾锚定；仅当全文严格唯一命中 1 处时返回替换结果，否则返回 null。
 */

const CHAR_EQUIVALENTS: Record<string, string> = {
  // Double-quote family -> ASCII "
  "“": '"', // “
  "”": '"', // ”
  "«": '"', // «
  "»": '"', // »
  "＂": '"', // ＂
  "「": '"', // 「
  "」": '"', // 」
  "『": '"', // 『
  "』": '"', // 』
  // Single-quote family -> ASCII '
  "‘": "'", // ‘
  "’": "'", // ’
  "´": "'", // ´
  "＇": "'", // ＇
  // Dash / minus family -> ASCII -
  "–": "-", // –
  "—": "-", // —
  "―": "-", // ―
  "－": "-", // －
};

const COMBINING_MARK_RE = /^\p{M}$/u;

interface NormEntry {
  ch: string;
  origStart: number;
  origEnd: number;
}

function mapScalarChar(ch: string): string {
  return CHAR_EQUIVALENTS[ch] ?? ch;
}

function buildNormalizedEntries(
  input: string,
  options?: { preserveFirstLineIndent?: boolean },
): { norm: string; entries: NormEntry[] } {
  const preserveFirstLineIndent = options?.preserveFirstLineIndent ?? true;
  const entries: NormEntry[] = [];
  const lines = splitLinesWithOffsets(input);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineInfo = lines[lineIdx]!;
    if (lineIdx > 0) {
      entries.push({
        ch: "\n",
        origStart: lineInfo.newlineStart,
        origEnd: lineInfo.start,
      });
    }

    const lineText = input.slice(lineInfo.start, lineInfo.contentEnd);
    // Strip trailing [ \t] without shifting offsets of real content
    let effectiveEnd = lineText.length;
    while (
      effectiveEnd > 0 &&
      (lineText[effectiveEnd - 1] === " " || lineText[effectiveEnd - 1] === "\t")
    ) {
      effectiveEnd -= 1;
    }

    const protectIndent = lineIdx > 0 || preserveFirstLineIndent;
    let indentEnd = 0;
    if (protectIndent) {
      while (
        indentEnd < effectiveEnd &&
        (lineText[indentEnd] === " " || lineText[indentEnd] === "\t")
      ) {
        indentEnd += 1;
      }
    }

    let i = 0;
    while (i < effectiveEnd) {
      const absI = lineInfo.start + i;
      if (i < indentEnd) {
        entries.push({
          ch: lineText[i]!,
          origStart: absI,
          origEnd: absI + 1,
        });
        i += 1;
        continue;
      }

      if (lineText[i] === " " || lineText[i] === "\t") {
        const wsStart = absI;
        while (
          i < effectiveEnd &&
          (lineText[i] === " " || lineText[i] === "\t")
        ) {
          i += 1;
        }
        entries.push({
          ch: " ",
          origStart: wsStart,
          origEnd: lineInfo.start + i,
        });
        continue;
      }

      const cp = lineText.codePointAt(i)!;
      const baseStep = cp > 0xffff ? 2 : 1;
      let clusterEnd = i + baseStep;
      while (clusterEnd < effectiveEnd) {
        const nextCp = lineText.codePointAt(clusterEnd)!;
        const nextStep = nextCp > 0xffff ? 2 : 1;
        const nextStr = lineText.slice(clusterEnd, clusterEnd + nextStep);
        if (COMBINING_MARK_RE.test(nextStr)) {
          clusterEnd += nextStep;
        } else {
          break;
        }
      }

      const rawCluster = lineText.slice(i, clusterEnd);
      const nfcCluster = rawCluster.normalize("NFC");
      const absClusterStart = absI;
      const absClusterEnd = lineInfo.start + clusterEnd;

      for (let k = 0; k < nfcCluster.length; ) {
        const subCp = nfcCluster.codePointAt(k)!;
        const subStep = subCp > 0xffff ? 2 : 1;
        const mapped = mapScalarChar(nfcCluster.slice(k, k + subStep));
        for (let m = 0; m < mapped.length; m++) {
          entries.push({
            ch: mapped[m]!,
            origStart: absClusterStart,
            origEnd: absClusterEnd,
          });
        }
        k += subStep;
      }

      i = clusterEnd;
    }
  }

  return {
    norm: entries.map((e) => e.ch).join(""),
    entries,
  };
}

function splitLinesWithOffsets(text: string): Array<{
  start: number;
  contentEnd: number;
  newlineStart: number;
}> {
  const result: Array<{
    start: number;
    contentEnd: number;
    newlineStart: number;
  }> = [];
  let lineStart = 0;
  let prevNewlineStart = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const hasCr = i > lineStart && text[i - 1] === "\r";
      result.push({
        start: lineStart,
        contentEnd: hasCr ? i - 1 : i,
        newlineStart: prevNewlineStart,
      });
      prevNewlineStart = hasCr ? i - 1 : i;
      lineStart = i + 1;
    }
  }

  result.push({
    start: lineStart,
    contentEnd: text.length,
    newlineStart: prevNewlineStart,
  });
  return result;
}

function isInsideIndentRegion(
  norm: string,
  pos: number,
  candidate: string,
  indentCollapsed: boolean,
): boolean {
  if (!candidate.startsWith(" ") && !candidate.startsWith("\t")) {
    return false;
  }
  const lineStartIdx = norm.lastIndexOf("\n", pos - 1);
  const lineStart = lineStartIdx === -1 ? 0 : lineStartIdx + 1;
  const prefix = norm.slice(lineStart, pos);
  const inIndent = prefix.split("").every((c) => c === " " || c === "\t");
  if (!inIndent) return false;
  if (indentCollapsed) {
    return prefix !== "";
  }
  return pos !== lineStart;
}

function findLiteralNormSpans(
  normSource: string,
  pattern: string,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();

  for (const preserve of [true, false]) {
    const candidate = buildNormalizedEntries(pattern, {
      preserveFirstLineIndent: preserve,
    }).norm;
    if (!candidate) continue;

    let from = 0;
    while (from <= normSource.length - candidate.length) {
      const hit = normSource.indexOf(candidate, from);
      if (hit === -1) break;
      if (!isInsideIndentRegion(normSource, hit, candidate, !preserve)) {
        const end = hit + candidate.length;
        const key = `${hit}:${end}`;
        if (!seen.has(key)) {
          seen.add(key);
          spans.push({ start: hit, end });
        }
      }
      from = hit + 1;
    }
  }

  return spans;
}

function findIntraLineEllipsisSpans(
  normSource: string,
  pattern: string,
): Array<{ start: number; end: number }> {
  const firstIdx = pattern.indexOf("...");
  const lastIdx = pattern.lastIndexOf("...");
  if (firstIdx === -1 || firstIdx !== lastIdx) {
    return [];
  }

  const rawHead = pattern.slice(0, firstIdx);
  const rawTail = pattern.slice(firstIdx + 3);
  const normTail = buildNormalizedEntries(rawTail, {
    preserveFirstLineIndent: false,
  }).norm;
  if (normTail.includes("\n")) return [];

  const spans: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();

  for (const preserve of [true, false]) {
    const normHead = buildNormalizedEntries(rawHead, {
      preserveFirstLineIndent: preserve,
    }).norm;
    if (!normHead || normHead.includes("\n")) continue;

    let lineStart = 0;
    while (lineStart <= normSource.length) {
      const nl = normSource.indexOf("\n", lineStart);
      const lineEnd = nl === -1 ? normSource.length : nl;
      const lineSlice = normSource.slice(lineStart, lineEnd);

      let hFrom = 0;
      while (hFrom <= lineSlice.length - normHead.length) {
        const hPos = lineSlice.indexOf(normHead, hFrom);
        if (hPos === -1) break;
        const absStart = lineStart + hPos;
        if (!isInsideIndentRegion(normSource, absStart, normHead, !preserve)) {
          if (!normTail) {
            const key = `${absStart}:${lineEnd}`;
            if (!seen.has(key)) {
              seen.add(key);
              spans.push({ start: absStart, end: lineEnd });
            }
          } else {
            let tFrom = hPos + normHead.length;
            while (tFrom <= lineSlice.length - normTail.length) {
              const tPos = lineSlice.indexOf(normTail, tFrom);
              if (tPos === -1) break;
              const absEnd = lineStart + tPos + normTail.length;
              const key = `${absStart}:${absEnd}`;
              if (!seen.has(key)) {
                seen.add(key);
                spans.push({ start: absStart, end: absEnd });
              }
              tFrom = tPos + 1;
            }
          }
        }
        hFrom = hPos + 1;
      }

      if (nl === -1) break;
      lineStart = nl + 1;
    }
  }

  return spans;
}

export function findUniqueNormalizedMatchRange(
  source: string,
  targetPattern: string,
): { start: number; end: number } | null {
  if (!source || !targetPattern) return null;
  const { norm, entries } = buildNormalizedEntries(source, {
    preserveFirstLineIndent: true,
  });
  if (entries.length === 0) return null;

  let spans = findLiteralNormSpans(norm, targetPattern);
  if (spans.length === 0 && targetPattern.includes("...")) {
    spans = findIntraLineEllipsisSpans(norm, targetPattern);
  }

  if (spans.length !== 1) {
    return null;
  }

  const hit = spans[0]!;
  if (hit.start >= entries.length || hit.end <= hit.start) {
    return null;
  }
  const origStart = entries[hit.start]!.origStart;
  const origEnd = entries[hit.end - 1]!.origEnd;
  return { start: origStart, end: origEnd };
}

/**
 * 在 source 中查找唯一的归一化匹配片段并替换为 replacement；
 * 未命中或命中 >= 2 处（歧义）一律返回 null；替换区间外的所有原始字节逐字节保持不变。
 */
export function replaceUniqueNormalizedFragment(
  source: string,
  targetPattern: string,
  replacement: string,
): string | null {
  const range = findUniqueNormalizedMatchRange(source, targetPattern);
  if (!range) return null;
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}
