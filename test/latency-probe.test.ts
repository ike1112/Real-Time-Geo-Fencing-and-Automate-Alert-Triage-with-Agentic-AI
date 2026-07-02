import { hopBreakdown, detectionTotal, averageHops, emfDocument } from '../tools/verify/latency';

describe('latency probe arithmetic (004)', () => {
  const trace = { eventTime: 1000, ingestTime: 1180, flinkRead: 1520, flinkEmit: 1523 };
  const alertsArrival = 1600;

  test('per-hop deltas are consecutive-stamp differences', () => {
    expect(hopBreakdown(trace, alertsArrival)).toEqual({
      SourceToIoT: 180,     // t1 - t0
      IngestToFlink: 340,   // t3 - t1
      FlinkProcess: 3,      // t4 - t3
      FlinkToAlerts: 77,    // t5 - t4
    });
  });

  test('cumulative detection total is t5 - t0', () => {
    expect(detectionTotal(trace, alertsArrival)).toBe(600);
  });

  test('hops with a missing endpoint are skipped, not zeroed', () => {
    expect(hopBreakdown({ eventTime: 1000, ingestTime: 1180 })).toEqual({ SourceToIoT: 180 });
    expect(detectionTotal({ ingestTime: 1180 }, 1600)).toBeUndefined();
  });

  test('averageHops means each hop over the sampled events', () => {
    const a = hopBreakdown(trace, alertsArrival);
    const b = hopBreakdown({ ...trace, flinkEmit: 1533 }, 1600); // FlinkProcess 13, FlinkToAlerts 67
    const avg = averageHops([a, b]);
    expect(avg.FlinkProcess).toBe(8);       // (3 + 13) / 2
    expect(avg.SourceToIoT).toBe(180);      // constant
  });

  test('EMF document carries the Geofence/Latency namespace and per-hop metrics', () => {
    const doc = emfDocument(hopBreakdown(trace, alertsArrival)) as any;
    expect(doc._aws.CloudWatchMetrics[0].Namespace).toBe('Geofence/Latency');
    const metricNames = doc._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name);
    expect(metricNames).toContain('FlinkProcess');
    expect(doc.stage).toBe('detection');
    expect(doc.FlinkProcess).toBe(3);
  });
});
