from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional


@dataclass
class ProgressEntry:
  step: str
  detail: str
  timestamp: float
  # Short, human-readable explanation of WHY the step ran. Populated by
  # WazzapSubAgents starting from the native-tool-call refactor — older
  # sub-agents may omit it, so callers must treat it as optional.
  reason: Optional[str] = None


@dataclass
class SubTask:
  session_id: str
  instruction: str
  chat_id: str
  status: str = "running"  # "running" | "completed" | "failed" | "timeout"
  start_time: float = field(default_factory=time.time)
  end_time: Optional[float] = None
  progress: Deque[ProgressEntry] = field(default_factory=lambda: deque(maxlen=100))
  result: dict = field(default_factory=dict)
  report: Optional[str] = None

  @property
  def elapsed_seconds(self) -> float:
    end = self.end_time or time.time()
    return end - self.start_time
