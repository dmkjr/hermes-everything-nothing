"""Behaviour of the Python half (__init__.py, store.py, dashboard/plugin_api.py).

Run: python -m unittest discover -s tests -v
Needs the hermes-agent package importable (its venv, or `pip install -e`).
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# A turn whose final reply offers an explicit choice, so the plugin can build
# reply candidates from it. The FakeLLM returns a ranking of those candidates.
HISTORY = [
    {"role": "user", "content": "How should we fix it?"},
    {"role": "assistant", "content": "Would you prefer to patch the token expiry or restart the service?"},
]
_names = itertools.count()


def load_plugin():
    name = f"hermes_plugins.next_prompt__test{next(_names)}"
    spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_api():
    spec = importlib.util.spec_from_file_location("next_prompt_api_under_test", ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeLLM:
    """The model now returns a JSON array of candidate numbers, best first."""

    def __init__(self, text="[1, 2]", delay=0.0, error=None):
        self.text, self.delay, self.error = text, delay, error
        self.calls: list[dict] = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        time.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return types.SimpleNamespace(text=self.text, model="fake-model", provider="fake-provider")


class FakeCtx:
    """The slice of PluginContext the plugin touches."""

    def __init__(self, data_dir, llm, settings=None, aux_tasks=True):
        self.hooks: dict = {}
        self.llm = llm
        self.settings = settings or {}
        self.state = types.SimpleNamespace(data_dir=data_dir)
        self.aux_tasks: list = []
        if aux_tasks:
            self.register_auxiliary_task = lambda key, **kw: self.aux_tasks.append((key, kw))

    def register_hook(self, name, fn):
        self.hooks[name] = fn


def wait_for(predicate, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class PluginTestCase(unittest.TestCase):
    """Each test gets its own Hermes home (the store lives under it) and its
    own ``ctx.state.data_dir`` (where 0.3.0 kept ``suggestions.json``)."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="next-prompt-home-"))
        self.data_dir = Path(tempfile.mkdtemp(prefix="next-prompt-state-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.data_dir, ignore_errors=True)
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self.home)
        self.addCleanup(self._restore_home, previous)
        self.modules = []
        self.addCleanup(self._unload)
        module = load_plugin()
        self.modules.append(module)
        self.store = module.store  # the module object every load of this tree shares

    @staticmethod
    def _restore_home(previous):
        if previous is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = previous

    def _unload(self):
        # Let workers finish before the temp dirs go away.
        for thread in threading.enumerate():
            if thread.name.startswith("everything-nothing") and thread is not threading.current_thread():
                thread.join(timeout=5)
        for module in self.modules:
            sys.modules.pop(module.__name__, None)

    def start(self, llm=None, **ctx_kwargs):
        module = load_plugin()
        self.modules.append(module)
        ctx = FakeCtx(self.data_dir, llm or FakeLLM(), **ctx_kwargs)
        module.register(ctx)
        return module, ctx

    def db_path(self):
        return self.home / "plugin-data" / "everything-nothing" / "suggestions.db"

    def suggestion(self, session_id):
        return self.store.get(session_id)["suggestion"]

    def has(self, session_id):
        return self.suggestion(session_id) is not None

    def failed(self, session_id):
        return dict(self.store.get(session_id)["error"] or {})

    @staticmethod
    def turn_done(ctx, session_id, platform="desktop", history=HISTORY, **extra):
        ctx.hooks["post_llm_call"](session_id=session_id, platform=platform, conversation_history=history, **extra)


class GenerationTests(PluginTestCase):
    def test_registers_both_hooks_and_its_aux_task(self):
        module, ctx = self.start()
        self.assertIn("pre_llm_call", ctx.hooks)
        self.assertIn("post_llm_call", ctx.hooks)
        self.assertEqual([key for key, _ in ctx.aux_tasks], ["next_prompt"])

    def test_generates_and_persists(self):
        module, ctx = self.start()
        self.turn_done(ctx, "s1")
        self.assertTrue(wait_for(lambda: self.has("s1")))
        suggestion = self.suggestion("s1")
        self.assertTrue(suggestion["text"].startswith("I’d choose “"))
        self.assertEqual(suggestion["alternatives"][0], "I’d choose “restart the service”.")
        self.assertTrue(self.db_path().is_file())

    def test_choice_suggestion_is_stored_with_alternatives(self):
        module, ctx = self.start()
        self.turn_done(ctx, "s1")
        self.assertTrue(wait_for(lambda: self.has("s1")))
        self.assertEqual(self.suggestion("s1")["text"], "I’d choose “to patch the token expiry”.")

    def test_calls_the_llm_on_its_own_aux_task(self):
        llm = FakeLLM()
        module, ctx = self.start(llm)
        self.turn_done(ctx, "s1")
        self.assertTrue(wait_for(lambda: llm.calls))
        call = llm.calls[0]
        self.assertEqual(call["task"], "next_prompt")
        self.assertTrue(call["purpose"])
        self.assertEqual(call["messages"][0]["role"], "system")

    def test_older_host_without_aux_tasks_uses_a_plain_call(self):
        llm = FakeLLM()
        module, ctx = self.start(llm, aux_tasks=False)
        self.turn_done(ctx, "s1")
        self.assertTrue(wait_for(lambda: llm.calls))
        self.assertNotIn("task", llm.calls[0])

    def test_survives_a_backend_restart(self):
        module, ctx = self.start()
        self.turn_done(ctx, "s1")
        self.assertTrue(wait_for(lambda: self.has("s1")))
        text = self.suggestion("s1")["text"]
        self._unload()
        restarted, _ = self.start(FakeLLM(text="[2, 1]"))
        self.assertEqual(restarted.store.get("s1")["suggestion"]["text"], text)

    def test_own_message_clears_it(self):
        module, ctx = self.start()
        self.turn_done(ctx, "s1")
        self.assertTrue(wait_for(lambda: self.has("s1")))
        ctx.hooks["pre_llm_call"](session_id="s1", platform="desktop", user_message="otra cosa")
        self.assertFalse(self.has("s1"))

    def test_late_answer_for_an_old_turn_is_discarded(self):
        llm = FakeLLM(delay=0.4)
        module, ctx = self.start(llm)
        self.turn_done(ctx, "s2")
        time.sleep(0.05)
        ctx.hooks["pre_llm_call"](session_id="s2", platform="desktop")
        self.assertTrue(wait_for(lambda: llm.calls))
        time.sleep(0.6)
        self.assertFalse(self.has("s2"))

    def test_messaging_platforms_never_spend_a_call(self):
        llm = FakeLLM()
        module, ctx = self.start(llm)
        for platform in ("telegram", "discord", "cron"):
            self.turn_done(ctx, f"s-{platform}", platform=platform)
        time.sleep(0.3)
        self.assertEqual(llm.calls, [])

    def test_disabled_setting_never_spends_a_call(self):
        llm = FakeLLM()
        module, ctx = self.start(llm, settings={"enabled": False})
        self.turn_done(ctx, "s1")
        time.sleep(0.3)
        self.assertEqual(llm.calls, [])

    def test_no_useful_ranking_shows_nothing_and_clears_the_old_one(self):
        # No explicit choices and an empty ranking store nothing.
        module, ctx = self.start(FakeLLM(text="[]"))
        self.store.put_suggestion("s3", "x")
        self.turn_done(ctx, "s3", history=[
            {"role": "user", "content": "listo"},
            {"role": "assistant", "content": "Terminado."},
        ])
        self.assertTrue(wait_for(lambda: not self.has("s3")))

    def test_hooks_tolerate_unknown_kwargs(self):
        module, ctx = self.start()
        self.turn_done(ctx, "s1", some_future_field=1, model="m", turn_id="t")
        ctx.hooks["pre_llm_call"](session_id="s9", another_future_field=True)

    def test_suggestions_expire_after_a_week(self):
        self.start()
        self.store.put_suggestion("old", "viejo")
        with sqlite3.connect(self.db_path()) as conn:
            conn.execute("UPDATE pending SET timestamp = ? WHERE session_id = 'old'", (time.time() - 8 * 24 * 3600,))
        self.assertFalse(self.has("old"))


class LegacyStoreTests(PluginTestCase):
    """0.3.0 kept pending suggestions in ``ctx.state.data_dir/suggestions.json``."""

    def write_legacy(self, entries):
        (self.data_dir / "suggestions.json").write_text(json.dumps(entries), encoding="utf-8")

    def test_pending_suggestions_move_to_the_store_once(self):
        now = time.time()
        self.write_legacy({
            "s1": {"text": "Sigue con el deploy", "session_id": "s1", "timestamp": now},
            "old": {"text": "viejo", "session_id": "old", "timestamp": now - 8 * 24 * 3600},
        })
        self.start()
        self.assertEqual(self.suggestion("s1")["text"], "Sigue con el deploy")
        self.assertFalse(self.has("old"))
        self.assertFalse((self.data_dir / "suggestions.json").exists())
        self.assertTrue((self.data_dir / "suggestions.json.migrated").exists())

    def test_a_dismissed_suggestion_does_not_come_back_after_a_restart(self):
        self.write_legacy({"s1": {"text": "x", "session_id": "s1", "timestamp": time.time()}})
        self.start()
        self.store.clear("s1")
        self._unload()
        self.start()
        self.assertFalse(self.has("s1"))

    def test_unreadable_legacy_file_is_set_aside(self):
        (self.data_dir / "suggestions.json").write_text("{not json", encoding="utf-8")
        self.start()
        self.assertTrue((self.data_dir / "suggestions.json.migrated").exists())


class ContextAndCleanTests(unittest.TestCase):
    """The prompt input and the output filter, without any LLM."""

    @classmethod
    def setUpClass(cls):
        cls.m = load_plugin()

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop(cls.m.__name__, None)

    def test_tool_heavy_turn_keeps_the_request_and_the_final_reply(self):
        history = [
            {"role": "user", "content": "Arregla el bug del login"},
            {"role": "assistant", "content": "Voy a revisar los logs.", "tool_calls": [{"id": "1"}]},
            {"role": "tool", "content": "x" * 5000, "tool_call_id": "1"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "2"}]},
            {"role": "tool", "content": "y" * 5000, "tool_call_id": "2"},
            {"role": "assistant", "content": "Listo: el token expiraba antes de tiempo. Lo corregí en auth.py."},
        ]
        context = self.m._build_context(history, 4)
        self.assertIn("[User]: Arregla el bug del login", context)
        self.assertIn("[Agent]: Listo: el token expiraba", context)
        self.assertNotIn("Voy a revisar los logs", context, "narration between tool calls is dropped")
        self.assertNotIn("xxxx", context, "tool output never reaches the prompt")

    def test_keeps_the_last_exchanges_only(self):
        history = []
        for i in range(5):
            history += [{"role": "user", "content": f"pregunta {i}"}, {"role": "assistant", "content": f"respuesta {i}"}]
        context = self.m._build_context(history, 4)
        self.assertNotIn("pregunta 2", context)
        self.assertIn("pregunta 3", context)
        self.assertTrue(context.endswith("[Agent]: respuesta 4"))

    def test_long_reply_keeps_its_ending(self):
        reply = "inicio " + "relleno " * 400 + "¿Quieres que lo despliegue?"
        context = self.m._build_context([{"role": "user", "content": "hazlo"}, {"role": "assistant", "content": reply}], 4)
        self.assertIn("¿Quieres que lo despliegue?", context)
        self.assertIn("inicio", context)
        self.assertLess(len(context), 1400)

    def test_multimodal_content_is_reduced_to_text(self):
        history = [
            {"role": "user", "content": [{"type": "text", "text": "mira esta imagen"}, {"type": "image_url", "image_url": {"url": "data:x"}}]},
            {"role": "assistant", "content": "Es un gato."},
        ]
        self.assertIn("[User]: mira esta imagen", self.m._build_context(history, 4))

    def test_choice_candidates_build_committed_replies(self):
        reply = "Would you prefer to patch the token expiry or restart the service?"
        options = self.m._choice_candidates(reply)
        self.assertEqual(options, [
            "I’d choose “to patch the token expiry”.",
            "I’d choose “restart the service”.",
        ])

    def test_choice_candidates_from_a_list(self):
        reply = "Which option do you want?\n- Ship today\n- Ship tomorrow\n- Hold"
        options = self.m._choice_candidates(reply)
        self.assertEqual(len(options), 3)
        self.assertTrue(all(o.startswith("I’d choose “") for o in options))

    def test_no_choice_returns_no_candidates(self):
        self.assertEqual(self.m._choice_candidates("Everything is done."), [])
        # more than four options are too many to rank safely
        self.assertEqual(self.m._choice_candidates(
            "Choose:\n- A\n- B\n- C\n- D\n- E"), [])

    def test_ranked_candidates_maps_numbers_to_text(self):
        candidates = ["one", "two", "three"]
        self.assertEqual(self.m._ranked_candidates("[2, 1]", candidates), ["two", "one"])
        self.assertEqual(self.m._ranked_candidates("[]", candidates), [])

    def test_ranked_candidates_rejects_bad_output(self):
        # not JSON, out of range, or non-integer -> None (fall back)
        self.assertIsNone(self.m._ranked_candidates("yes, the first one", ["a", "b"]))
        self.assertIsNone(self.m._ranked_candidates("[3]", ["a", "b"]))
        self.assertIsNone(self.m._ranked_candidates("[1.5]", ["a", "b"]))


