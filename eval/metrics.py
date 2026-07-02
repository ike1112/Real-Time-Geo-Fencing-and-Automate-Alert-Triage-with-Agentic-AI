"""Suppression/retention scoring for the H1 eval (pure).

Given each breach's ground-truth label (genuine vs false_positive) and whether a
triager chose to alert, compute the numbers the H1 bet is judged on: how many false
positives were suppressed, how many genuine events were retained, and precision /
recall / F1. The label is only ever used here, in scoring — never shown to a
triager.
"""

GENUINE = "genuine"
FALSE_POSITIVE = "false_positive"


def _rate(numerator, denominator):
    return numerator / denominator if denominator else 1.0


def score(results):
    """Score a list of ``{"label", "alert"}`` outcomes.

    Returns suppression/retention rates, precision/recall/F1, the confusion counts,
    and total cost (summed from any per-result ``cost`` field).
    """
    tp = fp = fn = tn = 0
    cost = 0.0
    for r in results:
        alerted = bool(r["alert"])
        genuine = r["label"] == GENUINE
        cost += float(r.get("cost", 0.0) or 0.0)
        if genuine and alerted:
            tp += 1
        elif genuine and not alerted:
            fn += 1
        elif not genuine and alerted:
            fp += 1
        else:
            tn += 1

    precision = _rate(tp, tp + fp)
    recall = _rate(tp, tp + fn)
    f1 = _rate(2 * precision * recall, precision + recall) if (precision + recall) else 0.0
    total = len(results)
    return {
        "n": total,
        "genuine": tp + fn,
        "false_positive": fp + tn,
        "false_positive_suppression": _rate(tn, tn + fp),
        "genuine_retention": _rate(tp, tp + fn),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "cost_total": cost,
        "cost_per_event": _rate(cost, total),
    }
