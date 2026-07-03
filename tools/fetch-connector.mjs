// Download the Flink Kinesis connector jar that Managed Service for Apache Flink
// needs bundled in the processor artifact. The jar is git-ignored (64 MB binary),
// so run this once before deploying ProcessingStack:  npm run fetch:connector
//
// MSF validates at create time that `lib/flink-sql-connector-kinesis.jar` exists in
// the zip, so without it the ProcessingStack deploy fails. Version 5.1.0-1.20 matches
// the FLINK-1_20 runtime.
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

const VERSION = '5.1.0-1.20';
const URL = `https://repo1.maven.org/maven2/org/apache/flink/flink-sql-connector-kinesis/${VERSION}/flink-sql-connector-kinesis-${VERSION}.jar`;
const DIR = 'processor/lib';
const DEST = `${DIR}/flink-sql-connector-kinesis.jar`;

if (existsSync(DEST) && statSync(DEST).size > 1_000_000) {
  console.log(`already present: ${DEST} (${(statSync(DEST).size / 1e6).toFixed(0)} MB)`);
  process.exit(0);
}

mkdirSync(DIR, { recursive: true });
console.log(`downloading ${URL} ...`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
await new Promise((resolve, reject) => {
  const file = createWriteStream(DEST);
  Readable.fromWeb(res.body).pipe(file).on('finish', resolve).on('error', reject);
});
console.log(`saved ${DEST} (${(statSync(DEST).size / 1e6).toFixed(0)} MB)`);
