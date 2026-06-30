"""Entry/exit edge detection from a vehicle's in/out sequence.

A breach is a *transition* across a zone boundary, not just being inside or
outside. The processor keeps each vehicle's previous inside-flag as keyed state
and asks this module whether the current position crossed an edge. Pure logic —
the state lives in the caller (Flink keyed state).

Dwell debounce (suppressing flapping at the boundary under GPS jitter) is a
separate, deferred concern; this module reports raw entry/exit.
"""

ENTRY = "entry"
EXIT = "exit"


def detect_edge(was_inside, is_inside):
    """Return the transition between the previous and current inside-state.

    ``was_inside`` is None on a vehicle's first observation — no edge can be
    inferred without a prior state, so None is returned.
    """
    if was_inside is None:
        return None
    if not was_inside and is_inside:
        return ENTRY
    if was_inside and not is_inside:
        return EXIT
    return None


def edges_from_sequence(inside_flags):
    """Return (index, edge) for each transition in a sequence of inside-flags."""
    edges = []
    previous = None
    for index, is_inside in enumerate(inside_flags):
        edge = detect_edge(previous, is_inside)
        if edge is not None:
            edges.append((index, edge))
        previous = is_inside
    return edges
