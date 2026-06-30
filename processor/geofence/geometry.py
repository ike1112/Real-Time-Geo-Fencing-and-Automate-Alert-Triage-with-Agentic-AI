"""Point-in-polygon containment for geofence zones.

Pure geometry, no dependencies beyond the standard library, so it unit-tests
directly and the stream processor can import it unchanged.

Polygons are a closed (or implicitly-closed) ring of ``[lat, lon]`` pairs, matching
the zone store. Ray casting handles concave polygons correctly. Boundary points are
treated as INSIDE (inclusive) — a deliberate choice so a vehicle sitting exactly on
a zone edge is considered within the zone; callers wanting strict interior can pass
``boundary_inside=False``.
"""

import math

# Tolerance for "point lies on an edge", in coordinate degrees. ~1e-9 deg is well
# below GPS resolution, so exact-on-edge points register while points even a
# fraction of a metre off do not.
_ON_EDGE_EPS = 1e-9


def _vertices(polygon):
    """Return polygon as (x=lon, y=lat) tuples with any closing duplicate dropped."""
    pts = [(float(p[1]), float(p[0])) for p in polygon]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts


def _on_segment(px, py, ax, ay, bx, by):
    """True if point (px,py) lies on segment (ax,ay)-(bx,by) within tolerance."""
    cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    if abs(cross) > _ON_EDGE_EPS:
        return False
    return (
        min(ax, bx) - _ON_EDGE_EPS <= px <= max(ax, bx) + _ON_EDGE_EPS
        and min(ay, by) - _ON_EDGE_EPS <= py <= max(ay, by) + _ON_EDGE_EPS
    )


def point_in_polygon(lat, lon, polygon, boundary_inside=True):
    """Return whether (lat, lon) is inside the polygon (boundary inclusive)."""
    verts = _vertices(polygon)
    n = len(verts)
    if n < 3:
        return False

    x, y = float(lon), float(lat)

    for i in range(n):
        ax, ay = verts[i]
        bx, by = verts[(i + 1) % n]
        if _on_segment(x, y, ax, ay, bx, by):
            return boundary_inside

    # Even-odd ray casting: count boundary crossings of a ray going +x from (x, y).
    inside = False
    for i in range(n):
        ax, ay = verts[i]
        bx, by = verts[(i + 1) % n]
        if (ay > y) != (by > y):
            x_cross = (bx - ax) * (y - ay) / (by - ay) + ax
            if x < x_cross:
                inside = not inside
    return inside


def _segment_distance_m(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def distance_to_boundary_m(lat, lon, polygon):
    """Metres from (lat, lon) to the nearest polygon edge.

    Uses a local equirectangular projection around the point, accurate at the
    scale of a zone. The breach event reports this as ``distanceOutsideM`` (how
    far a containment-exit is outside, or how far a near-miss sits from an edge).
    """
    verts = _vertices(polygon)
    if len(verts) < 2:
        return float("inf")

    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(float(lat)))
    px, py = float(lon) * m_per_deg_lon, float(lat) * m_per_deg_lat

    best = float("inf")
    n = len(verts)
    for i in range(n):
        ax, ay = verts[i][0] * m_per_deg_lon, verts[i][1] * m_per_deg_lat
        bx, by = verts[(i + 1) % n][0] * m_per_deg_lon, verts[(i + 1) % n][1] * m_per_deg_lat
        best = min(best, _segment_distance_m(px, py, ax, ay, bx, by))
    return best
