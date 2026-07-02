"""Put each Python source tree on sys.path so tests import by module name.

The Lambda handler (lambda/rules_bridge) and the processor library
(processor/geofence) are separate deploy units, not an installed package, so their
tests import siblings directly (`from handler import ...`, `from geometry import ...`).
This adds those dirs to the path for the whole test session.
"""

import os
import sys

_ROOT = os.path.dirname(__file__)

for _relative in (
    "lambda/rules_bridge",
    "lambda/analyzer_bridge",
    "lambda/publisher_bridge",
    "processor/geofence",
    "agents/analyzer",
    "agents/publisher",
    "eval",
):
    _path = os.path.join(_ROOT, _relative)
    if _path not in sys.path:
        sys.path.insert(0, _path)
