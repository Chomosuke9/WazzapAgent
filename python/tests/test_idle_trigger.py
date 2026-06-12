"""Tests for the idle trigger pure logic.

Since importing bridge.main triggers Pydantic model loading that requires
Python 3.10+ union syntax (str | None), and the test environment runs
Python 3.9, we reproduce the pure arithmetic logic of _compute_idle_trigger
directly here. This mirrors the implementation in bridge/main.py exactly.

Covers:
  - msg_count < min_val → False
  - msg_count == min_val when min_val == max_val (single-point) → True
  - msg_count == max_val → True (overflow guard fix)
  - msg_count > max_val → True (was negative probability before fix)
  - msg_count in (min_val, max_val) → bool, no exception
"""
from __future__ import annotations

import random
import unittest


def _compute_idle_trigger(min_val: int, max_val: int, msg_count: int) -> bool:
  # NOTE: This is a copy of bridge.session._compute_idle_trigger. It must be kept
  # in sync with the production implementation. bridge.session cannot be imported
  # under Python 3.9 because other parts of the module use str | None union
  # syntax (requires 3.10+). If the logic changes in bridge/session.py, update
  # this copy and the tests accordingly.
  """Pure logic for idle trigger probability. Mirrors bridge/main.py exactly."""
  if msg_count < min_val:
    return False
  if min_val == max_val:
    return True
  if msg_count >= max_val:
    return True
  return random.random() < (1.0 / (max_val - msg_count + 1))


class TestComputeIdleTriggerBelowMin(unittest.TestCase):
  def test_below_min_returns_false(self) -> None:
    self.assertFalse(_compute_idle_trigger(min_val=5, max_val=10, msg_count=3))

  def test_zero_count_below_min_returns_false(self) -> None:
    self.assertFalse(_compute_idle_trigger(min_val=1, max_val=5, msg_count=0))

  def test_one_below_min_returns_false(self) -> None:
    self.assertFalse(_compute_idle_trigger(min_val=3, max_val=7, msg_count=2))


class TestComputeIdleTriggerSinglePoint(unittest.TestCase):
  def test_min_equals_max_at_count_returns_true(self) -> None:
    self.assertTrue(_compute_idle_trigger(min_val=3, max_val=3, msg_count=3))

  def test_min_equals_max_above_count_returns_true(self) -> None:
    # msg_count > max_val when min == max — the min==max branch fires first,
    # returning True before we even reach the overflow guard. Still True.
    self.assertTrue(_compute_idle_trigger(min_val=3, max_val=3, msg_count=5))


class TestComputeIdleTriggerOverflowGuard(unittest.TestCase):
  """Before the fix, msg_count > max_val computed 1.0 / (max_val - msg_count + 1)
  with a negative denominator, yielding a negative probability (silent bug).
  The explicit `if msg_count >= max_val: return True` guard corrects this."""

  def test_msg_count_equals_max_val_returns_true(self) -> None:
    self.assertTrue(_compute_idle_trigger(min_val=3, max_val=5, msg_count=5))

  def test_msg_count_exceeds_max_val_by_one_returns_true(self) -> None:
    self.assertTrue(_compute_idle_trigger(min_val=3, max_val=5, msg_count=6))

  def test_msg_count_far_exceeds_max_val_returns_true(self) -> None:
    # msg_count=10, max_val=5 → denominator would be (5-10+1) = -4 without guard
    self.assertTrue(_compute_idle_trigger(min_val=3, max_val=5, msg_count=10))

  def test_msg_count_equals_max_val_large(self) -> None:
    self.assertTrue(_compute_idle_trigger(min_val=10, max_val=20, msg_count=20))

  def test_msg_count_exceeds_max_val_large(self) -> None:
    self.assertTrue(_compute_idle_trigger(min_val=10, max_val=20, msg_count=25))


