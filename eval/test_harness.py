"""Tests for the H1 eval harness: metrics math, baseline/reference, delta, label-hiding."""

import baseline
import reference
from dataset import LABELED, breaches_without_labels
from harness import run, compare
from metrics import score, GENUINE, FALSE_POSITIVE


# --- metrics math on hand-built vectors ---

def test_score_perfect_classifier():
    results = [{"label": GENUINE, "alert": True}, {"label": FALSE_POSITIVE, "alert": False}]
    m = score(results)
    assert m["precision"] == 1.0 and m["recall"] == 1.0
    assert m["false_positive_suppression"] == 1.0 and m["genuine_retention"] == 1.0


def test_score_counts_and_cost():
    results = [
        {"label": GENUINE, "alert": True, "cost": 0.01},     # tp
        {"label": GENUINE, "alert": False, "cost": 0.01},    # fn
        {"label": FALSE_POSITIVE, "alert": True, "cost": 0.01},   # fp
        {"label": FALSE_POSITIVE, "alert": False, "cost": 0.01},  # tn
    ]
    m = score(results)
    assert (m["tp"], m["fn"], m["fp"], m["tn"]) == (1, 1, 1, 1)
    assert m["recall"] == 0.5 and m["precision"] == 0.5
    assert m["cost_total"] == 0.04 and round(m["cost_per_event"], 3) == 0.01


# --- the fixture set is internally consistent ---

def test_dataset_has_both_classes():
    kinds = {label for label, _ in LABELED}
    assert kinds == {GENUINE, FALSE_POSITIVE}
    assert len(LABELED) >= 10


def test_breaches_carry_no_label_field():
    # The triager input must not leak the ground truth.
    assert all("label" not in b for b in breaches_without_labels())


# --- baseline and reference over the real fixture set ---

def test_baseline_is_a_real_bar_not_a_strawman():
    m = run(baseline.decide)
    # A tuned baseline gets most cases right but is not perfect (that is the point).
    assert 0.6 <= m["precision"] < 1.0
    assert 0.6 <= m["recall"] < 1.0


def test_reference_beats_the_baseline_on_the_fixtures():
    result = compare(reference.decide, "reference")
    # The harness must be able to MEASURE a positive delta (machinery check).
    assert result["delta"]["precision"] > 0
    assert result["delta"]["recall"] >= 0
    assert result["subject"]["precision"] >= result["baseline"]["precision"]
    assert result["subject"]["genuine_retention"] >= result["baseline"]["genuine_retention"]


def test_reference_retains_all_genuine_and_suppresses_all_false():
    m = run(reference.decide)
    assert m["genuine_retention"] == 1.0        # loses no real incident
    assert m["false_positive_suppression"] == 1.0
