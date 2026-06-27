import Ajv from 'ajv';
import { Zone, Route } from './data';

// JSON Schema for a telemetry message: the required contract plus the realistic
// signal blocks. Used by the --validate dry run so a schema or geometry error
// fails fast, offline, before anything is published.
const messageSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['vehicleId', 'geoFenceId', 'timestamp', 'location', 'vss', 'telemetry', 'deviceInfo', 'routeInfo'],
  properties: {
    vehicleId: { type: 'string', minLength: 1 },
    geoFenceId: { type: 'string', minLength: 1 },
    timestamp: { type: 'integer' },
    location: {
      type: 'object',
      required: ['latitude', 'longitude', 'altitude', 'heading', 'speed', 'accuracy'],
      properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        altitude: { type: 'number' },
        heading: { type: 'number' },
        speed: { type: 'number' },
        accuracy: { type: 'number' },
      },
    },
    vss: { type: 'object' },
    telemetry: {
      type: 'object',
      required: ['engineRpm', 'batteryVoltage', 'outsideTemperature', 'accelerometerData'],
    },
    deviceInfo: { type: 'object', required: ['deviceId', 'firmwareVersion', 'signalStrength'] },
    routeInfo: { type: 'object', required: ['routeType', 'routeName'] },
  },
};

const ajv = new Ajv({ allErrors: true });
const validateMessage = ajv.compile(messageSchema);

export function checkMessage(msg: unknown): string[] {
  if (validateMessage(msg)) return [];
  return (validateMessage.errors ?? []).map((e) => `message ${e.instancePath || '/'} ${e.message}`);
}

export function checkZone(z: Zone): string[] {
  const errs: string[] = [];
  if (z.polygon.length < 4) {
    errs.push(`${z.id}: polygon needs >= 4 points (closed ring with >= 3 vertices)`);
  }
  const first = z.polygon[0];
  const last = z.polygon[z.polygon.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    errs.push(`${z.id}: polygon ring is not closed`);
  }
  for (const [lat, lon] of z.polygon) {
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errs.push(`${z.id}: point out of range [${lat}, ${lon}]`);
    }
  }
  return errs;
}

export function checkRoute(r: Route): string[] {
  return r.waypoints.length < 2 ? [`${r.name}: route needs >= 2 waypoints`] : [];
}
