// Latency breakdown arithmetic for the offline probe (pure, unit-tested).
//
// The probe reads the geofence-alerts stream, so for each breach it has the in-band
// `trace` stamps (eventTime t0, ingestTime t1, flinkRead t3, flinkEmit t4) plus the
// alerts-stream ApproximateArrivalTimestamp (t5). It computes the detection-track
// hops from those; the triage track (t6…t10) is emitted separately via EMF and read
// from CloudWatch, not from the breach payload.

export interface TraceBlock {
  eventTime?: number;
  ingestTime?: number;
  flinkRead?: number;
  flinkEmit?: number;
}

export type HopBreakdown = Record<string, number>;

// Hop name -> [start stamp, end stamp]. All epoch millis. `alertsArrival` (t5) is
// supplied by the consumer, not the payload.
const HOPS: ReadonlyArray<readonly [string, keyof TraceBlock | 'alertsArrival', keyof TraceBlock | 'alertsArrival']> = [
  ['SourceToIoT', 'eventTime', 'ingestTime'],       // t0 -> t1
  ['IngestToFlink', 'ingestTime', 'flinkRead'],     // t1 -> t3 (stream wait + read)
  ['FlinkProcess', 'flinkRead', 'flinkEmit'],       // t3 -> t4
  ['FlinkToAlerts', 'flinkEmit', 'alertsArrival'],  // t4 -> t5
];

/** Per-hop deltas (ms) for one breach; only hops with both endpoints present. */
export function hopBreakdown(trace: TraceBlock, alertsArrival?: number): HopBreakdown {
  const stamps: Record<string, number | undefined> = { ...trace, alertsArrival };
  const hops: HopBreakdown = {};
  for (const [name, start, end] of HOPS) {
    const a = stamps[start];
    const b = stamps[end];
    if (a !== undefined && b !== undefined) hops[name] = b - a;
  }
  return hops;
}

/** Cumulative detection latency (t0 -> t5) when both ends are known. */
export function detectionTotal(trace: TraceBlock, alertsArrival?: number): number | undefined {
  if (trace.eventTime === undefined || alertsArrival === undefined) return undefined;
  return alertsArrival - trace.eventTime;
}

/** Mean of each hop across many breach breakdowns (skips absent hops per event). */
export function averageHops(breakdowns: HopBreakdown[]): HopBreakdown {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const b of breakdowns) {
    for (const [name, value] of Object.entries(b)) {
      sums[name] = (sums[name] ?? 0) + value;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  const avg: HopBreakdown = {};
  for (const name of Object.keys(sums)) avg[name] = sums[name] / counts[name];
  return avg;
}

/** An EMF log document for one breach's hops under the Geofence/Latency namespace. */
export function emfDocument(hops: HopBreakdown, stage = 'detection'): Record<string, unknown> {
  const metricNames = Object.keys(hops);
  return {
    _aws: {
      CloudWatchMetrics: [{
        Namespace: 'Geofence/Latency',
        Dimensions: [['stage']],
        Metrics: metricNames.map((name) => ({ Name: name, Unit: 'Milliseconds' })),
      }],
    },
    stage,
    ...hops,
  };
}
