# File: python/bridge/llm/schemas.py
from __future__ import annotations

from pydantic import BaseModel, Field

LLM1_SCHEMA = {
    "name": "llm_should_response",
    "parameters": {
        "type": "object",
        "properties": {
            "should_response": {
                "type": "boolean",
                "description": "Indicates whether the LLM should respond (true) or not (false).",
            },
            "confidence": {
                "type": "integer",
                "description": "Confidence percentage (0-100) about the decision.",
                "minimum": 0,
                "maximum": 100,
            },
            "reason": {
                "type": "string",
                "description": (
                    "A concise routing reason for downstream handoff. "
                    "Write 1-3 short sentences (target 12-60 words) grounded in current context, "
                    "without chain-of-thought."
                ),
                "minLength": 2,
                "maxLength": 320,
            },
        },
        "required": ["should_response", "confidence", "reason"],
        "additionalProperties": False,
    },
}

LLM1_TOOL = {
    "type": "function",
    "function": {
        "name": LLM1_SCHEMA["name"],
        "description": "Decide whether the WhatsApp agent should respond to the latest message.",
        "parameters": LLM1_SCHEMA["parameters"],
        "strict": True,
    },
}

LLM1_REACT_TOOL = {
    "type": "function",
    "function": {
        "name": "llm_react",
        "description": (
            "React to a message with a single emoji — "
            "instead of sending a text reply. "
            "Use for lightweight acknowledgement, mild emotion, or confirming a human's correct answer. "
            "DO NOT overdo it. 1 reaction every 10 messages max."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "emoji": {
                    "type": "string",
                    "description": "A single emoji to react with (e.g. 👍, 😂, ❤️, 🔥, 😢).",
                    "minLength": 1,
                    "maxLength": 10,
                },
                "context_msg_id": {
                    "type": "string",
                    "description": (
                        "The 6-digit contextMsgId of the target message. "
                        "Use the id from current messages(burst). "
                        "Use the last message id if targeting the most recent message."
                    ),
                    "minLength": 6,
                    "maxLength": 6,
                },
                "confidence": {
                    "type": "integer",
                    "description": "Confidence percentage (0-100) about this decision.",
                    "minimum": 0,
                    "maximum": 100,
                },
                "reason": {
                    "type": "string",
                    "description": ("A concise reason for this action. 1-2 short sentences (max 320 chars)."),
                    "minLength": 2,
                    "maxLength": 320,
                },
            },
            "required": ["emoji", "context_msg_id", "confidence", "reason"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}


LLM1_STICKER_TOOL = {
    "type": "function",
    "function": {
        "name": "llm_sticker",
        "description": (
            "Send a sticker in response to a message — "
            "instead of sending a text reply. "
            "Use for big moments: major milestone, genuinely funny/absurd situation — "
            "only if a sticker name clearly fits. DO NOT overdo it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sticker_name": {
                    "type": "string",
                    "description": (
                        "Exact sticker name to send — see the sticker catalog "
                        "in the system prompt. Must match one of those names exactly."
                    ),
                    "minLength": 1,
                    "maxLength": 100,
                },
                "context_msg_id": {
                    "type": "string",
                    "description": (
                        "The 6-digit contextMsgId of the target message. "
                        "Use the id from current messages(burst). "
                        "Use the last message id if targeting the most recent message."
                    ),
                    "minLength": 6,
                    "maxLength": 6,
                },
                "confidence": {
                    "type": "integer",
                    "description": "Confidence percentage (0-100) about this decision.",
                    "minimum": 0,
                    "maximum": 100,
                },
                "reason": {
                    "type": "string",
                    "description": ("A concise reason for this action. 1-2 short sentences (max 320 chars)."),
                    "minLength": 2,
                    "maxLength": 320,
                },
            },
            "required": ["sticker_name", "context_msg_id", "confidence", "reason"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}


def build_llm1_tools() -> list[dict]:
    """Build the LLM1 tool list."""
    return [LLM1_TOOL, LLM1_REACT_TOOL, LLM1_STICKER_TOOL]


# ---------------------------------------------------------------------------
# LLM2 tool schemas
# ---------------------------------------------------------------------------

LLM2_REPLY_TOOL = {
    "type": "function",
    "function": {
        "name": "reply_message",
        "description": (
            "Send a text reply and optionally trigger one or more silent slash commands in the same call. "
            "context_msg_id: message to quote-reply, or 'none'. "
            "Inline mentions: @Name (senderRef). "
            "When command is an array, each element is a full slash command line. "
            "command_context_msg_id is a parallel array — each entry is the anchor for the "
            "same-index command, or null to use context_msg_id."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "context_msg_id": {
                    "type": "string",
                    "description": "6-digit contextMsgId to quote-reply to, or 'none' for standalone.",
                },
                "text": {
                    "type": "string",
                    "description": "Reply text shown to the user.",
                    "minLength": 1,
                },
                "command": {
                    "type": ["array", "null"],
                    "items": {"type": "string"},
                    "description": (
                        "One or more slash commands that run automatically alongside the reply, "
                        "e.g. ['/memory add The user likes cats.', '/help']. "
                        "A leading '/' is recommended but optional (it is added automatically "
                        "if missing). Set to null when not needed. "
                        "Only use commands when the user explicitly asks for something a command can do "
                        "(see the command list). "
                        "CRITICAL: Always append the required arguments to each command itself — "
                        "for example '/schedule-task 30M ping the group', not just '/schedule-task'. "
                        "A bare command with no arguments will fail."
                    ),
                },
                "command_context_msg_id": {
                    "type": ["array", "null"],
                    "items": {"type": "string"},
                    "description": (
                        "Parallel array of 6-digit contextMsgIds, one per command. "
                        "Each entry is the anchor for the same-index command. "
                        "Pass null when no commands need a target, "
                        "or use an array aligned with command entries."
                    ),
                },
            },
            "required": ["context_msg_id", "text", "command", "command_context_msg_id"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}
LLM2_REACT_TOOL = {
    "type": "function",
    "function": {
        "name": "react_to_message",
        "description": (
            "React to a message with a single emoji. "
            "Use for lightweight acknowledgement, agreement, humor, or emotion — no text needed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "context_msg_id": {
                    "type": "string",
                    "description": "The 6-digit contextMsgId of the message to react to.",
                    "minLength": 6,
                    "maxLength": 6,
                },
                "emoji": {
                    "type": "string",
                    "description": "A single emoji to react with (e.g. 👍, 😂, ❤️, 🔥, 😢).",
                    "minLength": 1,
                    "maxLength": 1,
                },
            },
            "required": ["context_msg_id", "emoji"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}


LLM2_STICKER_TOOL = {
    "type": "function",
    "function": {
        "name": "send_sticker",
        "description": (
            "Send a sticker in response to a message. "
            "Use for big moments — celebrations, genuinely funny/absurd situations, etc."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "context_msg_id": {
                    "type": "string",
                    "description": "The 6-digit contextMsgId of the message to reply to.",
                    "minLength": 6,
                    "maxLength": 6,
                },
                "sticker_name": {
                    "type": "string",
                    "description": (
                        "Exact sticker name to send — see the sticker catalog "
                        "in the system prompt. Must match one of those names exactly."
                    ),
                    "minLength": 1,
                    "maxLength": 100,
                },
            },
            "required": ["context_msg_id", "sticker_name"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}


LLM2_DELETE_TOOL = {
    "type": "function",
    "function": {
        "name": "delete_messages",
        "description": (
            "Delete one or more messages by their contextMsgId. Only use when messages clearly violate rules."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "context_msg_ids": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "minLength": 6,
                        "maxLength": 6,
                    },
                    "description": "List of 6-digit contextMsgIds to delete.",
                    "minItems": 1,
                },
            },
            "required": ["context_msg_ids"],
            "additionalProperties": False,
        },
    },
}

LLM2_MUTE_TOOL = {
    "type": "function",
    "function": {
        "name": "mute_member",
        "description": (
            "Mute or unmute a member. "
            "Set duration_minutes > 0 to mute (auto-delete all their messages for that duration). "
            "Set duration_minutes = 0 to unmute (cancel an active mute). "
            "Use mute for persistent rule violators."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sender_ref": {
                    "type": "string",
                    "description": "The senderRef of the member to mute or unmute.",
                    "minLength": 1,
                },
                "duration_minutes": {
                    "type": "integer",
                    "description": "How long to mute in minutes (1-1440). Use 0 to unmute.",
                    "minimum": 0,
                    "maximum": 1440,
                },
            },
            "required": ["sender_ref", "duration_minutes"],
            "additionalProperties": False,
        },
    },
}

LLM2_KICK_TOOL = {
    "type": "function",
    "function": {
        "name": "kick_members",
        "description": (
            "Remove members from the group. Cannot kick admins. Only use for serious or repeated violations."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "targets": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "sender_ref": {
                                "type": "string",
                                "description": "The senderRef of the member to kick.",
                            },
                        },
                        "required": ["sender_ref"],
                        "additionalProperties": False,
                    },
                    "description": "List of members to kick.",
                    "minItems": 1,
                },
            },
            "required": ["targets"],
            "additionalProperties": False,
        },
    },
}

