import type { LLMProvider, OrganRole } from "./types.ts";

export interface OrganModelRoute {
  provider: LLMProvider;
  model: string;
  maxTokens?: number;
}

export type OrganRoutingTable = Record<OrganRole, OrganModelRoute>;

export const DEFAULT_ORGAN_MODELS: Record<OrganRole, string> = {
  frontstage: "claude-opus-5-5",
  compiler: "claude-opus-5-5",
  worker: "claude-sonnet-5-5",
  endocrine: "claude-haiku-5-5",
};

/**
 * 按岗位模型路由器（Organ Model Router）
 * 支持不同器官混搭不同厂商与不同量级的模型（如前台用 Claude Opus 5.5，情绪官用 Haiku 5.5 或 DeepSeek）
 */
export class OrganModelRouter {
  private readonly routes: OrganRoutingTable;

  constructor(
    routes: Partial<OrganRoutingTable> & { defaultProvider?: LLMProvider },
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
  }

  getRoute(role: OrganRole): OrganModelRoute {
    return this.routes[role];
  }

  setRoute(role: OrganRole, route: OrganModelRoute): void {
    this.routes[role] = route;
  }
}
