"""Exercise the adapter at the actual host request/retry-policy seam."""
import importlib.util
import types
import unittest
from collections import namedtuple
from pathlib import Path

spec = importlib.util.spec_from_file_location('en_latency_test', Path(__file__).resolve().parents[1] / 'latency.py')
latency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latency)
Request = namedtuple('Request', 'final_model request_provider base_info kwargs')


class LatencyTests(unittest.TestCase):
    def host(self, provider='splash-m5-38', model='qwen3.8-flash-next-splash', body=None):
        self.request = Request(model, provider, 'http://127.0.0.1:11502/v1/', {'messages': ['keep'], 'extra_body': body})
        return types.SimpleNamespace(_prepare_aux_request=lambda *a, **k: self.request,
                                     _should_skip_same_provider_retry=lambda *a: False)

    def failure(self, transport='timeout', error='Request timed out'):
        return types.SimpleNamespace(verdict=types.SimpleNamespace(error_context={'transport': transport}), error=Exception(error))

    def test_our_local_request_gets_priority_without_mutating_routing_or_input(self):
        host = self.host(body={'reasoning': {'effort': 'none'}})
        cleanup = latency.install(host)
        result = host._prepare_aux_request('next_prompt')
        self.assertEqual(result.kwargs['extra_body']['priority'], 'foreground')
        self.assertEqual(result.kwargs['messages'], ['keep'])
        self.assertNotIn('priority', self.request.kwargs['extra_body'])
        self.assertEqual(result.final_model, self.request.final_model)
        self.assertIs(host._prepare_aux_request('compression'), self.request)
        cleanup()

    def test_cloud_routes_and_explicit_priority_are_preserved(self):
        for provider, model in [('openai', 'gpt-model'), ('custom', 'other-model')]:
            host = self.host(provider, model)
            cleanup = latency.install(host)
            self.assertIs(host._prepare_aux_request('next_prompt'), self.request)
            cleanup()
        host = self.host(body={'priority': 'background'})
        cleanup = latency.install(host)
        self.assertEqual(host._prepare_aux_request('next_prompt').kwargs['extra_body']['priority'], 'background')
        cleanup()

    def test_only_our_full_timeout_skips_retries_fast_blips_and_other_tasks_unchanged(self):
        host = self.host()
        cleanup = latency.install(host)
        self.assertTrue(host._should_skip_same_provider_retry('next_prompt', self.failure()))
        self.assertFalse(host._should_skip_same_provider_retry('compression', self.failure()))
        self.assertFalse(host._should_skip_same_provider_retry('next_prompt', self.failure('connection_reset')))
        self.assertFalse(host._should_skip_same_provider_retry('next_prompt', self.failure(error='no-progress timeout')))
        cleanup()

    def test_multi_profile_reload_is_reference_counted_and_unload_restores_host(self):
        host = self.host()
        original = host._prepare_aux_request
        first = latency.install(host)
        wrapped = host._prepare_aux_request
        second = latency.install(host)
        self.assertIs(host._prepare_aux_request, wrapped)
        first()
        self.assertTrue(host._should_skip_same_provider_retry('next_prompt', self.failure()))
        second()
        self.assertIs(host._prepare_aux_request, original)
        self.assertFalse(host._should_skip_same_provider_retry('next_prompt', self.failure()))

    def test_unsupported_host_keeps_existing_behavior(self):
        host = types.SimpleNamespace()
        self.assertIsNone(latency.install(host))
        self.assertEqual(vars(host), {})