LLM2_SUBAGENT_TOOL = {
    "type": "function",
    "function": {
        "name": "execute_subtask",
        "description": (
            "Delegate a complex task to a sub-agent for execution. "
            "The sub-agent will process the instruction and return a report. "
            "Use this for tasks that require multi-step reasoning, file processing, "
            "or operations that are too complex for a single LLM call. "
            "Any output files the sub-agent produces are automatically attached and "
            "sent to the chat after your text reply, one file per WhatsApp message — "
            "you do not need to mention file paths or upload them yourself. "
            "Make the instruction precise so the sub-agent only emits files the user "
            "actually wants delivered. "
            "Set high_quality=true for tasks requiring deeper reasoning, complex code "
            "generation, or analysis; set high_quality=false (default) for routine tasks "
            "like format conversion or simple scripting."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "instruction": {
                    "type": "string",
                    "description": "Clear, detailed instruction for the sub-agent to execute.",
                    "minLength": 1,
                },
                "confirmation_text": {
                    "type": "string",
                    "description": (
                        "A brief confirmation message to the user that SPECIFICALLY states "
                        "what you are about to do, in their language and WhatsApp formatting. "
                        "Say the concrete action, e.g. \"Converting your PDF to Word now\" or "
                        "\"Fixing the chart colors and re-rendering it\". "
                        "Do NOT send vague filler like \"let me try again\", \"ok\", or "
                        "\"working on it\" — the user should understand what is happening from "
                        "this message alone. On a correction re-dispatch, name what you are "
                        "correcting (e.g. \"That came back in the wrong format — redoing it as "
                        "a spreadsheet\"). If input files are provided via context_msg_ids, "
                        "this message is sent as a reply to the last file ID to acknowledge receipt."
                    ),
                    "minLength": 1,
                },
                "context_msg_ids": {
                    # OpenAI strict-mode forbids "optional" properties: every key in
                    # `properties` MUST also appear in `required`. To keep this field
                    # semantically optional, it accepts `null` as a value. Callers
                    # that want to provide nothing send `null` (which downstream
                    # action extraction normalises back to `[]` via `or []` in
                    # messaging/actions.py::_extract_actions_from_tool_calls).
                    "type": ["array", "null"],
                    "items": {
                        "type": "string",
                        "minLength": 6,
                        "maxLength": 6,
                    },
                    "description": (
                        "6-digit contextMsgIds of the messages whose files (or text) the "
                        "sub-agent should take as input; text-only messages become a .txt. "
                        "Pass the ID of the message that CONTAINS the file — use the "
                        "`<files_in_chat>` list when present — not the request that refers "
                        "to it. Include only IDs relevant to the instruction; pass null when "
                        "no input is needed. Pass multiple contextMsgIds just in case the sub-agent need more context."
                    ),
                },
                "high_quality": {
                    "type": "boolean",
                    "description": (
                        "Set to true to use a higher-capability model for tasks requiring "
                        "deeper reasoning, complex analysis, or code generation. "
                        "Defaults to false for routine tasks like format conversion, "
                        "simple lookups, or basic scripting. "
                        "Warning: high quality model could take 10+ minutes. Most case only needed low quality and faster model."
                    ),
                },
            },
            # Strict mode: every property name must be listed in `required`.
            # See note on `context_msg_ids` above for how optionality is modeled
            # via `["array", "null"]` instead of omitting the key.
            "required": [
                "instruction",
                "confirmation_text",
                "context_msg_ids",
                "high_quality",
            ],
            "additionalProperties": False,
        },
        "strict": True,
    },
}

