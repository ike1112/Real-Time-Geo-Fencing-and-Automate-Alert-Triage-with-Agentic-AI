"""H1 eval harness: run a triager over the labeled breach set and report the numbers.

A *triager* is any ``callable(breach) -> {"alert": bool, "severity": str}``. The
harness withholds the label, runs the triager over every breach, scores the
outcomes (metrics.score), and reports the H1 numbers: false-positive suppression,
genuine retention, precision/recall, and the delta vs the tuned static baseline.

Tier-1 (this file, no cloud) runs the baseline and the deterministic reference
triager so the machinery — metric computation, the baseline, the delta table,
label-hiding — is proven end to end. The live run swaps in the deployed analyzer
(Bedrock) as the triager to produce the real H1 result; nothing here calls a model.
"""

import baseline
import reference
from dataset import breaches_without_labels, labels
from metrics import score


def run(triager, breaches=None, event_labels=None):
    """Score ``triager`` over the labeled set; return the metrics dict."""
    breaches = breaches_without_labels() if breaches is None else breaches
    event_labels = labels() if event_labels is None else event_labels
    results = []
    for label, breach in zip(event_labels, breaches):
        decision = triager(breach)  # the triager never sees `label`
        results.append({"label": label, "alert": bool(decision["alert"]),
                       "cost": decision.get("cost", 0.0)})
    return score(results)


def compare(triager, name):
    """Metrics for ``triager`` and the baseline, plus the key deltas."""
    subject = run(triager)
    base = run(baseline.decide)
    return {
        "name": name,
        "subject": subject,
        "baseline": base,
        "delta": {
            "false_positive_suppression": subject["false_positive_suppression"] - base["false_positive_suppression"],
            "genuine_retention": subject["genuine_retention"] - base["genuine_retention"],
            "precision": subject["precision"] - base["precision"],
            "recall": subject["recall"] - base["recall"],
            "f1": subject["f1"] - base["f1"],
        },
    }


def _fmt_row(label, m):
    return (f"{label:<24} suppress={m['false_positive_suppression']:.0%}  "
            f"retain={m['genuine_retention']:.0%}  P={m['precision']:.2f}  "
            f"R={m['recall']:.2f}  F1={m['f1']:.2f}  $/{m['n']}evt={m['cost_per_event']:.4f}")


def _print_report(result):
    print(f"H1 eval - {result['name']} vs tuned static baseline "
          f"(n={result['subject']['n']}, "
          f"{result['subject']['genuine']} genuine / {result['subject']['false_positive']} false)")
    print("-" * 88)
    print(_fmt_row("baseline (static rule)", result["baseline"]))
    print(_fmt_row(result["name"], result["subject"]))
    d = result["delta"]
    print("-" * 88)
    print(f"delta  suppress {d['false_positive_suppression']:+.0%}  "
          f"retain {d['genuine_retention']:+.0%}  P {d['precision']:+.2f}  "
          f"R {d['recall']:+.2f}  F1 {d['f1']:+.2f}")


def main():
    # Offline self-test of the harness: the deterministic reference triager stands in
    # for the deployed analyzer (see reference.py). The live run replaces it.
    _print_report(compare(reference.decide, "reference (offline stand-in)"))


if __name__ == "__main__":
    main()
