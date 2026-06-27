// Composes a realistic connected-vehicle telemetry message. The vss.* keys
// follow the COVESA Vehicle Signal Specification. Only vehicleId, geoFenceId,
// timestamp, and location.latitude/longitude are the contract downstream
// depends on; the rest is realistic payload for the triage layer to reason over.

export interface TelemetryMessage {
  vehicleId: string;
  geoFenceId: string;
  timestamp: number;
  location: {
    latitude: number;
    longitude: number;
    altitude: number;
    heading: number;
    speed: number;
    accuracy: number;
  };
  vss: Record<string, number | boolean | string>;
  telemetry: {
    engineRpm: number;
    batteryVoltage: number;
    outsideTemperature: number;
    accelerometerData: { x: number; y: number; z: number };
  };
  deviceInfo: { deviceId: string; firmwareVersion: string; signalStrength: number };
  routeInfo: { routeType: string; routeName: string };
}

export interface ComposeOptions {
  heading: number;
  speed: number;
  /** Std-dev of GPS jitter in degrees (~1e-5 deg ≈ 1 m). 0 disables. */
  jitterDeg?: number;
  routeName?: string;
}

/** Box-Muller Gaussian noise. */
function gaussian(stddev: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stddev;
}

export function composeMessage(
  vehicleId: string,
  geoFenceId: string,
  lat: number,
  lon: number,
  now: number,
  opts: ComposeOptions,
): TelemetryMessage {
  const jitter = opts.jitterDeg ?? 0;
  const accuracyM = jitter > 0 ? 3 + Math.abs(gaussian(jitter)) / 1e-5 : 3.2;
  return {
    vehicleId,
    geoFenceId,
    timestamp: now,
    location: {
      latitude: lat + (jitter > 0 ? gaussian(jitter) : 0),
      longitude: lon + (jitter > 0 ? gaussian(jitter) : 0),
      altitude: 1045 + gaussian(2),
      heading: opts.heading,
      speed: opts.speed,
      accuracy: Number(accuracyM.toFixed(1)),
    },
    vss: {
      'vehicle.speed': opts.speed,
      'vehicle.ignition': true,
      'vehicle.fuel.level': Number(Math.max(0.05, 0.9 - Math.random() * 0.5).toFixed(2)),
      'vehicle.odometer': Number((30000 + Math.random() * 20000).toFixed(1)),
      'vehicle.transmission.gear': 'drive',
      'vehicle.chassis.axle.row1.wheel.left.brake.fluidLevel': 0.85,
      'vehicle.cabin.door.row1.left.isOpen': false,
      'vehicle.powertrain.engine.temperature': Number((88 + gaussian(4)).toFixed(1)),
    },
    telemetry: {
      engineRpm: Math.round(1500 + Math.random() * 2000),
      batteryVoltage: Number((12.4 + Math.random() * 0.6).toFixed(1)),
      outsideTemperature: Number((-8 + gaussian(3)).toFixed(1)),
      accelerometerData: {
        x: Number(gaussian(0.05).toFixed(2)),
        y: Number(gaussian(0.05).toFixed(2)),
        z: Number((0.98 + gaussian(0.02)).toFixed(2)),
      },
    },
    deviceInfo: {
      deviceId: `tracker-${vehicleId.slice(-4)}`,
      firmwareVersion: '2.3.5',
      signalStrength: Math.round(70 + Math.random() * 30),
    },
    routeInfo: { routeType: 'highway', routeName: opts.routeName ?? 'unknown' },
  };
}
