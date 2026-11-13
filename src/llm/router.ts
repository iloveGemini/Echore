import { AnthropicAdapter } from "./anthropic.ts";
import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OpenAICompatAdapter,
} from "./openai-compat.ts";
import type { EmbeddingProvider, LLMProvider, OrganRole } from "./types.ts";

export interface OrganModelRoute {
  provider: LLMProvider;
  model: string;
  maxTokens?: number;
}

export interface EmbeddingModelRoute {
  provider: EmbeddingProvider;
  model: string;
}

export type OrganRoutingTable = Record<OrganRole, OrganModelRoute>;

export const DEFAULT_ORGAN_MODELS: Record<OrganRole, string> = {
  frontstage: "claude-opus-5-5",
  compiler: "claude-opus-5-5",
  worker: "claude-sonnet-5-5",
  endocrine: "claude-haiku-5-5",
};

export const DEFAULT_OPENAI_ORGAN_MODELS: Record<OrganRole, string> = {
  frontstage: "gpt-4o",
  compiler: "gpt-4o",
  worker: "gpt-4o-mini",
  endocrine: "gpt-4o-mini",
};

/**
 * 从环境变量（或 Bun 自动加载的 `.env`）创建四岗位模型路由器。
 * - 若配置了 `ANTHROPIC_API_KEY`，默认使用 `AnthropicAdapter`；
 * - 若配置了 `OPENAI_API_KEY`，默认使用 `OpenAICompatAdapter`（支持 OpenAI / DeepSeek / OpenRouter / 本地代理等 `OPENAI_BASE_URL`）；
 * - 支持按岗位覆写模型名：`ECHORE_FRONTSTAGE_MODEL`、`ECHORE_ENDOCRINE_MODEL`、`ECHORE_COMPILER_MODEL`、`ECHORE_WORKER_MODEL`（或统一 `ECHORE_MODEL` / `OPENAI_MODEL`）；
 * - 若均未配置，回退至传入的 `fallbackProvider`。
 */
export function resolveEmbeddingRouteFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmbeddingModelRoute | undefined {
  const explicitKey =
    env.ECHORE_EMBEDDING_API_KEY?.trim() || env.EMBEDDING_API_KEY?.trim();
  const explicitBaseUrl =
    env.ECHORE_EMBEDDING_BASE_URL?.trim() || env.EMBEDDING_BASE_URL?.trim();
  const explicitModel =
    env.ECHORE_EMBEDDING_MODEL?.trim() || env.EMBEDDING_MODEL?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const openaiBaseUrl =
    env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

  const apiKey = explicitKey || openaiKey;
  if (!apiKey && !explicitBaseUrl) {
    return undefined;
  }

  const isDefaultOpenAiEndpoint = openaiBaseUrl.includes("api.openai.com");
  if (!explicitKey && !explicitBaseUrl && !explicitModel && !isDefaultOpenAiEndpoint) {
    return undefined;
  }

  const baseURL = explicitBaseUrl || openaiBaseUrl;
  const model = explicitModel || DEFAULT_OPENAI_EMBEDDING_MODEL;
  const provider = new OpenAICompatAdapter({
    apiKey: apiKey ?? "",
    baseURL,
  });

  return { provider, model };
}