LLM2_QUIZ_TOOL = {
    "type": "function",
    "function": {
        "name": "send_quiz",
        "description": "Send a multiple-choice quiz with tappable buttons (2–5 choices). See <quiz> for usage rules.",
        "parameters": {
            "type": "object",
            "properties": {
                "context_msg_id": {
                    "type": "string",
                    "description": "6-digit contextMsgId to quote-reply to, or 'none' for standalone.",
                },
                "question": {
                    "type": "string",
                    "description": "Full message body — include question text and choices. No length limit.",
                    "minLength": 1,
                },
                "choices": {
                    "type": "array",
                    "description": "Tappable buttons, 2–5 items.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {
                                "type": "string",
                                "description": "Single letter: A, B, C, D, or E.",
                                "minLength": 1,
                                "maxLength": 1,
                            },
                            "text": {
                                "type": "string",
                                "description": "Button text, max 20 chars.",
                                "minLength": 1,
                                "maxLength": 20,
                            },
                        },
                        "required": ["label", "text"],
                        "additionalProperties": False,
                    },
                    "minItems": 2,
                    "maxItems": 5,
                },
                "footer": {
                    "type": ["string", "null"],
                    "description": "Footer below buttons, or null.",
                },
            },
            "required": ["context_msg_id", "question", "choices", "footer"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}

