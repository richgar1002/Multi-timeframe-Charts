"""
Tests for regime_engine.py and regime API endpoints.
"""

import unittest
import time
import threading
import json
from app import app


def make_bar(time_val, close, high=None, low=None, open=None, vol=1000):
    h = high or close * 1.001
    l = low or close * 0.999
    o = open or close
    return {
        "time": time_val,
        "open": o,
        "high": h,
        "low": l,
        "close": close,
        "volume": vol
    }


def generate_bars(n, start_price=100, interval_sec=60):
    bars = []
    t = 1600000000
    p = start_price
    for i in range(n):
        p = p * (1 + (hash(str(i)) % 201 - 100) * 0.0001)
        bars.append(make_bar(t, round(p, 2), vol=1000 + i * 10))
        t += interval_sec
    return bars


class RegimeEngineUnitTests(unittest.TestCase):
    """Unit tests for PaneRegimeEngine — isolated, no Flask needed."""

    def test_supported_timeframes_includes_core(self):
        from regime_engine import SUPPORTED_TIMEFRAMES, TIMEFRAME_CONFIG
        self.assertIn("15m", SUPPORTED_TIMEFRAMES)
        self.assertIn("1h", SUPPORTED_TIMEFRAMES)
        self.assertIn("4h", SUPPORTED_TIMEFRAMES)
        self.assertIn("1d", SUPPORTED_TIMEFRAMES)
        self.assertEqual(len(SUPPORTED_TIMEFRAMES), 4)

    def test_1d_config_has_all_features(self):
        from regime_engine import TIMEFRAME_CONFIG
        cfg = TIMEFRAME_CONFIG["1d"]
        self.assertIn("Log_Return", cfg["feature_cols"])
        self.assertIn("Realized_Vol", cfg["feature_cols"])
        self.assertIn("HL_Range", cfg["feature_cols"])
        self.assertIn("Volume_Ratio", cfg["feature_cols"])
        self.assertEqual(cfg["vol_window"], 20)

    def test_15m_config_no_volume_ratio(self):
        from regime_engine import TIMEFRAME_CONFIG
        cfg = TIMEFRAME_CONFIG["15m"]
        self.assertIn("Log_Return", cfg["feature_cols"])
        self.assertIn("Realized_Vol", cfg["feature_cols"])
        self.assertIn("HL_Range", cfg["feature_cols"])
        self.assertNotIn("Volume_Ratio", cfg["feature_cols"])
        self.assertEqual(cfg["vol_window"], 10)

    def test_1h_config_is_intermediate(self):
        from regime_engine import TIMEFRAME_CONFIG
        cfg = TIMEFRAME_CONFIG["1h"]
        self.assertIn("Log_Return", cfg["feature_cols"])
        self.assertIn("Realized_Vol", cfg["feature_cols"])
        self.assertIn("HL_Range", cfg["feature_cols"])
        self.assertIn("Volume_Ratio", cfg["feature_cols"])
        self.assertEqual(cfg["vol_window"], 11)
        self.assertEqual(cfg["fit_depth"], 180)
        self.assertEqual(cfg["state_min"], 3)
        self.assertEqual(cfg["state_max"], 5)

    def test_engine_rejects_unsupported_timeframe(self):
        from regime_engine import PaneRegimeEngine
        engine = PaneRegimeEngine("BTC", "30m", [])
        self.assertFalse(engine.is_supported)
        state = engine.get_display_state()
        self.assertEqual(state["status"], "unavailable")

    def test_engine_returns_unavailable_for_unsupported_tf(self):
        from regime_engine import PaneRegimeEngine
        engine = PaneRegimeEngine("BTC", "30m", [])
        state = engine.get_display_state()
        self.assertEqual(state["status"], "unavailable")

    def test_engine_returns_warming_up_before_init(self):
        from regime_engine import PaneRegimeEngine
        engine = PaneRegimeEngine("BTC", "1d", [])
        state = engine.get_display_state()
        self.assertEqual(state["status"], "warming_up")

    def test_engine_initializes_withsufficient_bars(self):
        from regime_engine import PaneRegimeEngine
        bars = generate_bars(250, start_price=100, interval_sec=86400)
        engine = PaneRegimeEngine("BTC", "1d", bars)
        self.assertTrue(engine.is_initialized)

    def test_engine_requires_min_bars_for_init(self):
        from regime_engine import PaneRegimeEngine
        bars = generate_bars(30, start_price=100, interval_sec=86400)
        engine = PaneRegimeEngine("BTC", "1d", bars)
        self.assertFalse(engine.is_initialized)

    def test_engine_on_bar_close_returns_diagnostics_after_init(self):
        from regime_engine import PaneRegimeEngine
        bars = generate_bars(250, start_price=100, interval_sec=86400)
        engine = PaneRegimeEngine("BTC", "1d", bars)
        new_bar = make_bar(1600000000 + 250 * 86400, 105.0)
        engine.append_bar(new_bar)
        result = engine.on_bar_close(new_bar)
        self.assertIsNotNone(result)

    def test_engine_reset_clears_state(self):
        from regime_engine import PaneRegimeEngine
        bars = generate_bars(250, start_price=100, interval_sec=86400)
        engine = PaneRegimeEngine("BTC", "1d", bars)
        self.assertTrue(engine.is_initialized)
        engine.reset()
        self.assertFalse(engine.is_initialized)

    def test_engine_reset_reinitializes_with_new_bars(self):
        from regime_engine import PaneRegimeEngine
        bars1 = generate_bars(250, start_price=100, interval_sec=86400)
        bars2 = generate_bars(200, start_price=50, interval_sec=14400)
        engine = PaneRegimeEngine("ETH", "4h", bars1)
        self.assertTrue(engine.is_initialized)
        engine.reset(symbol="ETH", timeframe="4h", ohlcv_bars=bars2)
        self.assertTrue(engine.is_initialized)

    def test_bar_close_updates_bars_in_current_state(self):
        from regime_engine import PaneRegimeEngine
        bars = generate_bars(250, start_price=100, interval_sec=86400)
        engine = PaneRegimeEngine("BTC", "1d", bars)
        self.assertTrue(engine.is_initialized)

        for i in range(5):
            bar = make_bar(1600000000 + (250 + i) * 86400, 100 + i, vol=1000)
            engine.append_bar(bar)
            diag = engine.on_bar_close(bar)
            # on_bar_close must return diagnostics now that _bars is populated
            self.assertIsNotNone(diag)

        state = engine.get_display_state()
        # bars_in_current is valid (>= 1) after processing new bars;
        # it may be less than initial if a regime transition occurred
        self.assertGreaterEqual(state["bars_in_current"], 1)
        self.assertEqual(state["status"], "ready")

    def test_prev_regimes_includes_history(self):
        from regime_engine import PaneRegimeEngine
        bars = generate_bars(250, start_price=100, interval_sec=86400)
        engine = PaneRegimeEngine("BTC", "1d", bars)
        state = engine.get_display_state()
        self.assertIsInstance(state["prev_regimes"], list)


