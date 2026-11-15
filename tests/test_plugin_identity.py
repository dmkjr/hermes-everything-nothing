"""Keep the full desktop build compatible with existing installs and profiles."""

import unittest
from pathlib import Path

from utils import fast_safe_load


class PluginIdentityTests(unittest.TestCase):
    def test_display_rebranding_preserves_installed_runtime_identity(self):
        manifest = fast_safe_load((Path(__file__).resolve().parents[1] / "plugin.yaml").read_text())
        # Existing profiles enable next-prompt, store its namespaced settings,
        # and address /api/plugins/next-prompt. A name-only rebrand disables it.
        self.assertEqual(manifest["name"], "next-prompt",
                         "Changing the full-build ID requires a migration for existing profiles.")
