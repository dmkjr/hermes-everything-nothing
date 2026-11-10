"""Everything Nothing reply style for interactive Hermes chats."""

_CONCISION = {
    "Light": "Lead with the answer. Remove filler, repeated points, and ceremonial intros. Use normal sentences.",
    "Terse": "Use short, direct sentences or bullets. Omit routine process detail and repeated conclusions.",
    "Fluff Eater": "Use compact phrases and familiar abbreviations. Drop filler and optional articles wherever clarity survives.",
}
_CONCISION_GUARD = (
    "Keep every material fact, caveat, and requested detail. Preserve code, commands, quotations, "
    "and error strings exactly. Use full language for warnings, approvals, and complex steps. "
    "An explicit user request for a different style or level of detail takes precedence."
)


def register(ctx):
    def apply_concision(**turn):
        if not turn.get("session_id") or turn.get("parent_session_id"):
            return None
        if turn.get("platform") not in ("", "desktop", "tui"):
            return None
        level = ctx.get_config("response_concision", "Off")
        guidance = _CONCISION.get(level) if isinstance(level, str) else None
        if guidance:
            return {"context": f"Everything Nothing reply style: {guidance} {_CONCISION_GUARD}"}
        return None

    ctx.register_hook("pre_llm_call", apply_concision)
