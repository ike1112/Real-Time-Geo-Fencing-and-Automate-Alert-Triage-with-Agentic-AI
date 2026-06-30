// Seed data for the geo-fences zone store. Zone geometry is sourced from the
// single canonical definition the simulator drives vehicles against, so the
// processor tests positions against exactly the boundaries the simulator uses.

import { ZONES } from './simulator/data';

/** A geo-fences table item (the zone-store record the processor reads). */
export interface ZoneItem {
  id: string;
  active: boolean;
  name: string;
  description: string;
  polygon: [number, number][];
  properties: { type: string; alertLevel: string };
  createdAt: number;
  updatedAt: number;
}

// Fixed seed baseline so the seed is deterministic (no synth/test churn).
const SEED_TIMESTAMP = 1782000000000;

/** Build the geo-fences items for all canonical zones. */
export function buildZoneItems(): ZoneItem[] {
  return ZONES.map((zone) => ({
    id: zone.id,
    active: true,
    name: zone.name,
    description: zone.description,
    polygon: zone.polygon,
    properties: { type: zone.type, alertLevel: zone.alertLevel },
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  }));
}

type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> };

/** Marshal a plain JSON value to a DynamoDB attribute value. */
export function toAttributeValue(value: unknown): AttributeValue {
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
  if (value && typeof value === 'object') {
    const map: Record<string, AttributeValue> = {};
    for (const [key, inner] of Object.entries(value)) {
      map[key] = toAttributeValue(inner);
    }
    return { M: map };
  }
  throw new Error(`Unsupported value for DynamoDB marshalling: ${String(value)}`);
}

/** Marshal a zone item to the DynamoDB item map (attribute-value form). */
export function toDynamoItem(item: ZoneItem): Record<string, AttributeValue> {
  const map: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(item)) {
    map[key] = toAttributeValue(value);
  }
  return map;
}