export function createOrganRouterFromEnv(
  fallbackProvider: LLMProvider,
  env: Record<string, string | undefined> = process.env,
): { router: OrganModelRouter; modeDescription: string } {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const embeddingRoute = resolveEmbeddingRouteFromEnv(env);

  if (anthropicKey) {
    const provider = new AnthropicAdapter({
      apiKey: anthropicKey,
      baseURL: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    });
    const sharedModel = env.ECHORE_MODEL?.trim();
    const frontstageModel =
      env.ECHORE_FRONTSTAGE_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_ORGAN_MODELS.frontstage;
    const endocrineModel =
      env.ECHORE_ENDOCRINE_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_ORGAN_MODELS.endocrine;
    const compilerModel =
      env.ECHORE_COMPILER_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_ORGAN_MODELS.compiler;
    const workerModel =
      env.ECHORE_WORKER_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_ORGAN_MODELS.worker;

    return {
      router: new OrganModelRouter({
        frontstage: { provider, model: frontstageModel },
        endocrine: { provider, model: endocrineModel },
        compiler: { provider, model: compilerModel },
        worker: { provider, model: workerModel },
        embedding: embeddingRoute,
      }),
      modeDescription: `Anthropic (${frontstageModel} / endocrine:${endocrineModel}${embeddingRoute ? ` / embed:${embeddingRoute.model}` : ""})`,
    };
  }

  if (openaiKey) {
    const baseURL = env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    const provider = new OpenAICompatAdapter({
      apiKey: openaiKey,
      baseURL,
    });
    const sharedModel = env.ECHORE_MODEL?.trim() || env.OPENAI_MODEL?.trim();
    const frontstageModel =
      env.ECHORE_FRONTSTAGE_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_OPENAI_ORGAN_MODELS.frontstage;
    const endocrineModel =
      env.ECHORE_ENDOCRINE_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_OPENAI_ORGAN_MODELS.endocrine;
    const compilerModel =
      env.ECHORE_COMPILER_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_OPENAI_ORGAN_MODELS.compiler;
    const workerModel =
      env.ECHORE_WORKER_MODEL?.trim() ||
      sharedModel ||
      DEFAULT_OPENAI_ORGAN_MODELS.worker;

    return {
      router: new OrganModelRouter({
        frontstage: { provider, model: frontstageModel },
        endocrine: { provider, model: endocrineModel },
        compiler: { provider, model: compilerModel },
        worker: { provider, model: workerModel },
        embedding: embeddingRoute,
      }),
      modeDescription: `OpenAI-Compatible @ ${baseURL} (${frontstageModel} / endocrine:${endocrineModel}${embeddingRoute ? ` / embed:${embeddingRoute.model}` : ""})`,
    };
  }

  return {
    router: new OrganModelRouter({
      defaultProvider: fallbackProvider,
      embedding: embeddingRoute,
    }),
    modeDescription: "Local Fallback Mock (未检测到 ANTHROPIC_API_KEY 或 OPENAI_API_KEY)",
  };
}

/**
 * 按岗位模型路由器（Organ Model Router）
 * 支持不同器官混搭不同厂商与不同量级的模型（如前台用 Claude Opus 5.5，情绪官用 Haiku 5.5 或 DeepSeek）
 */
export class OrganModelRouter {
  private readonly routes: OrganRoutingTable;
  private embeddingRoute?: EmbeddingModelRoute;

  constructor(
    routes: Partial<OrganRoutingTable> & {
      defaultProvider?: LLMProvider;
      embedding?: EmbeddingModelRoute;
    },
  ) {
    const fallbackProvider = routes.defaultProvider;
    const resolveRoute = (role: OrganRole): OrganModelRoute => {
      const explicit = routes[role];
      if (explicit) return explicit;
      if (!fallbackProvider) {
        throw new Error(
          `Missing route and defaultProvider for organ role: ${role}`,
        );
      }
      return {
        provider: fallbackProvider,
        model: DEFAULT_ORGAN_MODELS[role],
      };
    };

    this.routes = {
      frontstage: resolveRoute("frontstage"),
      endocrine: resolveRoute("endocrine"),
      compiler: resolveRoute("compiler"),
      worker: resolveRoute("worker"),
    };
    this.embeddingRoute = routes.embedding;
  }

  getRoute(role: OrganRole): OrganModelRoute {
    return this.routes[role];
  }

  setRoute(role: OrganRole, route: OrganModelRoute): void {
    this.routes[role] = route;
  }

  getEmbeddingRoute(): EmbeddingModelRoute | undefined {
    return this.embeddingRoute;
  }

  setEmbeddingRoute(route: EmbeddingModelRoute | undefined): void {
    this.embeddingRoute = route;
  }

  async embedTexts(texts: string[]): Promise<number[][] | null> {
    if (!this.embeddingRoute || texts.length === 0) {
      return null;
    }
    return this.embeddingRoute.provider.embed({
      model: this.embeddingRoute.model,
      texts,
    });
  }
}
