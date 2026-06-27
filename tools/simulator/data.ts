// Pilot geography: Calgary, Alberta. Geography is data — zones and routes live
// here so the pilot region can change without touching the pipeline.

export type ZoneKind = 'exclusion' | 'containment' | 'dwell';

export interface Zone {
  id: string;
  name: string;
  description: string;
  type: ZoneKind;
  alertLevel: string;
  /** Closed ring of [lat, lon]; first and last points equal. */
  polygon: [number, number][];
}

export const ZONES: Zone[] = [
  {
    id: 'zone-downtown-restricted',
    name: 'Downtown Restricted Core',
    description: 'Restricted-access downtown core',
    type: 'exclusion',
    alertLevel: 'high',
    polygon: [
      [51.050, -114.085],
      [51.050, -114.060],
      [51.040, -114.060],
      [51.040, -114.085],
      [51.050, -114.085],
    ],
  },
  {
    id: 'zone-depot-foothills',
    name: 'Foothills Depot Yard',
    description: 'Vehicle yard; leaving after hours is a theft signal',
    type: 'containment',
    alertLevel: 'critical',
    polygon: [
      [51.025, -114.010],
      [51.025, -113.990],
      [51.012, -113.990],
      [51.012, -114.010],
      [51.025, -114.010],
    ],
  },
  {
    id: 'zone-airport-yyc',
    name: 'YYC Airside',
    description: 'Airport airside no-go area',
    type: 'exclusion',
    alertLevel: 'critical',
    polygon: [
      [51.140, -114.020],
      [51.140, -113.995],
      [51.120, -113.995],
      [51.120, -114.020],
      [51.140, -114.020],
    ],
  },
  {
    id: 'zone-jobsite-north',
    name: 'North Job Site',
    description: 'Customer site; arrivals and departures expected',
    type: 'dwell',
    alertLevel: 'low',
    polygon: [
      [51.165, -114.080],
      [51.165, -114.065],
      [51.155, -114.065],
      [51.155, -114.080],
      [51.165, -114.080],
    ],
  },
];

export interface Route {
  name: string;
  /** Ordered [lat, lon] waypoints along real Calgary roads. */
  waypoints: [number, number][];
}

export const ROUTES: Route[] = [
  {
    name: 'Deerfoot Trail (north-south)',
    waypoints: [
      [51.180, -114.000],
      [51.120, -114.005],
      [51.060, -114.010],
      [51.020, -113.995],
    ],
  },
  {
    name: 'Glenmore Trail (east-west)',
    waypoints: [
      [51.000, -114.120],
      [51.000, -114.080],
      [51.000, -114.040],
      [51.000, -114.000],
    ],
  },
  {
    name: 'Memorial Drive into downtown',
    waypoints: [
      [51.050, -114.120],
      [51.048, -114.090],
      [51.045, -114.072],
    ],
  },
];
