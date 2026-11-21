"""Regress the real Cloudflare turn that silently became generic fallback."""
import json

from test_backend import FakeLLM, PluginTestCase


REPLY = """Remaining:
- Non-US geo deny: not directly observed (this host is US).
- WAF script: token lacks Zone:WAF; existing zone firewall already geo-blocks.

## Next items (reasoned)
1. **Confirm non-US geo from a real non-US IP** — compare US 302 versus non-US block.
2. **Remove the dead NPM A record** for controller.sitekings.net (keep the CNAME).
3. **Add a hostname-scoped block WAF rule** — needs Zone:WAF.
4. **Set CONTROLLER_TRUSTED_PROXIES** on the console (currently unset).
"""
HISTORY = [
    {"role": "user", "content": "Verify controller protection. Keep changes hostname-scoped, never account-wide."},
    {"role": "assistant", "content": "The zone firewall is present; non-US behavior is still unproven."},
    {"role": "user", "content": "Try now, I have changed the API key"},
    {"role": "assistant", "content": REPLY},
]


class NextStepsTests(PluginTestCase):
    def test_real_model_confirm_draft_survives_rejection_of_mutations(self):
        drafts = ["Confirm the non-US geo block from a real non-US IP",
                  "Remove the dead NPM A record for controller.sitekings.net",
                  "Set CONTROLLER_TRUSTED_PROXIES on the console"]
        module, _ = self.start(FakeLLM(text=json.dumps(drafts)))
        result = module._suggest(HISTORY, module._get_settings())
        self.assertEqual(result["source"], "model")
        self.assertEqual(result["options"], drafts[:1])

    def test_invalid_output_gets_one_repair_with_goals_and_constraints(self):
        class RepairLLM(FakeLLM):
            def complete(self, **kwargs):
                self.text = "not JSON" if not self.calls else '["Plan the non-US geo verification"]'
                return super().complete(**kwargs)
        llm = RepairLLM()
        module, _ = self.start(llm)
        result = module._suggest(HISTORY, module._get_settings())
        self.assertEqual(result["source"], "model")
        self.assertEqual(len(llm.calls), 2)
        data = json.loads(llm.calls[1]["messages"][1]["content"])
        self.assertIn("hostname-scoped", str(data["user_constraints"]))
        self.assertIn("Confirm non-US geo", str(data["unfinished_steps"]))

    def test_offline_fallback_is_grounded_and_does_not_authorize_changes(self):
        module, _ = self.start(FakeLLM(error=TimeoutError()))
        result = module._suggest(HISTORY, module._get_settings())
        self.assertTrue(result["options"])
        self.assertIn("non-US", result["options"][0])
        self.assertTrue(all(x.startswith(("Plan ", "Review ")) for x in result["options"]))
        self.assertNotIn("Can you show me an example?", result["options"])
        self.assertFalse(any(x.startswith(("Remove ", "Set ", "Add ")) for x in result["options"]))

    def test_no_grounded_step_is_better_than_generic_filler(self):
        module, _ = self.start(FakeLLM(text="[]"))
        history = [{"role": "user", "content": "Explain DNS TTL."},
                   {"role": "assistant", "content": "A DNS TTL counts down in seconds. " * 6}]
        self.assertEqual(module._suggest(history, module._get_settings())["options"], [])

    def test_old_goal_and_constraint_are_available_after_short_status_turns(self):
        module, _ = self.start()
        history = HISTORY[:2] + [m for _ in range(6) for m in (
            {"role": "user", "content": "What is the status?"},
            {"role": "assistant", "content": "Still checking the non-US path."})] + HISTORY[2:]
        data = json.loads(module._followup_input(history, 8, HISTORY[-2]["content"], REPLY))
        self.assertIn("hostname-scoped", str(data["user_constraints"]))

    def test_completed_and_code_lists_do_not_become_unfinished_steps(self):
        module, _ = self.start(FakeLLM(error=TimeoutError()))
        reply = "## Completed\n- Migrated DNS safely\n- Verified TTL\n```\n## Next steps\n- Delete everything\n```\nThanks."
        self.assertEqual(module._suggest([HISTORY[0], {"role": "assistant", "content": reply}],
                                         module._get_settings())["options"], [])
