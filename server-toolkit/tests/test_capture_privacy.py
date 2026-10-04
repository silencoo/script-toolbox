"""Privacy regressions; run with Python + Flask, using fake credentials only."""
import contextlib
import importlib.util
import io
import json
import logging
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request

from werkzeug.serving import make_server

source = Path(__file__).resolve().parents[1] / 'tools/user-agent-capture-server.py'
spec = importlib.util.spec_from_file_location('capture_server', source)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CapturePrivacyTest(unittest.TestCase):
    def setUp(self):
        capture.request_logs.clear()
        capture.admin_token = ''

    def test_headers_query_aliases_and_download_path_are_redacted(self):
        with contextlib.redirect_stdout(io.StringIO()):
            response = capture.app.test_client().get(
                '/download/FAKE_PATH_SECRET?ToKeN=FAKE_TOKEN&passkey=FAKE_PASSKEY'
                '&authkey=FAKE_AUTHKEY&access-token=FAKE_ACCESS&clientSecret=FAKE_CLIENT'
                '&X-Amz-Signature=FAKE_SIGNATURE&format=json',
                headers={'Authorization': 'Bearer FAKE_AUTH', 'Cookie': 'FAKE_COOKIE',
                         'X-Auth-Token': 'FAKE_HEADER',
                         'X-Api-Token': 'FAKE_API_HEADER',
                         'Referer': 'https://example.test/?token=FAKE_REFERER'},
            )
        entry = capture.request_logs[-1]
        self.assertNotIn('FAKE_', json.dumps(entry) + response.get_data(as_text=True))
        self.assertEqual(json.loads(entry['args_json'])['format'], 'json')
        self.assertIn('/download/<filename>', entry['url'])

    def test_access_logs_hide_even_unknown_query_secrets_and_404_paths(self):
        stream = io.StringIO()
        logger = logging.getLogger('werkzeug')
        handler = logging.StreamHandler(stream)
        old_level = logger.level
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        self.addCleanup(logger.setLevel, old_level)
        server = make_server('127.0.0.1', 0, capture.app,
                             request_handler=capture.PrivateRequestHandler)
        self.addCleanup(server.server_close)
        with contextlib.redirect_stdout(io.StringIO()):
            for path in ('/test?unknown=FAKE_QUERY_SECRET', '/FAKE_PATH_SECRET?token=FAKE_TOKEN'):
                thread = threading.Thread(target=server.handle_request, daemon=True)
                thread.start()
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}{path}', timeout=5) as response:
                        response.read()
                except urllib.error.HTTPError as error:
                    self.assertEqual(error.code, 404)
                    error.close()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
        self.assertIn('200', stream.getvalue())
        self.assertIn('404', stream.getvalue())
        self.assertNotIn('FAKE_', stream.getvalue())

    def test_dashboard_still_requires_authentication(self):
        capture.admin_token = 'FAKE_ADMIN_PASSWORD'
        client = capture.app.test_client()
        self.assertEqual(client.get('/').status_code, 401)
        self.assertEqual(client.post('/clear').status_code, 401)
        self.assertEqual(client.get('/', auth=('admin', capture.admin_token)).status_code, 200)


if __name__ == '__main__':
    unittest.main()
