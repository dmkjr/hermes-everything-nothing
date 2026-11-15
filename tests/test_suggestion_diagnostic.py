"""Test Suggestion must give the ranker evidence instead of inventing a preference."""

from unittest.mock import patch

from test_backend import FakeLLM, PluginTestCase, load_api


class SuggestionDiagnosticTests(PluginTestCase):
    def test_model_test_supplies_an_explicit_preference(self):
        llm = FakeLLM(text="[1, 2]")
        module, _ = self.start(llm)
        api = load_api()
        with patch.object(api, "_runtime", return_value=module):
            result = api.test_suggestion(api.SuggestionTest(profile="default"))
        self.assertEqual(result["source"], "model")
        self.assertEqual(result["options"][0], "I’d choose “tea”.")
        self.assertIn("I prefer tea over coffee.", llm.calls[0]["messages"][1]["content"])
        self.assertGreaterEqual(result["latency_ms"], 0)
        self.assertEqual(module.store.count(), 0)

    def test_forced_fallback_never_calls_model_or_writes_suggestions(self):
        llm = FakeLLM(error=AssertionError("Forced fallback called the model"))
        module, _ = self.start(llm)
        api = load_api()
        with patch.object(api, "_runtime", return_value=module):
            result = api.test_suggestion(api.SuggestionTest(profile="default", force_fallback=True))
        self.assertEqual(result["source"], "fallback")
        self.assertIsNone(result["model"])
        self.assertEqual(len(result["options"]), 2)
        self.assertEqual(llm.calls, [])
        self.assertEqual(module.store.count(), 0)
