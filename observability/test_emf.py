"""Unit tests for the triage EMF documents (004 T5): namespace, dimensions, names."""

import json

from emf import NAMESPACE, document, analyzer_document, publisher_document


def test_document_shape_has_namespace_dimensions_and_metric_names():
    doc = document({"TriageBedrock": 240, "NotifyTotal": 30}, stage="analyzer")
    cw = doc["_aws"]["CloudWatchMetrics"][0]
    assert cw["Namespace"] == NAMESPACE
    assert cw["Dimensions"] == [["stage"]]
    names = {m["Name"] for m in cw["Metrics"]}
    assert names == {"TriageBedrock", "NotifyTotal"}
    assert all(m["Unit"] == "Milliseconds" for m in cw["Metrics"])
    # metric values live at the document root (EMF requirement)
    assert doc["TriageBedrock"] == 240 and doc["stage"] == "analyzer"


def test_document_is_json_serializable():
    json.dumps(document({"NotifyTotal": 30}, stage="publisher"))


def test_missing_stamp_drops_that_hop():
    doc = document({"TriageBedrock": 240, "SqsEnqueue": None}, stage="analyzer")
    names = {m["Name"] for m in doc["_aws"]["CloudWatchMetrics"][0]["Metrics"]}
    assert names == {"TriageBedrock"}
    assert "SqsEnqueue" not in doc


def test_analyzer_document_computes_the_bedrock_hop():
    doc = analyzer_document({"analyzerRead": 1000, "bedrockDone": 1240, "sqsEnqueue": 1250})
    assert doc["TriageBedrock"] == 240 and doc["SqsEnqueue"] == 10
    assert doc["stage"] == "analyzer"
    assert doc["_aws"]["Timestamp"] == 1250


def test_publisher_document_computes_notify_total():
    doc = publisher_document({"publisherRead": 2000, "snsPublish": 2030})
    assert doc["NotifyTotal"] == 30 and doc["stage"] == "publisher"
