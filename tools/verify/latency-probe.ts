// Offline latency probe. Reads the geofence-alerts stream for a window, computes
// each breach's per-hop + cumulative detection latency from its in-band `trace`
// block and the record ApproximateArrivalTimestamp, prints the breakdown, and
// optionally emits the deltas as EMF under Geofence/Latency.
//
//   ts-node tools/verify/latency-probe.ts [windowSeconds] [--emf]   (default 60)
//
// The arithmetic lives in ./latency.ts and is unit-tested; this file is the I/O
// shell around it (no deploy needed to test the numbers).

import {
  KinesisClient,
  ListShardsCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
} from '@aws-sdk/client-kinesis';
import { hopBreakdown, detectionTotal, averageHops, emfDocument, HopBreakdown } from './latency';

async function main(): Promise<void> {
  const streamName = process.env.ALERTS_STREAM ?? 'geofence-alerts';
  const windowS = parseInt(process.argv[2] ?? '60', 10);
  const emit = process.argv.includes('--emf');
  const client = new KinesisClient({});

  const shards = (await client.send(new ListShardsCommand({ StreamName: streamName }))).Shards ?? [];
  let iterators = (
    await Promise.all(
      shards.map(async (s) =>
        (await client.send(new GetShardIteratorCommand({
          StreamName: streamName, ShardId: s.ShardId, ShardIteratorType: 'LATEST',
        }))).ShardIterator,
      ),
    )
  ).filter((it): it is string => Boolean(it));

  console.log(`reading ${shards.length} shard(s) of ${streamName} for ${windowS}s...`);

  const breakdowns: HopBreakdown[] = [];
  const detectionTotals: number[] = [];
  const deadline = Date.now() + windowS * 1000;

  while (Date.now() < deadline) {
    const next: string[] = [];
    for (const it of iterators) {
      const res = await client.send(new GetRecordsCommand({ ShardIterator: it, Limit: 1000 }));
      for (const r of res.Records ?? []) {
        if (!r.Data) continue;
        const breach = JSON.parse(Buffer.from(r.Data).toString('utf8'));
        const arrivalMs = (r.ApproximateArrivalTimestamp as Date).getTime();
        const hops = hopBreakdown(breach.trace ?? {}, arrivalMs);
        breakdowns.push(hops);
        const total = detectionTotal(breach.trace ?? {}, arrivalMs);
        if (total !== undefined) detectionTotals.push(total);
        if (emit) console.log(JSON.stringify(emfDocument(hops)));
      }
      if (res.NextShardIterator) next.push(res.NextShardIterator);
    }
    iterators = next;
    if (iterators.length === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const avg = averageHops(breakdowns);
  const meanTotal = detectionTotals.length
    ? detectionTotals.reduce((a, b) => a + b, 0) / detectionTotals.length
    : 0;

  console.log(`\nbreach events: ${breakdowns.length}`);
  console.log('per-hop mean latency (ms):');
  for (const [name, value] of Object.entries(avg)) {
    console.log(`  ${name.padEnd(16)} ${value.toFixed(1)}`);
  }
  console.log(`detection track total (t0->alerts, mean ms): ${meanTotal.toFixed(1)}`);
  console.log('(triage track t6..t10 comes from EMF under Geofence/Latency — see the dashboard.)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
