import type { ProxyMetric, WorkerEnv } from "./types.js";

type MetricSnapshot = {
  adapter: string;
  action: string;
  outcome: string;
  statusClass: string;
  count: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
};

const metricsCounters = new Map<string, MetricSnapshot>();

function incrementMetricSnapshot(metric: ProxyMetric): void {
  const key = `${metric.adapter}:${metric.action}:${metric.outcome}:${metric.statusClass}`;
  const existing =
    metricsCounters.get(key) ||
    ({
      adapter: metric.adapter,
      action: metric.action,
      outcome: metric.outcome,
      statusClass: metric.statusClass,
      count: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    } as MetricSnapshot);

  existing.count += 1;
  existing.totalLatencyMs += metric.latencyMs;
  existing.maxLatencyMs = Math.max(existing.maxLatencyMs, metric.latencyMs);
  metricsCounters.set(key, existing);
}

export function getMetricsSnapshot(): Array<MetricSnapshot & { avgLatencyMs: number }> {
  return [...metricsCounters.values()].map((item) => ({
    ...item,
    avgLatencyMs: item.count > 0 ? Number((item.totalLatencyMs / item.count).toFixed(2)) : 0,
  }));
}

export async function emitAnalyticsMetric(env: WorkerEnv, metric: ProxyMetric): Promise<void> {
  incrementMetricSnapshot(metric);

  if (!env.PINCER_METRICS || typeof env.PINCER_METRICS.writeDataPoint !== "function") {
    return;
  }

  try {
    env.PINCER_METRICS.writeDataPoint({
      blobs: [
        metric.adapter,
        metric.action,
        metric.outcome,
        metric.statusClass,
        metric.denyReason || "",
      ],
      doubles: [metric.latencyMs],
    });
  } catch {
    // Metrics failures are non-fatal in v1.
  }
}

export function classifyStatus(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
