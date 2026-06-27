// Telemetry simulator. Drives N vehicles along scripted Calgary routes and
// publishes realistic connected-vehicle messages to the iot_data MQTT topic via
// the IoT Data Plane API (local IAM credentials, no device certificates).
//
//   ts-node tools/simulator/index.ts --validate         offline checks (no AWS)
//   ts-node tools/simulator/index.ts --vehicles 10 --duration 120

import { ZONES, ROUTES, Route } from './data';
import { composeMessage } from './payload';
import { checkMessage, checkZone, checkRoute } from './validate';

interface Args {
  validate: boolean;
  vehicles: number;
  durationS: number;
  cadenceS: number;
  violatorFraction: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { validate: false, vehicles: 10, durationS: 0, cadenceS: 5, violatorFraction: 0.1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--validate') a.validate = true;
    else if (k === '--vehicles') a.vehicles = parseInt(argv[++i], 10);
    else if (k === '--duration') a.durationS = parseInt(argv[++i], 10);
    else if (k === '--cadence') a.cadenceS = parseFloat(argv[++i]);
    else if (k === '--violators') a.violatorFraction = parseFloat(argv[++i]);
  }
  return a;
}

function bearing(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lat1, lon1] = [toRad(a[0]), toRad(a[1])];
  const [lat2, lon2] = [toRad(b[0]), toRad(b[1])];
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Position + heading at progress t in [0,1) along a multi-segment route. */
function positionAt(route: Route, t: number): { lat: number; lon: number; heading: number } {
  const segs = route.waypoints.length - 1;
  const scaled = Math.min(Math.max(t, 0), 0.9999) * segs;
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = route.waypoints[i];
  const b = route.waypoints[i + 1];
  return {
    lat: a[0] + (b[0] - a[0]) * f,
    lon: a[1] + (b[1] - a[1]) * f,
    heading: bearing(a, b),
  };
}

function runValidate(): number {
  const errs: string[] = [];
  for (const z of ZONES) errs.push(...checkZone(z));
  for (const r of ROUTES) errs.push(...checkRoute(r));
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    const route = ROUTES[i % ROUTES.length];
    const p = positionAt(route, (i % 10) / 10);
    const msg = composeMessage(
      `veh-${String(i).padStart(3, '0')}`,
      ZONES[i % ZONES.length].id,
      p.lat,
      p.lon,
      now,
      { heading: p.heading, speed: 50, jitterDeg: 3e-5, routeName: route.name },
    );
    errs.push(...checkMessage(msg));
  }
  if (errs.length) {
    console.error('VALIDATE: FAIL');
    errs.forEach((e) => console.error('  -', e));
    return 1;
  }
  console.log(
    `VALIDATE: PASS — ${ZONES.length} zones, ${ROUTES.length} routes parse; sample messages schema-valid`,
  );
  return 0;
}

async function runPublish(args: Args): Promise<void> {
  const { IoTDataPlaneClient, PublishCommand } = await import('@aws-sdk/client-iot-data-plane');
  const client = new IoTDataPlaneClient({});

  const vehicles = Array.from({ length: args.vehicles }, (_, i) => {
    const route = ROUTES[i % ROUTES.length];
    return {
      id: `veh-${String(i).padStart(3, '0')}`,
      geoFenceId: ZONES[i % ZONES.length].id,
      route,
      progress: Math.random(),
      isViolator: Math.random() < args.violatorFraction,
    };
  });

  console.log(`Publishing ${vehicles.length} vehicles to iot_data every ${args.cadenceS}s (Ctrl+C to stop)`);
  const deadline = args.durationS > 0 ? Date.now() + args.durationS * 1000 : Infinity;

  const tick = async () => {
    const now = Date.now();
    for (const v of vehicles) {
      v.progress = (v.progress + 0.02) % 1;
      const p = positionAt(v.route, v.progress);
      const msg = composeMessage(v.id, v.geoFenceId, p.lat, p.lon, now, {
        heading: p.heading,
        speed: 40 + Math.random() * 40,
        jitterDeg: v.isViolator ? 8e-5 : 3e-5,
        routeName: v.route.name,
      });
      await client.send(
        new PublishCommand({ topic: 'iot_data', payload: Buffer.from(JSON.stringify(msg)) }),
      );
    }
    console.log(`${new Date(now).toISOString()} published ${vehicles.length} messages`);
  };

  // First tick immediately, then on cadence until the deadline.
  await tick();
  await new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
        return;
      }
      await tick();
    }, args.cadenceS * 1000);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.validate) {
    process.exit(runValidate());
  }
  await runPublish(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
