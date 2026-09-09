export interface UsageSummary {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface UsageTrendPoint {
  timestamp: number;
  label: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
  officialEstimatedCostUsd: number;
  customOpenAiEquivalentCostUsd: number;
}

export interface ProviderUsage {
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  openAiEquivalentCostUsd: number;
  costStatus: string;
}

export interface ModelUsage extends ProviderUsage {
  model: string;
}

export interface CostSummary {
  officialEstimatedCostUsd: number;
  customActualCostUsd: number | null;
  customOpenAiEquivalentCostUsd: number;
  allProvidersOpenAiEquivalentCostUsd: number;
  note: string;
}

export interface ForkHandling {
  replayEventsSkipped: number;
  deferredFiles: number;
  deferredDetails: Array<{ path: string; reason: string }>;
}

export interface UsageReport {
  codexHome: string;
  range: string;
  fromTimestamp: number;
  toTimestamp: number;
  timelineGrain: "hour" | "day" | "week" | "month" | string;
  timeline: UsageTrendPoint[];
  filesScanned: number;
  filesParsed: number;
  totals: UsageSummary;
  costSummary: CostSummary;
  byProvider: ProviderUsage[];
  byProviderModel: ModelUsage[];
  forkHandling: ForkHandling;
  parseErrors: string[];
  duplicateRequestsSkipped: number;
}
