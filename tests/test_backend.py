import importlib
import unittest
from unittest import mock

import app as app_module
import data_source


class DataSourceSubscriptionTests(unittest.TestCase):
    def setUp(self):
        importlib.reload(data_source)

    def test_crypto_subscribe_starts_single_stream_per_coin(self):
        starts = []

        def fake_start(coin):
            starts.append(coin)
            data_source._crypto_stream_modes[coin] = "python"

        with mock.patch.object(data_source, "_start_rust_engine", side_effect=fake_start):
            cb1 = lambda payload: None
            cb2 = lambda payload: None

            data_source.subscribe_live("BTC", "1m", cb1)
            data_source.subscribe_live("BTC", "1m", cb2)

        self.assertEqual(starts, ["BTC"])
        self.assertEqual(len(data_source._active_crypto_subs["BTC"]), 2)

    def test_crypto_unsubscribe_stops_last_stream(self):
        stops = []

        def fake_stop(coin):
            stops.append(coin)
            data_source._crypto_stream_modes.pop(coin, None)

        data_source._active_crypto_subs["BTC"] = set()
        data_source._crypto_stream_modes["BTC"] = "python"

        cb = lambda payload: None
        data_source._active_crypto_subs["BTC"].add(cb)

        with mock.patch.object(data_source, "_stop_crypto_stream", side_effect=fake_stop):
            data_source.unsubscribe_live("BTC", "1m", cb)

        self.assertEqual(stops, ["BTC"])
        self.assertNotIn("BTC", data_source._active_crypto_subs)

    def test_stock_provider_prefers_alpaca_when_credentials_present(self):
        with mock.patch.dict(data_source.os.environ, {
            "APCA_API_KEY_ID": "key",
            "APCA_API_SECRET_KEY": "secret",
        }, clear=False):
            importlib.reload(data_source)
            provider, symbol = data_source._get_provider("AAPL")
            self.assertEqual(provider, "alpaca")
            self.assertEqual(symbol, "AAPL")

    def test_stock_provider_falls_back_to_yfinance_without_credentials(self):
        with mock.patch.dict(data_source.os.environ, {}, clear=True):
            importlib.reload(data_source)
            provider, symbol = data_source._get_provider("AAPL")
            self.assertEqual(provider, "yfinance")
            self.assertEqual(symbol, "AAPL")

    def test_fetch_alpaca_stock_history_formats_bars(self):
        importlib.reload(data_source)
        data_source._ALPACA_API_KEY = "key"
        data_source._ALPACA_API_SECRET = "secret"

        payload = {
            "bars": {
                "AAPL": [
                    {"t": "2026-05-20T14:30:00Z", "o": 100, "h": 101, "l": 99, "c": 100.5, "v": 12345}
                ]
            },
            "next_page_token": None
        }

        fake_response = mock.Mock()
        fake_response.json.return_value = payload
        fake_response.raise_for_status.return_value = None

        with mock.patch.object(data_source.requests, "get", return_value=fake_response):
            bars = data_source._fetch_alpaca_stock_history("AAPL", "15m")

        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]["open"], 100.0)
        self.assertEqual(bars[0]["close"], 100.5)
        self.assertIsInstance(bars[0]["time"], int)


class AppRouteTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config["TESTING"] = True
        self.client = app_module.app.test_client()

    def test_history_rejects_invalid_timeframe(self):
        response = self.client.get("/api/history?symbol=BTC&timeframe=2m")

        self.assertEqual(response.status_code, 400)
        self.assertIn("Unsupported timeframe", response.get_json()["error"])

    def test_history_maps_provider_errors_to_502(self):
        with mock.patch.object(app_module.data_source, "get_historical_data", side_effect=data_source.DataSourceError("provider down")):
            response = self.client.get("/api/history?symbol=BTC&timeframe=1m")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json()["error"], "provider down")


if __name__ == "__main__":
    unittest.main()
