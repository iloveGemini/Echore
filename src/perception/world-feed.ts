export interface WorldFeedItem {
  id: string;
  title: string;
  url: string;
  source: string;
  contentExcerpt: string;
  publishedAt?: string;
}

export type WorldFeedFetcher = (params?: {
  topicOrSource?: string;
  limit?: number;
}) => Promise<WorldFeedItem[]>;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtmlTags(html: string): string {
  return decodeXmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagContent(block: string, tagName: string): string {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(re);
  return match?.[1] ? stripHtmlTags(match[1]) : "";
}

/**
 * 解析 RSS 2.0 / Atom XML 为干净的 WorldFeedItem 列表
 */
export function parseRssFeedXml(
  xmlText: string,
  sourceLabel = "RSS订阅",
  limit = 5,
): WorldFeedItem[] {
  const items: WorldFeedItem[] = [];
  const itemBlocks =
    xmlText.match(/<item[\s\S]*?<\/item>/gi) ??
    xmlText.match(/<entry[\s\S]*?<\/entry>/gi) ??
    [];

  for (let i = 0; i < itemBlocks.length && items.length < limit; i++) {
    const block = itemBlocks[i]!;
    const title = extractTagContent(block, "title");
    let url = extractTagContent(block, "link");
    if (!url) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      url = hrefMatch?.[1]?.trim() ?? "";
    }
    const rawDesc =
      extractTagContent(block, "content:encoded") ||
      extractTagContent(block, "content") ||
      extractTagContent(block, "description") ||
      extractTagContent(block, "summary");
    const publishedAt =
      extractTagContent(block, "pubDate") ||
      extractTagContent(block, "published") ||
      extractTagContent(block, "updated") ||
      undefined;

    if (!title) continue;

    items.push({
      id: `feed-${i + 1}-${title.slice(0, 16).replace(/\s+/g, "-")}`,
      title,
      url: url || "https://example.com/feed-item",
      source: sourceLabel,
      contentExcerpt: rawDesc.slice(0, 280),
      publishedAt,
    });
  }

  return items;
}

/**
 * 提取 HTML 网页正文为干净标题与摘要（不依赖厂商专属工具）
 */
export function extractCleanHtmlArticle(
  htmlText: string,
  maxExcerptChars = 360,
): { title: string; excerpt: string } {
  const titleMatch = htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = htmlText.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = stripHtmlTags(titleMatch?.[1] || h1Match?.[1] || "未命名文章");

  const articleMatch =
    htmlText.match(/<article[\s\S]*?<\/article>/i) ??
    htmlText.match(/<main[\s\S]*?<\/main>/i) ??
    htmlText.match(/<body[\s\S]*?<\/body>/i);

  const rawBody = articleMatch?.[0] ?? htmlText;
  const cleanBody = stripHtmlTags(rawBody);
  return {
    title,
    excerpt: cleanBody.slice(0, maxExcerptChars),
  };
}

export const DEFAULT_CURATED_FEEDS: WorldFeedItem[] = [
  {
    id: "feed-city-rain-architecture",
    title: "为什么老街区的骑楼在下雨天总让人想慢下来",
    url: "https://example.com/articles/arcade-rain-walk",
    source: "城市漫游周刊",
    contentExcerpt:
      "现代玻璃幕墙把雨声隔绝在三层中空玻璃之外，而旧骑楼半敞开的廊柱让人刚好站在雨幕边缘，听得到石板路溅起的水声却淋不湿肩膀。",
  },
  {
    id: "feed-late-night-bakery",
    title: "凌晨四点开始发酵的面团：记巷口那家只做三种面包的铺子",
    url: "https://example.com/articles/4am-sourdough",
    source: "风物志",
    contentExcerpt:
      "店主坚持不用商业速发酵母，湿度变化会让每天出炉的时间差上半小时。熟客们从不催促，只在散步路过闻到麦香时顺手买走一袋。",
  },
];

/**
 * 创建厂商中立的外部世界信息流获取器
 */
export function createWorldFeedFetcher(options?: {
  items?: WorldFeedItem[];
  rssSources?: Array<{ source: string; xml: string }>;
}): WorldFeedFetcher {
  return async (params) => {
    const limit = params?.limit ?? 2;
    const topic = params?.topicOrSource?.trim().toLowerCase();

    const pool: WorldFeedItem[] = [];
    if (options?.rssSources) {
      for (const src of options.rssSources) {
        pool.push(...parseRssFeedXml(src.xml, src.source, limit * 2));
      }
    }
    if (options?.items) {
      pool.push(...options.items);
    }
    if (pool.length === 0) {
      pool.push(...DEFAULT_CURATED_FEEDS);
    }

    const filtered = topic
      ? pool.filter(
          (item) =>
            item.title.toLowerCase().includes(topic) ||
            item.source.toLowerCase().includes(topic) ||
            item.contentExcerpt.toLowerCase().includes(topic),
        )
      : pool;

    return (filtered.length > 0 ? filtered : pool).slice(0, limit);
  };
}
