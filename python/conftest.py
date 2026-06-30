import os
import sys
from pathlib import Path

# Ensure activation is off by default for the test suite so payloads
# are never silently dropped by the activation gate. Individual tests
# that need activation ON can set it before importing bridge modules.
os.environ.setdefault("REQUIRE_ACTIVATION", "false")

_ROOT = str(Path(__file__).resolve().parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
