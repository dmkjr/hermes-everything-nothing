"""Narrow, unloadable compatibility adapter for latency-sensitive plugin calls.

Hermes' plugin facade currently has no per-call priority/retry-policy arguments.
Keep host credentials/routing/transport intact; adapt only our registered task.
Unknown host shapes retain their existing behavior. No host files are patched.
"""
from functools import wraps
from urllib.parse import urlsplit

_STATE = "_en_next_prompt_latency_v1"


def install(host, task="next_prompt"):
    prepare = getattr(host, "_prepare_aux_request", None)
    skip = getattr(host, "_should_skip_same_provider_retry", None)
    if not callable(prepare) or not callable(skip):
        return None
    state = getattr(host, _STATE, None)
    owner = object()
    if state is None:
        state = {"owners": set(), "task": task, "prepare": prepare, "skip": skip}

        @wraps(prepare)
        def prioritized(*args, **kwargs):
            request = prepare(*args, **kwargs)
            called_task = args[0] if args else kwargs.get("task")
            if not state["owners"] or called_task != state["task"]:
                return request
            model = str(getattr(request, "final_model", "") or "").lower()
            provider = str(getattr(request, "request_provider", "") or "").lower()
            base = str(getattr(request, "base_info", "") or "")
            # Splash supports this scheduling hint. Do not send vendor-specific
            # fields to cloud models or an arbitrary OpenAI-compatible endpoint.
            if ("splash" not in provider or "splash" not in model
                    or urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}
                    or not callable(getattr(request, "_replace", None))):
                return request
            raw_params = getattr(request, "kwargs", None)
            if not isinstance(raw_params, dict):
                return request
            params = dict(raw_params)
            body = dict(params.get("extra_body") or {})
            body.setdefault("priority", "foreground")  # explicit user setting wins
            params["extra_body"] = body
            return request._replace(kwargs=params)

        @wraps(skip)
        def no_timeout_replay(task, failure):
            if state["owners"] and task == state["task"]:
                context = getattr(getattr(failure, "verdict", None), "error_context", {}) or {}
                if context.get("transport") == "timeout" and "no-progress timeout" not in str(failure.error):
                    return True
            return skip(task, failure)

        state.update(priority_wrapper=prioritized, retry_wrapper=no_timeout_replay)
        setattr(host, _STATE, state)
        host._prepare_aux_request = prioritized
        host._should_skip_same_provider_retry = no_timeout_replay
    state["owners"].add(owner)

    def cleanup():
        state["owners"].discard(owner)
        if state["owners"]:
            return
        if host._prepare_aux_request is state["priority_wrapper"]:
            host._prepare_aux_request = state["prepare"]
        if host._should_skip_same_provider_retry is state["retry_wrapper"]:
            host._should_skip_same_provider_retry = state["skip"]
        if getattr(host, _STATE, None) is state:
            delattr(host, _STATE)
    return cleanup
