"""Dashboard API for Everything Nothing.

Mounted by the backend at ``/api/plugins/everything-nothing/``. The desktop half
reaches it through ``ctx.rest`` (profile-routed, authenticated).

This router and the hooks in ``__init__.py`` can live in different
processes: a gateway serving several profiles runs a secondary profile's
plugin API in that profile's plugin host, while the profile's turns (and
their hooks) run in the gateway. So the endpoints read and write
``store.py``'s SQLite file, never the hook module's memory. The host imports
this file by path with no package, so ``store.py`` is loaded by path too.
"""


import hashlib
import importlib.util
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, StrictBool, StrictInt

router = APIRouter()


def _store():
    path = Path(__file__).resolve().parents[1] / "store.py"
    name = "everything_nothing_store_" + hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:12]
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules[name] = module
    return module


# Plain ``def`` handlers: SQLite is blocking I/O, so FastAPI runs them in a
# worker thread instead of on the event loop.


@router.get("/suggestion")
def get_suggestion(session_id: str = Query("")):
    """The session's pending suggestion, or, when the last attempt failed,
    the failure kind so the UI can say why."""
    return _store().get(session_id)


@router.post("/dismiss")
def dismiss_suggestion(session_id: str = Query("")):
    if session_id:
        _store().clear(session_id)
    return {"ok": True}


def _runtime():
    from hermes_cli.plugins import discover_plugins, get_plugin_manager

    discover_plugins()
    loaded = get_plugin_manager()._plugins.get("everything-nothing")
    module = getattr(loaded, "module", None)
    if module is None or not hasattr(module, "_suggest"):
        raise HTTPException(503, "Reload Hermes to activate Everything Nothing.")
    return module


def _profile():
    from hermes_constants import get_hermes_home, profile_name_for_home

    return profile_name_for_home(get_hermes_home()) or "default"


def _check_profile(profile):
    if profile != _profile():
        raise HTTPException(409, "The active Hermes profile changed. Reopen the panel.")


@router.get("/settings")
def get_settings():
    from hermes_cli.config import load_config_readonly

    cfg = load_config_readonly()
    route = (cfg.get("auxiliary") or {}).get("next_prompt") or {}
    main = cfg.get("model") or {}
    if isinstance(main, str):
        main = {"default": main}
    return {
        "profile": _profile(),
        "settings": _runtime()._get_settings(),
        "model": route.get("model") or main.get("default") or main.get("model"),
        "provider": route.get("provider") or "auto",
    }


def _github_get(endpoint: str):
    import httpx
    from hermes_cli.github_api import github_token_from_env

    token = github_token_from_env()
    if not token:
        # Probe the same host on every manual check so a fresh login works
        # without restarting Hermes or accidentally using an Enterprise token.
        try:
            credential = subprocess.run(
                ["gh", "auth", "token", "--hostname", "github.com"], timeout=3,
                stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False,
            )
            if credential.returncode == 0:
                token = credential.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    if not token:
        raise HTTPException(409, "Connect GitHub on this Hermes gateway first.")
    try:
        response = httpx.get(
            f"https://api.github.com/{endpoint}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
            timeout=5, follow_redirects=False,
        )
    except httpx.RequestError:
        raise HTTPException(502, "GitHub is temporarily unreachable.") from None
    if response.status_code == 401:
        raise HTTPException(409, "Reconnect GitHub on this Hermes gateway.")
    if response.status_code == 404:
        raise HTTPException(404, "GitHub could not find a release accessible to this account.")
    if response.status_code != 200:
        raise HTTPException(502, "GitHub could not verify the request.")
    return response.json()


@router.get("/github/connection")
def github_connection():
    user = _github_get("user")
    if not isinstance(user.get("login"), str):
        raise HTTPException(502, "GitHub did not confirm the connection.")
    return {"connected": True}


class ReleaseLookup(BaseModel):
    owner: str
    repo: str
    tag: str


_RELEASE_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")
_VERSION = re.compile(r"v?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.+-]+)?")


@router.post("/github/release")
def github_release(request: ReleaseLookup):
    if not all(_RELEASE_SEGMENT.fullmatch(value) for value in (request.owner, request.repo)):
        raise HTTPException(422, "Enter a GitHub owner and repository.")
    if len(request.tag) > 80 or not _VERSION.fullmatch(request.tag):
        raise HTTPException(422, "Enter a release version tag.")
    release = _github_get(f"repos/{request.owner}/{request.repo}/releases/tags/{quote(request.tag, safe='')}")
    if release.get("tag_name") != request.tag or release.get("draft") is not False or not release.get("published_at"):
        raise HTTPException(404, "GitHub has no published release for this version.")
    return {
        "tag": request.tag,
        "title": str(release.get("name") or request.tag)[:200],
        "published_at": release["published_at"],
        "prerelease": release.get("prerelease") is True,
        "url": f"https://github.com/{request.owner}/{request.repo}/releases/tag/{quote(request.tag, safe='')}",
    }


@router.get("/performance")
def get_performance():
    from hermes_cli.config import load_config_readonly

    config = load_config_readonly()
    compression = config.get("compression") or {}
    return {
        "profile": _profile(),
        "enabled": compression.get("enabled", True),
        "prune_at": compression.get("proactive_prune_tokens", 0),
        "protected_user_messages": compression.get("min_tail_user_messages", 1),
        "compaction": _runtime().store.compaction_totals(),
    }


class SettingChange(BaseModel):
    profile: str
    key: str
    value: StrictBool | StrictInt | str


_CONCISION_CHOICES = ("Off", "Light", "Terse", "Fluff Eater")


@router.put("/settings")
def put_setting(change: SettingChange):
    from hermes_cli.plugins_state import save_plugin_setting

    _check_profile(change.profile)
    limits = {"max_context_messages": (2, 10), "cooldown_seconds": (0, 120)}
    flags = {"enabled", "local_fallback", "offer_follow_up_options", "local_explicit_choices"}
    key, value = change.key, change.value
    if key in flags:
        valid = type(value) is bool
    elif key in limits:
        low, high = limits[key]
        valid = type(value) is int and low <= value <= high
    elif key == "response_concision":
        valid = value in _CONCISION_CHOICES
    else:
        valid = False
    if not valid:
        raise HTTPException(422, "Invalid Everything Nothing setting.")
    try:
        save_plugin_setting("everything-nothing", (key,), value)
    except PermissionError:
        raise HTTPException(403, "Hermes manages this setting.") from None
    return get_settings()


class SuggestionTest(BaseModel):
    profile: str
    force_fallback: StrictBool = False


@router.post("/test-suggestion")
def test_suggestion(request: SuggestionTest):
    _check_profile(request.profile)
    runtime = _runtime()
    messages = [
        {"role": "user", "content": "Help me choose a drink for a short break."},
        {"role": "assistant", "content": "Would you prefer tea or coffee?"},
    ]
    start = time.perf_counter()
    result = runtime._suggest(messages, runtime._get_settings(), force_fallback=request.force_fallback, test_model=True)
    return {**result, "latency_ms": round((time.perf_counter() - start) * 1000, 2)}