class AuthError(Exception):
    """Shaped like anthropic/openai AuthenticationError."""

    status_code = 401


class RateLimitError(Exception):
    status_code = 429


class ReadTimeout(Exception):
    pass


class FailureTests(PluginTestCase):
    # A turn with no explicit choices and no trailing question, so a model
    # failure leaves no usable fallback and is reported as a failure.
    NO_CHOICE = [
        {"role": "user", "content": "Done?"},
        {"role": "assistant", "content": "All finished."},
    ]

    def test_failure_kinds(self):
        cases = [
            (AuthError("revoked"), "auth"),
            (RateLimitError("slow down"), "rate_limit"),
            (ReadTimeout("late"), "timeout"),
            (RuntimeError("boom"), "other"),
        ]
        for error, kind in cases:
            with self.subTest(kind=kind):
                session_id = f"s-{kind}"
                module, ctx = self.start(FakeLLM(error=error))
                self.turn_done(ctx, session_id, history=self.NO_CHOICE)
                self.assertTrue(wait_for(lambda: self.failed(session_id)))
                self.assertEqual(self.failed(session_id)["kind"], kind)

    def test_failure_detail_never_leaks(self):
        module, ctx = self.start(FakeLLM(error=AuthError("«redacted:sk-…»")))
        self.turn_done(ctx, "s1", history=self.NO_CHOICE)
        self.assertTrue(wait_for(lambda: self.failed("s1")))
        self.assertNotIn("sk-secret", json.dumps(self.failed("s1")))
        self.assertNotIn(b"sk-secret", self.db_path().read_bytes())

    def test_failure_note_expires_sooner_than_a_suggestion(self):
        self.start()
        self.store.put_failure("s1", "auth")
        with sqlite3.connect(self.db_path()) as conn:
            conn.execute("UPDATE pending SET timestamp = ? WHERE session_id = 's1'", (time.time() - 7 * 3600,))
        self.assertEqual(self.failed("s1"), {})

    def test_success_clears_the_failure(self):
        llm = FakeLLM(error=AuthError("x"))
        module, ctx = self.start(llm)
        self.turn_done(ctx, "s1", history=self.NO_CHOICE)
        self.assertTrue(wait_for(lambda: self.failed("s1")))
        llm.error = None
        llm.text = "[1]"
        module._last_suggestion_time.clear()
        self.turn_done(ctx, "s1", history=[
            {"role": "user", "content": "¿Qué hacemos?"},
            {"role": "assistant", "content": "Would you prefer to retry or roll back?"},
        ])
        self.assertTrue(wait_for(lambda: self.has("s1")))
        self.assertEqual(self.failed("s1"), {})

    def test_own_message_clears_the_failure(self):
        module, ctx = self.start(FakeLLM(error=AuthError("x")))
        self.turn_done(ctx, "s1", history=self.NO_CHOICE)
        self.assertTrue(wait_for(lambda: self.failed("s1")))
        ctx.hooks["pre_llm_call"](session_id="s1")
        self.assertEqual(self.failed("s1"), {})

    def test_failure_for_an_old_turn_is_discarded(self):
        llm = FakeLLM(error=AuthError("x"), delay=0.4)
        module, ctx = self.start(llm)
        self.turn_done(ctx, "s2", history=self.NO_CHOICE)
        time.sleep(0.05)
        ctx.hooks["pre_llm_call"](session_id="s2")
        self.assertTrue(wait_for(lambda: llm.calls))
        time.sleep(0.6)
        self.assertEqual(self.failed("s2"), {})