class TestComputeIdleTriggerProbabilistic(unittest.TestCase):
  """For msg_count in (min_val, max_val), function returns bool without exception."""

  def test_returns_bool_in_range(self) -> None:
    results = set()
    for _ in range(200):
      result = _compute_idle_trigger(min_val=1, max_val=10, msg_count=5)
      self.assertIsInstance(result, bool)
      results.add(result)
    # With 200 trials at probability 1/6, False should appear at least once.
    self.assertIn(False, results)

  def test_no_exception_for_various_in_range_counts(self) -> None:
    for msg_count in range(2, 9):
      result = _compute_idle_trigger(min_val=2, max_val=9, msg_count=msg_count)
      self.assertIsInstance(result, bool)

  def test_returns_bool_near_max(self) -> None:
    # msg_count = max_val - 1: probability = 1/(max_val-(max_val-1)+1) = 1/2
    result = _compute_idle_trigger(min_val=1, max_val=5, msg_count=4)
    self.assertIsInstance(result, bool)

  def test_returns_bool_at_min_with_range(self) -> None:
    # msg_count == min_val but min_val < max_val → probabilistic branch
    result = _compute_idle_trigger(min_val=2, max_val=8, msg_count=2)
    self.assertIsInstance(result, bool)


class TestIdleTriggerFailurePathBehavior(unittest.TestCase):
    """Validates counter behavior that would apply in the LLM2 failure path.

    In the failure path, idle_msg_count[chat_id] += len(llm1_trigger_payloads)
    on each failure. Once the count reaches max_val, _should_idle_trigger fires
    and resets the counter to 0, preventing indefinite accumulation.
    """

    def test_counter_at_max_val_after_accumulation_fires(self) -> None:
        """After enough failures to reach max_val, trigger must fire."""
        # Simulate 5 batches of 2 messages each, min=5, max=10
        count = 0
        for _ in range(5):
            count += 2  # += len(llm1_trigger_payloads)
        self.assertEqual(count, 10)
        self.assertTrue(_compute_idle_trigger(5, 10, count))

    def test_counter_just_below_max_val_is_probabilistic(self) -> None:
        """Counter one below max_val is probabilistic, not guaranteed."""
        # At max_val-1: probability = 1/(max_val-(max_val-1)+1) = 1/2
        # So it can return either True or False, but never raises an exception
        result = _compute_idle_trigger(5, 10, 9)
        self.assertIsInstance(result, bool)

    def test_counter_reset_after_trigger_fire_starts_fresh(self) -> None:
        """Simulating the counter reset: after trigger fires (returns True),
        counter goes to 0. Next call with count=0 returns False (below min)."""
        # Trigger fires at max_val
        self.assertTrue(_compute_idle_trigger(5, 10, 10))
        # After reset, count=0 is below min=5
        self.assertFalse(_compute_idle_trigger(5, 10, 0))


class TestIdleTriggerCollaborator(unittest.TestCase):
  """Step 08: exercise the real bridge.agent.idle_trigger.IdleTrigger class.

  Importable under Python 3.12 (the suite interpreter); constructs the
  collaborator with a fake ``get_idle_trigger`` — no DB / socket / LLM."""

  def _make(self, cfg):
    from bridge.agent.idle_trigger import IdleTrigger
    return IdleTrigger(get_idle_trigger=lambda chat_id: cfg)

  def test_compute_matches_pure_logic(self) -> None:
    from bridge.agent.idle_trigger import IdleTrigger
    self.assertFalse(IdleTrigger.compute(5, 10, 3))
    self.assertTrue(IdleTrigger.compute(3, 3, 3))
    self.assertTrue(IdleTrigger.compute(3, 5, 5))
    self.assertTrue(IdleTrigger.compute(3, 5, 10))
    self.assertIsInstance(IdleTrigger.compute(1, 10, 5), bool)

  def test_should_trigger_false_when_no_config(self) -> None:
    self.assertFalse(self._make(None).should_trigger("c", 100))

  def test_should_trigger_uses_config(self) -> None:
    trig = self._make((5, 10))
    self.assertFalse(trig.should_trigger("c", 3))   # below min
    self.assertTrue(trig.should_trigger("c", 10))   # at/over max

  def test_should_trigger_single_point_config(self) -> None:
    self.assertTrue(self._make((4, 4)).should_trigger("c", 4))


if __name__ == "__main__":
  unittest.main()
