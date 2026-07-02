"""Labeled breach set for the H1 eval (fixtures).

Each item is a factual breach event (the shape 002 emits) plus a ground-truth
``label`` — genuine incident vs jitter/benign false positive — mirroring the 001
simulator's scenarios (violators driven through zones vs benign vehicles whose poor
GPS fix nicks a boundary; expected dwell-site traffic). The live eval joins real
simulator metadata by (vehicleId, time); this fixture set lets the harness and its
metrics run with no cloud. The label is stripped before a breach reaches any triager.
"""

from metrics import GENUINE, FALSE_POSITIVE

_BASE_TS = 1782458400000


def _breach(vehicle_id, zone_id, zone_name, kind, breach_type, *, dist, dur, acc,
            vehicle=None, ts=_BASE_TS):
    return {
        "vehicleId": vehicle_id,
        "zoneId": zone_id,
        "zoneName": zone_name,
        "zoneKind": kind,
        "breachType": breach_type,
        "timestamp": ts,
        "location": {"latitude": 51.05, "longitude": -114.07, "accuracy": acc},
        "distanceOutsideM": dist,
        "durationInStateS": dur,
        "vehicle": vehicle or {"speed": 45.0, "ignition": True, "doorOpen": False},
    }


# label -> (breach). Kept explicit so the intent of each case is readable.
LABELED = [
    # --- Genuine incidents: should ALERT. ---
    (GENUINE, _breach("veh-001", "zone-depot-foothills", "Foothills Depot Yard",
                      "containment", "exit", dist=300, dur=120, acc=3)),
    (GENUINE, _breach("veh-002", "zone-airport-yyc", "YYC Airside",
                      "exclusion", "entry", dist=0, dur=45, acc=4,
                      vehicle={"speed": 30.0, "ignition": True, "doorOpen": False})),
    (GENUINE, _breach("veh-003", "zone-downtown-restricted", "Downtown Restricted Core",
                      "exclusion", "entry", dist=0, dur=40, acc=5)),
    (GENUINE, _breach("veh-004", "zone-depot-foothills", "Foothills Depot Yard",
                      "containment", "exit", dist=150, dur=90, acc=6,
                      vehicle={"speed": 50.0, "ignition": True, "doorOpen": True})),
    # Genuine but HIDING BEHIND A POOR FIX — corroborated by a door open while moving.
    # The static baseline reads it as jitter and misses it; the rubric keeps it.
    (GENUINE, _breach("veh-011", "zone-depot-foothills", "Foothills Depot Yard",
                      "containment", "exit", dist=22, dur=16, acc=18,
                      vehicle={"speed": 55.0, "ignition": True, "doorOpen": True})),

    # --- False positives: should SUPPRESS. ---
    (FALSE_POSITIVE, _breach("veh-005", "zone-downtown-restricted", "Downtown Restricted Core",
                             "exclusion", "entry", dist=5, dur=5, acc=25)),
    (FALSE_POSITIVE, _breach("veh-006", "zone-airport-yyc", "YYC Airside",
                             "exclusion", "entry", dist=3, dur=3, acc=30)),
    (FALSE_POSITIVE, _breach("veh-007", "zone-jobsite-north", "North Job Site",
                             "dwell", "entry", dist=0, dur=10, acc=4)),
    (FALSE_POSITIVE, _breach("veh-008", "zone-jobsite-north", "North Job Site",
                             "dwell", "exit", dist=0, dur=25, acc=5)),
    (FALSE_POSITIVE, _breach("veh-009", "zone-depot-foothills", "Foothills Depot Yard",
                             "containment", "exit", dist=8, dur=4, acc=20)),
    (FALSE_POSITIVE, _breach("veh-010", "zone-downtown-restricted", "Downtown Restricted Core",
                             "exclusion", "entry", dist=10, dur=8, acc=18)),
    # Poor fix that lingered a little past the line: distance is within GPS error and
    # nothing corroborates. The baseline pages on the raw distance; the rubric does not.
    (FALSE_POSITIVE, _breach("veh-012", "zone-downtown-restricted", "Downtown Restricted Core",
                             "exclusion", "entry", dist=30, dur=25, acc=24,
                             vehicle={"speed": 15.0, "ignition": True, "doorOpen": False})),
]


def breaches_without_labels():
    """The breach events only — what a triager sees (labels withheld)."""
    return [dict(breach) for _label, breach in LABELED]


def labels():
    return [label for label, _breach in LABELED]
