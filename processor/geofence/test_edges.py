"""Entry/exit edge detection from an in/out sequence."""

from edges import detect_edge, edges_from_sequence, ENTRY, EXIT


def test_first_observation_has_no_edge():
    assert detect_edge(None, True) is None
    assert detect_edge(None, False) is None


def test_entry_and_exit_transitions():
    assert detect_edge(False, True) == ENTRY
    assert detect_edge(True, False) == EXIT


def test_no_edge_when_state_unchanged():
    assert detect_edge(True, True) is None
    assert detect_edge(False, False) is None


def test_sequence_reports_each_crossing_with_index():
    # out, out, IN(entry@2), in, OUT(exit@4), out
    flags = [False, False, True, True, False, False]
    assert edges_from_sequence(flags) == [(2, ENTRY), (4, EXIT)]


def test_sequence_with_multiple_crossings():
    flags = [True, False, True]  # exit@1, entry@2 (first sighting inside, no edge)
    assert edges_from_sequence(flags) == [(1, EXIT), (2, ENTRY)]


def test_empty_and_single_sequences_have_no_edges():
    assert edges_from_sequence([]) == []
    assert edges_from_sequence([True]) == []
