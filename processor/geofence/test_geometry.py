"""Point-in-polygon correctness against a concave polygon (AC3)."""

from geometry import point_in_polygon, distance_to_boundary_m

# An L-shaped (concave) zone, closed ring of [lat, lon].
# In (lon=x, lat=y): (0,0)-(4,0)-(4,2)-(2,2)-(2,4)-(0,4). The top-right square
# (lon 2..4, lat 2..4) is the concavity and is OUTSIDE the zone.
L_ZONE = [
    [0, 0],
    [0, 4],
    [2, 4],
    [2, 2],
    [4, 2],
    [4, 0],
    [0, 0],
]


def test_inside_bottom_bar():
    assert point_in_polygon(1, 1, L_ZONE) is True


def test_inside_left_bar():
    assert point_in_polygon(3, 1, L_ZONE) is True


def test_inside_bottom_right():
    assert point_in_polygon(1, 3, L_ZONE) is True


def test_concavity_is_outside():
    # the notch — a naive bounding-box test would wrongly call this inside
    assert point_in_polygon(3, 3, L_ZONE) is False


def test_clearly_outside():
    assert point_in_polygon(5, 5, L_ZONE) is False
    assert point_in_polygon(1, -1, L_ZONE) is False


def test_on_bottom_edge_is_inside():
    # midpoint of the (0,0)-(4,0) edge, i.e. lat 0, lon 2
    assert point_in_polygon(0, 2, L_ZONE) is True


def test_on_notch_edge_is_inside():
    # midpoint of the inner vertical edge at lon 2, lat 2..4
    assert point_in_polygon(3, 2, L_ZONE) is True


def test_strict_interior_excludes_boundary():
    assert point_in_polygon(0, 2, L_ZONE, boundary_inside=False) is False


def test_near_edge_outside_within_gps_accuracy():
    # ~0.0001 deg below the bottom edge -> outside, but only ~11 m off.
    point_lat, point_lon = -0.0001, 2
    assert point_in_polygon(point_lat, point_lon, L_ZONE) is False
    d = distance_to_boundary_m(point_lat, point_lon, L_ZONE)
    assert 10.0 < d < 13.0  # 0.0001 deg latitude ~ 11.13 m


def test_distance_zero_on_boundary():
    assert distance_to_boundary_m(0, 2, L_ZONE) < 1e-6


def test_degenerate_polygon_is_outside():
    assert point_in_polygon(1, 1, [[0, 0], [0, 1]]) is False