class RestApiTests(PluginTestCase):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(load_api().router, prefix="/api/plugins/everything-nothing")
        self.client = TestClient(app)

    def get(self, session_id):
        return self.client.get("/api/plugins/everything-nothing/suggestion", params={"session_id": session_id}).json()

    def test_get_and_dismiss(self):
        module, ctx = self.start(FakeLLM(text="[2, 1]"))
        self.turn_done(ctx, "s4")
        self.assertTrue(wait_for(lambda: self.has("s4")))
        self.assertTrue(self.get("s4")["suggestion"]["text"].startswith("I’d choose “"))
        self.client.post("/api/plugins/everything-nothing/dismiss", params={"session_id": "s4"})
        self.assertEqual(self.get("s4"), {"suggestion": None, "error": None})
        self.assertFalse(self.has("s4"))

    def test_failure_is_reported_and_dismissable(self):
        module, ctx = self.start(FakeLLM(error=AuthError("x")))
        self.turn_done(ctx, "s5", history=[
            {"role": "user", "content": "Done?"},
            {"role": "assistant", "content": "All finished."},
        ])
        self.assertTrue(wait_for(lambda: self.get("s5")["error"]))
        body = self.get("s5")
        self.assertIsNone(body["suggestion"])
        self.assertEqual(body["error"]["kind"], "auth")
        self.client.post("/api/plugins/everything-nothing/dismiss", params={"session_id": "s5"})
        self.assertEqual(self.get("s5"), {"suggestion": None, "error": None})

    def test_newer_suggestion_replaces_an_older_failure(self):
        self.start()
        self.store.put_failure("s6", "auth")
        self.store.put_suggestion("s6", "ok")
        body = self.get("s6")
        self.assertEqual(body["suggestion"]["text"], "ok")
        self.assertIsNone(body["error"])

    def test_missing_or_blank_session(self):
        self.assertEqual(self.get("missing"), {"suggestion": None, "error": None})
        self.assertEqual(self.get(""), {"suggestion": None, "error": None})

    def test_reads_a_suggestion_written_by_another_process(self):
        """The bug behind 0.3.1: on a gateway serving several profiles, a
        secondary profile's plugin API runs in its plugin host while its hooks
        run in the gateway. Write from a separate interpreter, read here."""
        script = textwrap.dedent(f"""
            import importlib.util, sys
            spec = importlib.util.spec_from_file_location("np_store_child", {str(ROOT / "store.py")!r})
            store = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(store)
            assert store.put_suggestion("s-cross", "Desde otro proceso") is not None
        """)
        # Same import path as this interpreter (hermes-agent, its dependencies).
        env = dict(os.environ, HERMES_HOME=str(self.home), PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
        subprocess.run([sys.executable, "-c", script], env=env, check=True, timeout=60)
        self.assertEqual(self.get("s-cross")["suggestion"]["text"], "Desde otro proceso")
        self.client.post("/api/plugins/everything-nothing/dismiss", params={"session_id": "s-cross"})
        self.assertFalse(self.has("s-cross"))


if __name__ == "__main__":
    unittest.main()
