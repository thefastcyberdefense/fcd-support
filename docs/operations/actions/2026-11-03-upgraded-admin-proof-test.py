"""Synthetic credential-envelope guards only; no SSH, bootstrap or HTTP calls."""
import importlib.util
import json
from pathlib import Path
import unittest

path = Path(__file__).with_name('2026-11-03-upgraded-admin-proof.py')
module = None
if path.exists():
    spec = importlib.util.spec_from_file_location('upgraded_proof', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class CredentialsTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module)
        self.payload = {'login': 'synthetic_task16_b1e183d', 'password': 'synthetic_' + 'x' * 48, 'seed': 'A' * 32}

    def test_exact_existing_synthetic_identity_is_accepted(self):
        self.assertEqual(module.decode_credentials(json.dumps(self.payload)), self.payload)

    def test_malformed_or_extra_data_refuses_without_echoing_values(self):
        for value in ['synthetic_private_untrusted', '{}', json.dumps({**self.payload, 'unexpected': 'synthetic_private'})]:
            with self.subTest(length=len(value)), self.assertRaisesRegex(RuntimeError, '^upgraded_admin_proof_refused$'):
                module.decode_credentials(value)

    def test_wrong_identity_password_seed_or_type_refuses(self):
        for key, value in [('login', 'synthetic_different_identity'), ('password', 'synthetic_short'),
                           ('seed', 'synthetic_invalid_seed'), ('seed', 123)]:
            with self.subTest(field=key), self.assertRaises(RuntimeError):
                module.decode_credentials(json.dumps({**self.payload, key: value}))

    def test_oversize_payload_refuses(self):
        with self.assertRaises(RuntimeError): module.decode_credentials('x' * 4097)


if __name__ == '__main__': unittest.main()