# Base tools always available to LLM2 (sticker tool is built dynamically per-chat).
LLM2_BASE_TOOLS = [LLM2_REPLY_TOOL, LLM2_REACT_TOOL]


def build_llm2_tools(
    *,
    allow_delete: bool = False,
    allow_mute: bool = False,
    allow_kick: bool = False,
    allow_subagent: bool = False,
    allow_quiz: bool = True,
) -> list[dict]:
    """Build the LLM2 tool list based on current chat permissions."""
    tools = list(LLM2_BASE_TOOLS)
    tools.append(LLM2_STICKER_TOOL)
    if allow_quiz:
        tools.append(LLM2_QUIZ_TOOL)
    if allow_delete:
        tools.append(LLM2_DELETE_TOOL)
    if allow_mute:
        tools.append(LLM2_MUTE_TOOL)
    if allow_kick:
        tools.append(LLM2_KICK_TOOL)
    if allow_subagent:
        tools.append(LLM2_SUBAGENT_TOOL)
    return tools


class LLM1Decision(BaseModel):
    should_response: bool = Field(..., description="Whether to respond")
    confidence: int = Field(..., ge=0, le=100)
    reason: str = Field(..., min_length=2, max_length=320)
    react_expression: str | None = Field(default=None, description="Emoji or sticker name for express-only decisions")
    react_context_msg_id: str | None = Field(default=None, description="Target message contextMsgId for react-only")
    input_tokens: int = Field(default=0, description="LLM1 input tokens used")
    output_tokens: int = Field(default=0, description="LLM1 output tokens used")
