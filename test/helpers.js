// Test helpers: build synthetic CatalogEntry objects like catalog.normalizeItem emits.
export function entry(over = {}) {
  return {
    provider: over.provider ?? "openrouter",
    id: over.id ?? "x/model-1",
    name: over.name ?? `X: ${over.id ?? "x/model-1"}`,
    inPerM: over.inPerM ?? 500_000,
    outPerM: over.outPerM ?? 1_000_000,
    priceTiers: over.priceTiers ?? [],
    contextWindow: over.contextWindow ?? 1_048_576,
    maxTokens: over.maxTokens ?? 131_072,
    inputModalities: over.inputModalities ?? ["text"],
    supportsTools: over.supportsTools ?? true,
    outputsText: over.outputsText ?? true,
    free: over.free ?? false,
    variant: over.variant ?? (over.id?.endsWith(":free") ? "free" : over.id?.endsWith(":batch") ? "batch" : over.id?.startsWith("~") ? "router" : "base"),
    benchmarks: over.benchmarks ?? {},
    reasoningEfforts: over.reasoningEfforts ?? ["high", "medium", "low"],
    canonicalSlug: over.canonicalSlug ?? (over.id ?? "x/model-1"),
    huggingFaceId: over.huggingFaceId ?? null,
    description: over.description ?? "general model",
    created: over.created ?? 1,
    portalRecommendedFree: over.portalRecommendedFree ?? false,
  };
}

export const DAY = 86_400_000;