class RegimeAPITests(unittest.TestCase):
    """Flask test client for regime API endpoints."""

    def setUp(self):
        self.app = app
        self.app.config["TESTING"] = True
        self.client = self.app.test_client()

    def test_regime_init_requires_fields(self):
        for field in ["paneId", "symbol", "timeframe"]:
            body = {"paneId": "p1", "symbol": "BTC", "timeframe": "1d", "bars": []}
            del body[field]
            r = self.client.post("/api/regime/init", data=json.dumps(body),
                                 content_type="application/json")
            self.assertEqual(r.status_code, 400, f"Missing {field} should return 400")

    def test_regime_init_rejects_unsupported_timeframe(self):
        body = {"paneId": "p1", "symbol": "BTC", "timeframe": "30m", "bars": []}
        r = self.client.post("/api/regime/init", data=json.dumps(body),
                            content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Unsupported", r.get_json()["error"])

    def test_regime_init_accepts_supported_timeframes(self):
        for tf in ["15m", "1h", "4h", "1d"]:
            body = {"paneId": f"p_{tf}", "symbol": "BTC", "timeframe": tf,
                    "bars": generate_bars(250)}
            r = self.client.post("/api/regime/init", data=json.dumps(body),
                                content_type="application/json")
            self.assertIn(r.status_code, [200, 201],
                         f"TF {tf} failed: {r.get_json()}")

    def test_regime_bar_close_requires_pane_id(self):
        r = self.client.post("/api/regime/bar_close",
                            data=json.dumps({}),
                            content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_regime_bar_close_returns_404_for_unknown_pane(self):
        r = self.client.post("/api/regime/bar_close",
                            data=json.dumps({"paneId": "nonexistent", "bar": make_bar(1000, 100)}),
                            content_type="application/json")
        self.assertEqual(r.status_code, 404)

    def test_regime_reset_unknown_pane_is_graceful(self):
        """Unknown paneId on reset returns a fresh warming_up state, not an error."""
        r = self.client.post("/api/regime/reset",
                            data=json.dumps({"paneId": "nonexistent"}),
                            content_type="application/json")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(data["state"]["status"], "warming_up")

    def test_regime_init_then_bar_close_full_cycle(self):
        bars = generate_bars(250, start_price=100, interval_sec=86400)
        body = {"paneId": "p_test", "symbol": "BTC", "timeframe": "1d", "bars": bars}
        r = self.client.post("/api/regime/init", data=json.dumps(body),
                            content_type="application/json")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["initialized"])

        new_bar = make_bar(1600000000 + 250 * 86400, 105.0)
        r = self.client.post("/api/regime/bar_close",
                            data=json.dumps({"paneId": "p_test", "bar": new_bar}),
                            content_type="application/json")
        self.assertEqual(r.status_code, 200)
        state = r.get_json()["state"]
        self.assertIn("label", state)
        self.assertIn("confidence", state)


if __name__ == "__main__":
    unittest.main()
