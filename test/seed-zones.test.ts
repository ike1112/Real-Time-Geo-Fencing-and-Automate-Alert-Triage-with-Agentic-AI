import { buildZoneItems, toAttributeValue, toDynamoItem } from '../tools/seed-zones';

describe('zone seed items', () => {
  const items = buildZoneItems();

  test('seeds exactly the four Calgary zones', () => {
    expect(items.map((z) => z.id).sort()).toEqual([
      'zone-airport-yyc',
      'zone-depot-foothills',
      'zone-downtown-restricted',
      'zone-jobsite-north',
    ]);
  });

  test('covers the three zone kinds', () => {
    const kinds = new Set(items.map((z) => z.properties.type));
    expect(kinds).toEqual(new Set(['exclusion', 'containment', 'dwell']));
  });

  test('every item is active with the required fields', () => {
    for (const z of items) {
      expect(z.active).toBe(true);
      expect(z.name).toBeTruthy();
      expect(z.description).toBeTruthy();
      expect(z.properties.alertLevel).toBeTruthy();
      expect(typeof z.createdAt).toBe('number');
      expect(typeof z.updatedAt).toBe('number');
    }
  });

  test('every polygon is a closed ring of at least four points', () => {
    for (const z of items) {
      expect(z.polygon.length).toBeGreaterThanOrEqual(4);
      expect(z.polygon[0]).toEqual(z.polygon[z.polygon.length - 1]);
    }
  });
});

describe('DynamoDB marshalling', () => {
  test('marshals scalars, lists, and maps to attribute values', () => {
    expect(toAttributeValue('x')).toEqual({ S: 'x' });
    expect(toAttributeValue(50)).toEqual({ N: '50' });
    expect(toAttributeValue(true)).toEqual({ BOOL: true });
    expect(toAttributeValue([[51.05, -114.08]])).toEqual({
      L: [{ L: [{ N: '51.05' }, { N: '-114.08' }] }],
    });
  });

  test('a marshalled item is a typed attribute map the polygon nested as a list', () => {
    const item = toDynamoItem(buildZoneItems()[0]);
    expect(item.id).toHaveProperty('S');
    expect(item.active).toEqual({ BOOL: true });
    expect(item.polygon).toHaveProperty('L');
    expect(item.properties).toHaveProperty('M');
    expect((item.properties as { M: Record<string, unknown> }).M).toHaveProperty('type');
  });
});
