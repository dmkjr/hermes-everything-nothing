"""Exercise completion hooks with the empty ranking observed from the local model."""

from test_backend import FakeLLM, PluginTestCase, wait_for


HISTORY = [
    {"role": "user", "content": "Briefly explain how a DNS cache's TTL works."},
    {"role": "assistant", "content": (
        "A DNS cache stores name-to-IP answers until their TTL expires. The TTL counts down "
        "in seconds, and after expiration the resolver fetches a fresh answer. A lower TTL "
        "makes changes visible sooner but increases upstream queries."
    )},
]


class ExplanationFollowupTests(PluginTestCase):
    def test_abstaining_model_still_offers_safe_enabled_followups(self):
        llm = FakeLLM(text="[]")
        module, ctx = self.start(llm)
        self.turn_done(ctx, "explanation", history=HISTORY)
        self.assertTrue(wait_for(lambda: self.has("explanation")))
        suggestion = self.suggestion("explanation")
        options = [suggestion["text"], *suggestion["alternatives"]]
        self.assertEqual(len(options), 3)
        self.assertEqual(options[0], "Can you show me an example?")
        self.assertTrue(all(option.endswith("?") for option in options))
        self.assertEqual(len(llm.calls), 1)

    def test_disabling_followups_or_fallback_keeps_abstention_empty(self):
        for key in ("offer_follow_up_options", "local_fallback"):
            with self.subTest(key=key):
                module, _ = self.start(FakeLLM(text="[]"), settings={key: False})
                self.assertEqual(module._suggest(HISTORY, module._get_settings())["options"], [])

    def test_explicit_no_followups_is_respected_even_with_model_ranking(self):
        module, _ = self.start(FakeLLM(text="[3, 4]"))
        history = [{"role": "user", "content": "Explain DNS, but do not offer follow-up suggestions."}, HISTORY[1]]
        self.assertEqual(module._suggest(history, module._get_settings())["options"], [])

    def test_short_acknowledgment_does_not_get_fallback_questions(self):
        module, _ = self.start(FakeLLM(text="[]"))
        history = [HISTORY[0], {"role": "assistant", "content": "Done."}]
        self.assertEqual(module._suggest(history, module._get_settings())["options"], [])

    def test_valid_model_ranking_still_takes_priority(self):
        module, _ = self.start(FakeLLM(text="[4, 3, 5]"))
        result = module._suggest(HISTORY, module._get_settings())
        self.assertEqual(result["source"], "model")
        self.assertEqual(result["options"][0], "How can I verify that?")
