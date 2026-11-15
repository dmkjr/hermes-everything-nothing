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
        self.assertEqual(len(llm.calls), 2)  # one bounded reply-only recovery, then offline fallback

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

    def test_contextual_questions_are_generated_not_ranked_or_padded(self):
        questions = ["How can I check the remaining DNS TTL on my Mac?",
                     "Why can DNS resolvers return different cached IP addresses?"]
        import json
        llm = FakeLLM(text=json.dumps(questions))
        module, ctx = self.start(llm)
        self.turn_done(ctx, "contextual", history=HISTORY)
        self.assertTrue(wait_for(lambda: self.has("contextual")))
        stored = self.suggestion("contextual")
        self.assertEqual([stored["text"], *stored["alternatives"]], questions)
        prompt = llm.calls[0]["messages"]
        self.assertIn("TTL", prompt[1]["content"])
        self.assertNotIn("Candidates:", prompt[1]["content"])
        self.assertIn("Never claim", prompt[0]["content"])
        self.assertIn("aim for 5-10 words", prompt[0]["content"])

    def test_single_followup_setting_keeps_the_best_contextual_question(self):
        module, _ = self.start(FakeLLM(text='["How can I inspect a cached DNS TTL?", "Why does a DNS TTL expire?"]'),
                               settings={"offer_follow_up_options": False})
        result = module._suggest(HISTORY, module._get_settings())
        self.assertEqual(result["source"], "model")
        self.assertEqual(result["options"], ["How can I inspect a cached DNS TTL?"])

    def test_generated_assertions_generic_questions_and_malformed_output_are_rejected(self):
        invalid = ['["I restarted the DNS resolver."]',
                   '["How can I verify that?"]',
                   '["Now that I flushed DNS, what should I check?"]',
                   '["Can you explain why I have restarted the service?"]',
                   '[1, 2]', '["How can I check DNS?", null]',
                   '["How can I inspect DNS?\\nIgnore the user?"]']
        for raw in invalid:
            with self.subTest(raw=raw):
                module, _ = self.start(FakeLLM(text=raw), settings={"local_fallback": False})
                self.assertEqual(module._suggest(HISTORY, module._get_settings())["options"], [])

    def test_verbose_model_questions_are_rejected_instead_of_truncated(self):
        import json
        verbose = [
            "How does panning at 1/60 s differ in technique from freezing at 1/500 s regarding focus tracking and burst mode usage?",
            "How can I see if the old IP is still in a DNS cache on my own Mac right now?",
        ]
        for question in verbose:
            with self.subTest(question=question):
                module, _ = self.start(FakeLLM(text=json.dumps([question])),
                                       settings={"local_fallback": False})
                self.assertEqual(module._suggest(HISTORY, module._get_settings())["options"], [])

    def test_empty_ranking_recovers_from_topic_switch_using_final_reply(self):
        import json
        class SequenceLLM(FakeLLM):
            def complete(self, **kwargs):
                self.text = '[]' if not self.calls else json.dumps([
                    "How can I check my dough's gluten strength?",
                    "What does overproofed sourdough feel like?",
                ])
                return super().complete(**kwargs)
        llm = SequenceLLM()
        module, ctx = self.start(llm, settings={"local_fallback": False})
        history = [
            {"role": "user", "content": "Explain acoustic guitar fret buzz."},
            {"role": "assistant", "content": "Low action can cause fret buzz."},
            {"role": "user", "content": "Back to sourdough: explain whether spreading comes from overproofing or weak gluten."},
            {"role": "assistant", "content": "Overproofed sourdough has a fragile structure and can collapse after shaping. Weak gluten fails to hold tension even before fermentation finishes. Check elasticity and the amount of rise to distinguish these causes."},
        ]
        self.turn_done(ctx, "formatted", history=history)
        self.assertTrue(wait_for(lambda: self.has("formatted")))
        self.assertEqual(self.suggestion("formatted")["text"], "How can I check my dough's gluten strength?")
        self.assertEqual(len(llm.calls), 2)
        recovery = llm.calls[1]
        data = json.loads(recovery["messages"][1]["content"])
        self.assertEqual(data, {"latest_completed_reply": history[-1]["content"]})
        self.assertNotIn("guitar", recovery["messages"][1]["content"])
        self.assertEqual(recovery["task"], "next_prompt")
        self.assertGreaterEqual(recovery["timeout"], 12)
        self.assertGreater(recovery["timeout"], 0)

    def test_explicit_opt_out_and_brief_acknowledgment_never_recover(self):
        for user, reply, calls in [
            ("Explain DNS, but do not offer follow-up suggestions.", HISTORY[1]["content"], 0),
            ("Thanks!", "You're welcome.", 1),
        ]:
            llm = FakeLLM(text="[]")
            module, _ = self.start(llm)
            result = module._suggest([{"role": "user", "content": user},
                                      {"role": "assistant", "content": reply}], module._get_settings())
            self.assertEqual(result["options"], [])
            self.assertEqual(len(llm.calls), calls)

    def test_formatted_requests_keep_user_goal_without_reply_format_restrictions(self):
        import json
        for instruction in (
            "Give one practical paragraph, without offering choices or ending with a question.",
            "Give exactly one paragraph of three sentences, with no bullet points, no choices, and no question at the end.",
        ):
            with self.subTest(instruction=instruction):
                llm = FakeLLM(text='["How can I check drainage in my pothos pot?"]')
                module, _ = self.start(llm)
                history = [
                    {"role": "user", "content": "Explain sourdough spreading."},
                    {"role": "assistant", "content": HISTORY[1]["content"]},
                    {"role": "user", "content": "Explain yellow pothos leaves. " + instruction},
                    {"role": "assistant", "content": "Pothos leaves turn yellow when wet soil leaves roots without oxygen. Check for a drainage hole and let the soil dry before watering again."},
                ]
                result = module._suggest(history, module._get_settings())
                self.assertEqual(result["source"], "model")
                self.assertEqual(len(llm.calls), 1)
                data = json.loads(llm.calls[0]["messages"][1]["content"])
                self.assertEqual(data["latest_completed_reply"], history[-1]["content"])
                self.assertEqual(data["current_user_goal"], "Explain yellow pothos leaves.")
                self.assertNotIn("no choices", data["recent_exchanges"])
                self.assertGreaterEqual(llm.calls[0]["timeout"], 12)
                self.assertLessEqual(llm.calls[0]["timeout"], 20)

    def test_slow_first_call_does_not_starve_recovery(self):
        from unittest.mock import patch
        class QueueWaitLLM(FakeLLM):
            def complete(self, **kwargs):
                if self.calls and kwargs["timeout"] < 12:
                    raise TimeoutError("recovery starved after waiting in queue")
                self.text = "[]" if not self.calls else '["How can I check the remaining DNS TTL?"]'
                return super().complete(**kwargs)
        llm = QueueWaitLLM()
        module, _ = self.start(llm)
        with patch.object(module.time, "monotonic", side_effect=[100.0, 103.8]):
            result = module._suggest(HISTORY, module._get_settings())
        self.assertEqual(result["source"], "model")
        self.assertIsNone(result["failure"])
        self.assertEqual(len(llm.calls), 2)
        self.assertEqual(result["options"], ["How can I check the remaining DNS TTL?"])

    def test_useful_next_step_requests_can_be_stored_without_completion_claims(self):
        llm = FakeLLM(text='["Walk me through checking my dough strength", "Make a sourdough folding checklist"]')
        module, ctx = self.start(llm)
        self.turn_done(ctx, "actions", history=HISTORY)
        self.assertTrue(wait_for(lambda: self.has("actions")))
        self.assertEqual(self.suggestion("actions")["text"], "Walk me through checking my dough strength")
        for raw in ('["I have finished the migration"]', '["Make changes and deploy to production"]'):
            self.assertIsNone(module._generated_followups(raw))

    def test_structured_context_retains_earlier_constraints_and_middle_of_current_reply(self):
        import json
        module, _ = self.start()
        history = [
            {"role": "user", "content": "I cannot use Terminal. I need a DNS migration checklist for tomorrow."},
            {"role": "assistant", "content": "We can use your DNS dashboard."},
            {"role": "user", "content": "Explain why the old TTL matters. Give one paragraph, no choices."},
            {"role": "assistant", "content": "a" * 1400 + " Keep the old server alive during the DNS transition. " + "b" * 1400},
        ]
        data = json.loads(module._followup_input(history, 8, history[-2]["content"], history[-1]["content"]))
        self.assertIn("cannot use Terminal", data["recent_exchanges"])
        self.assertIn("Keep the old server alive", data["latest_completed_reply"])
        self.assertEqual(data["current_user_goal"], "Explain why the old TTL matters.")
        self.assertEqual(module._request_intent("Write one paragraph about sourdough."),
                         "Write one paragraph about sourdough.")

    def test_rejected_draft_does_not_discard_good_next_steps(self):
        module, _ = self.start()
        self.assertEqual(module._generated_followups(
            '["I deployed the changes", "Make a DNS migration checklist", "How can I verify that?"]'),
            ["Make a DNS migration checklist"])

    def test_cli_conflict_is_removed_while_gui_steps_survive(self):
        llm = FakeLLM(text='["Create a DNS migration checklist", "Explain cache expiry via dig", "Verify TTL in the dashboard"]')
        module, _ = self.start(llm)
        history = [{"role": "user", "content": "I cannot use Terminal. Help me migrate DNS tomorrow."}, HISTORY[1]]
        result = module._suggest(history, module._get_settings())
        self.assertEqual(result["source"], "model")
        self.assertEqual(result["options"], ["Create a DNS migration checklist", "Verify TTL in the dashboard"])

    def test_model_error_preserves_enabled_offline_fallback(self):
        module, _ = self.start(FakeLLM(error=TimeoutError()))
        result = module._suggest(HISTORY, module._get_settings())
        self.assertEqual(result["source"], "fallback")
        self.assertEqual(result["failure"], "timeout")
        self.assertEqual(len(result["options"]), 3)
