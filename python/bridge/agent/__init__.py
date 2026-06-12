"""``bridge.agent`` — injectable per-account collaborators.

Step 08 begins decomposing the ``session.py`` god-module by extracting the
lowest-risk, most self-contained concerns into small classes that own one
responsibility plus their own state and are constructed with explicit
dependencies (so they are unit-testable with fakes — no live socket/LLM):

  - :class:`~bridge.agent.idle_trigger.IdleTrigger`
  - :class:`~bridge.agent.reply_dedup.ReplyDedup`
  - :class:`~bridge.agent.mute_gate.MuteGate`

Later steps (09–10) extract the LLM1/LLM2/batch/subagent collaborators.
"""
