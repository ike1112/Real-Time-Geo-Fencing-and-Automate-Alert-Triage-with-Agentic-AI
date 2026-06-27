// Verification reader for the telemetry stream. Reads every shard from LATEST
// for a window, and reports the objective numbers the acceptance runbook needs:
// max produce->stream latency, per-vehicle out-of-order count, and record count.
//
//   ts-node tools/verify/reader.ts [windowSeconds]   (default 60)

import {
  KinesisClient,
  ListShardsCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
} from '@aws-sdk/client-kinesis';

async function main(): Promise<void> {
  const streamName = process.env.STREAM ?? 'vehicle-telemetry';
  const windowS = parseInt(process.argv[2] ?? '60', 10);
  const client = new KinesisClient({});

  const shards = (await client.send(new ListShardsCommand({ StreamName: streamName }))).Shards ?? [];
  let iterators = (
    await Promise.all(
      shards.map(async (s) =>
        (
          await client.send(
            new GetShardIteratorCommand({
              StreamName: streamName,
              ShardId: s.ShardId,
              ShardIteratorType: 'LATEST',
            }),
          )
        ).ShardIterator,
      ),
    )
  ).filter((it): it is string => Boolean(it));

  console.log(`reading ${shards.length} shard(s) of ${streamName} for ${windowS}s...`);

  const lastTs: Record<string, number> = {};
  let maxLatency = 0;
  let outOfOrder = 0;
  let count = 0;
  const seen = new Set<string>();
  const deadline = Date.now() + windowS * 1000;

  while (Date.now() < deadline) {
    const next: string[] = [];
    for (const it of iterators) {
      const res = await client.send(new GetRecordsCommand({ ShardIterator: it, Limit: 1000 }));
      for (const r of res.Records ?? []) {
        if (!r.Data) continue;
        const msg = JSON.parse(Buffer.from(r.Data).toString('utf8'));
        const arrivalS = (r.ApproximateArrivalTimestamp as Date).getTime() / 1000;
        const latency = arrivalS - msg.timestamp / 1000;
        if (latency > maxLatency) maxLatency = latency;
        if (lastTs[msg.vehicleId] !== undefined && msg.timestamp < lastTs[msg.vehicleId]) {
          outOfOrder++;
        }
        lastTs[msg.vehicleId] = msg.timestamp;
        seen.add(msg.vehicleId);
        count++;
      }
      if (res.NextShardIterator) next.push(res.NextShardIterator);
    }
    iterators = next;
    if (iterators.length === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const pass = count > 0 && maxLatency < 5 && outOfOrder === 0;
  console.log(`records: ${count}`);
  console.log(`vehicles: ${seen.size}`);
  console.log(`max latency s: ${maxLatency.toFixed(2)}   (AC1 < 5: ${maxLatency < 5 ? 'PASS' : 'FAIL'})`);
  console.log(`out-of-order events: ${outOfOrder}   (AC3 == 0: ${outOfOrder === 0 ? 'PASS' : 'FAIL'})`);
  console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
