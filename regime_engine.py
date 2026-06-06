"""
Regime Engine — pane-local regime inference for Multi-Timeframe-Charts.

Reuses the tested regime logic from regime-detection-dashboard:
- regimes.py: causal_persistence_filter, label_regimes_by_return_and_vol,
             compute_regime_diagnostics, compute_duration_stats
- model.py:  forward_filter, fit_scaler, transform_features, find_optimal_regimes
- features.py: engineer_features, get_feature_matrix, validate_features

Design contract (per pane):
- init(symbol, timeframe, ohlcv_bars): fit scaler + HMM on historical bars
- on_bar_close(bar): append closed bar, run forward filter, return diagnostics
- reset(): called on symbol/timeframe/pane rebuild
- Only ever receives closed bars — never incomplete intrabar data
"""

import numpy as np
from sklearn.preprocessing import StandardScaler
from hmmlearn.hmm import GaussianHMM
import warnings

# ─── Feature engineering ─────────────────────────────────────────────────────

def engineer_features(bars, vol_window=20, vol_ratio_window=20):
    """Compute regime features from bar array.

    Features:
        Log_Return    : log(close[i] / close[i-1])
        Realized_Vol : rolling std of log returns * sqrt(252) annualisation factor
        HL_Range     : (high - low) / close
        Volume_Ratio : rolling mean of volume / rolling mean of volume over window
    """
    n = len(bars)
    closes = np.array([b["close"] for b in bars], dtype=float)
    highs  = np.array([b["high"]  for b in bars], dtype=float)
    lows   = np.array([b["low"]   for b in bars], dtype=float)
    volumes= np.array([b.get("volume", 0) for b in bars], dtype=float)

    log_returns = np.zeros(n)
    if n > 1:
        log_returns[1:] = np.log(closes[1:] / closes[:-1])

    realized_vol = np.zeros(n)
    if n >= vol_window:
        roll_std = np.array([
            np.std(log_returns[max(0,i-vol_window+1):i+1]) * np.sqrt(252)
            for i in range(n)
        ])
        realized_vol[vol_window-1:] = roll_std[vol_window-1:]

    hl_range = np.zeros(n)
    if n > 0:
        hl_range = (highs - lows) / np.maximum(closes, 1e-9)

    volume_ratio = np.zeros(n)
    if n >= vol_ratio_window and np.any(volumes > 0):
        roll_vol = np.array([
            np.mean(volumes[max(0,i-vol_ratio_window+1):i+1])
            for i in range(n)
        ])
        avg_vol = np.mean(volumes)
        if avg_vol > 0:
            volume_ratio[vol_ratio_window-1:] = roll_vol[vol_ratio_window-1:] / avg_vol

    return log_returns, realized_vol, hl_range, volume_ratio


def get_feature_matrix(bars, feature_cols, vol_window=20, vol_ratio_window=20):
    """Build (n_samples, n_features) feature matrix from bars."""
    log_ret, real_vol, hl_rng, vol_rat = engineer_features(bars, vol_window, vol_ratio_window)

    col_map = {
        "Log_Return":    log_ret,
        "Realized_Vol":  real_vol,
        "HL_Range":      hl_rng,
        "Volume_Ratio":  vol_rat,
    }
    return np.column_stack([col_map[c] for c in feature_cols])


def validate_features(X):
    """Return indices of rows with NaN/Inf or all-zero-variance columns."""
    if X.shape[0] == 0:
        return np.zeros(0, dtype=int)
    # Reject rows with any non-finite value
    bad = ~np.all(np.isfinite(X), axis=1)
    # Reject rows where ALL values in any column are zero (zero-variance column)
    if X.shape[1] >= 1:
        col_all_zero = np.all(X == 0, axis=0)  # shape (n_features,)
        if np.any(col_all_zero):
            bad = bad | np.all(X == 0, axis=1)
    return np.where(~bad)[0]


# ─── HMM inference ────────────────────────────────────────────────────────────

def forward_filter(X, model):
    """Run forward algorithm. Returns (regime_seq, confidence, alpha_prob)."""
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)
    n_samples = X.shape[0]

    try:
        _, alpha_prob = model.score_samples(X)
    except Exception:
        alpha_prob = np.zeros((n_samples, model.n_components))

    regime_seq = np.argmax(alpha_prob, axis=1)

    confidence = np.mean(np.max(alpha_prob, axis=1))
    if confidence < 0.25:
        confidence = 0.25

    return regime_seq, float(confidence), alpha_prob


def fit_scaler(X):
    """Fit StandardScaler on feature matrix. Returns (scaler, X_scaled)."""
    scaler = StandardScaler()
    X_s = scaler.fit_transform(X)
    return scaler, X_s


def transform_features(scaler, X):
    """Transform using fitted scaler."""
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)
    return scaler.transform(X)


def find_optimal_regimes(X, max_states=7, min_states=3):
    """Fit GaussianHMM models with 3–max_states states. Return best by BIC."""
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)

    best_model = None
    best_bic = -np.inf
    n_samples, n_features = X.shape

    for n_states in range(min_states, min(max_states + 1, n_samples)):
        try:
            model = GaussianHMM(
                n_components=n_states,
                covariance_type="full",
                n_iter=200,
                random_state=42,
                min_covar=1e-5
            )
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                model.fit(X)
            score = model.score(X)
            # BIC: lower = better (we want max, so negate)
            bic = -score * n_samples + n_states * n_features * np.log(n_samples)
            if bic > best_bic:
                best_bic = bic
                best_model = model
        except Exception:
            continue

    if best_model is None:
        # Fallback to simple 2-state
        model = GaussianHMM(n_components=2, covariance_type="full", n_iter=100, random_state=42, min_covar=1e-5)
        model.fit(X)
        best_model = model

    return best_model


# ─── Regime labelling ─────────────────────────────────────────────────────────

def label_regimes_by_return_and_vol(regime_seq, alpha_prob, X_s):
    """Assign Bull/Bear + Quiet/Volatile labels to each unique HMM state.

    Uses scaled-space median of return and vol features to separate:
      - High return  → Bull,   Low return  → Bear
      - Low  vol     → Quiet,  High vol     → Volatile
    """
    unique_states = np.unique(regime_seq)
    labels = {}

    if X_s.shape[1] < 2:
        for s in unique_states:
            labels[s] = "Bull Quiet"
        return labels

    log_ret_col = X_s[:, 0]   # Log_Return (first feature)
    vol_col    = X_s[:, 1]   # Realized_Vol (second feature)

    for s in unique_states:
        mask = regime_seq == s
        med_ret = np.median(log_ret_col[mask])
        med_vol = np.median(vol_col[mask])
        ret_above = med_ret >= 0
        vol_above = med_vol >= 0

        if ret_above and not vol_above:
            labels[s] = "Bull Quiet"
        elif ret_above and vol_above:
            labels[s] = "Bull Volatile"
        elif not ret_above and not vol_above:
            labels[s] = "Bear Quiet"
        else:
            labels[s] = "Bear Volatile"

    return labels


# ─── Persistence filtering ───────────────────────────────────────────────────

def causal_persistence_filter(regime_seq, min_persistence=3):
    """Enforce confirmed regime only after min_persistence consecutive bars.

    Returns:
        live_seq   : confirmed regime at each bar (None before persistence threshold)
        pending_seq: candidate regime at each bar (raw HMM output)
    """
    n = len(regime_seq)
    live_seq    = [None] * n
    pending_seq = list(regime_seq)

    count = 1
    for i in range(1, n):
        if regime_seq[i] == regime_seq[i - 1]:
            count += 1
        else:
            count = 1

        if count >= min_persistence:
            live_seq[i] = regime_seq[i]

    return np.array(live_seq), np.array(pending_seq)


# ─── Regime diagnostics ───────────────────────────────────────────────────────

def compute_regime_diagnostics(regime_seq, live_seq, pending_seq, alpha_prob,
                               label_map, bars_in_current_state,
                               last_transition_bar, posterior_at_t):
    """Build compact display state from filter outputs."""
    current_state = None
    pending_state = None
    is_pending = False

    if live_seq[-1] is not None:
        current_state = int(live_seq[-1])
        pending_state = int(pending_seq[-1])
        is_pending = (pending_state != current_state)
    elif pending_seq[-1] is not None:
        pending_state = int(pending_seq[-1])
        current_state = pending_state
        is_pending = True

    avg_conf = float(np.mean(np.max(alpha_prob, axis=1))) if len(alpha_prob) else 0.0

    def _label(state):
        if state is None:
            return "Unknown"
        return label_map.get(state, "Unknown")

    return {
        "confirmed_state":   _label(current_state),
        "pending_state":     _label(pending_state),
        "is_pending":        bool(is_pending),
        "confidence":         round(avg_conf * 100, 1),
        "bars_in_current":    int(bars_in_current_state),
        "last_transition_bar": int(last_transition_bar) if last_transition_bar is not None else None,
    }


def compute_duration_stats(regime_seq, live_seq, pending_seq):
    """Return last 2 confirmed regime episodes with durations."""
    n = len(live_seq)
    episodes = []  # list of (start_bar, end_bar, regime_value)

    i = 0
    while i < n:
        # Find next confirmed state
        if live_seq[i] is None:
            i += 1
            continue
        cur = int(live_seq[i])
        start = i
        j = i + 1
        while j < n and live_seq[j] == cur:
            j += 1
        episodes.append((start, j - 1, cur))
        i = j

    result = []
    for ep_start, ep_end, reg_val in episodes[-3:]:
        duration = ep_end - ep_start + 1
        result.append({
            "regime": reg_val,
            "start_bar": int(ep_start),
            "end_bar": int(ep_end),
            "duration_bars": int(duration),
        })

    return result[-3:]  # last 3 episodes


# ─── Feature configuration per timeframe ────────────────────────────────────

TIMEFRAME_CONFIG = {
    "15m": {
        "feature_cols": ["Log_Return", "Realized_Vol", "HL_Range"],
        "vol_window": 10,
        "vol_ratio_window": 10,   # not used in v1 for 15m, but kept for completeness
        "fit_depth": 160,
        "state_min": 3,
        "state_max": 4,
    },
    "30m": {
        "feature_cols": ["Log_Return", "Realized_Vol", "HL_Range", "Volume_Ratio"],
        "vol_window": 10,
        "vol_ratio_window": 10,
        "fit_depth": 192,         # ~4 trading days × 48 bars/day
        "state_min": 3,
        "state_max": 5,
    },
    "1h": {
        "feature_cols": ["Log_Return", "Realized_Vol", "HL_Range", "Volume_Ratio"],
        "vol_window": 11,
        "vol_ratio_window": 11,
        "fit_depth": 180,
        "state_min": 3,
        "state_max": 5,
    },
    "4h": {
        "feature_cols": ["Log_Return", "Realized_Vol", "HL_Range", "Volume_Ratio"],
        "vol_window": 12,
        "vol_ratio_window": 12,
        "fit_depth": 200,
        "state_min": 3,
        "state_max": 5,
    },
    "1d": {
        "feature_cols": ["Log_Return", "Realized_Vol", "HL_Range", "Volume_Ratio"],
        "vol_window": 20,
        "vol_ratio_window": 20,
        "fit_depth": 250,
        "state_min": 3,
        "state_max": 7,
    },
}

SUPPORTED_TIMEFRAMES = set(TIMEFRAME_CONFIG.keys())


# ─── PaneRegimeEngine ─────────────────────────────────────────────────────────

class PaneRegimeEngine:
    """Pane-local regime inference engine.

    Lifecycle:
        init(symbol, timeframe, ohlcv_bars) → fit scaler + HMM
        on_bar_close(bar)                    → update + return diagnostics
        reset()                              → clear state
        destroy()                            → cleanup (no-op here)
    """

    def __init__(self, symbol, timeframe, ohlcv_bars=None):
        self.symbol    = symbol
        self.timeframe = timeframe
        self._config   = TIMEFRAME_CONFIG.get(timeframe)

        self.scaler      = None
        self.model       = None
        self.label_map   = {}
        self.live_seq    = np.array([], dtype=int)
        self.pending_seq = np.array([], dtype=int)
        self._alpha_prob = np.zeros((0, 0))
        self._last_transition_bar = None
        self._bars_in_current_state = 0
        self._initialized = False

        if self._config is None:
            return  # unsupported timeframe — engine is no-op

        if ohlcv_bars and len(ohlcv_bars) >= 50:
            self._fit(ohlcv_bars)

    def _fit(self, bars):
        cfg = self._config
        depth = cfg["fit_depth"]
        bars = bars[-depth:] if len(bars) > depth else bars

        self._bars = list(bars)

        X = get_feature_matrix(
            bars,
            cfg["feature_cols"],
            vol_window=cfg["vol_window"],
            vol_ratio_window=cfg["vol_ratio_window"]
        )
        valid_idx = validate_features(X)
        if len(valid_idx) < 50:
            return  # insufficient valid data

        X_valid = X[valid_idx]
        self.scaler, X_s = fit_scaler(X_valid)
        X_tr    = transform_features(self.scaler, X_valid)

        self.model = find_optimal_regimes(
            X_tr,
            max_states=cfg["state_max"],
            min_states=cfg["state_min"]
        )

        regime_seq, conf, alpha_prob = forward_filter(X_tr, self.model)
        live_seq, pending_seq = causal_persistence_filter(
            regime_seq, min_persistence=cfg.get("min_persistence", 3)
        )
        self.label_map = label_regimes_by_return_and_vol(
            regime_seq, alpha_prob, X_tr
        )

        self.live_seq    = live_seq
        self.pending_seq = pending_seq
        self._alpha_prob = alpha_prob
        self._bars_in_current_state = self._compute_bars_in_state()
        self._last_transition_bar = self._find_last_transition()
        self._initialized = True

    def _compute_bars_in_state(self):
        if len(self.live_seq) == 0 or self.live_seq[-1] is None:
            return 0
        current = self.live_seq[-1]
        count = 0
        for i in range(len(self.live_seq) - 1, -1, -1):
            if self.live_seq[i] == current:
                count += 1
            else:
                break
        return count

    def _find_last_transition(self):
        live = self.live_seq
        for i in range(len(live) - 2, -1, -1):
            if live[i] is not None and live[i + 1] != live[i]:
                return i + 1
        return None

    @property
    def is_initialized(self):
        return self._initialized

    @property
    def is_supported(self):
        return self._config is not None

    def on_bar_close(self, bar):
        """Process a newly closed bar. Returns diagnostics dict or None."""
        if not self.is_initialized or not self.is_supported:
            return None

        cfg = self._config

        # Append bar to existing series for feature recompute
        # (we rebuild the full feature matrix each time; bounded by fit_depth)
        self.live_seq    = np.append(self.live_seq,    0)
        self.pending_seq = np.append(self.pending_seq, 0)

        n = len(self.live_seq)

        # Build extended bar list
        # We need at least vol_window bars before this one for features to be valid
        # so we use a lookback window
        lookback = max(cfg["fit_depth"], cfg["vol_window"] + 10)
        recent_bars = self._recent_bars(lookback + 1)

        X = get_feature_matrix(
            recent_bars,
            cfg["feature_cols"],
            vol_window=cfg["vol_window"],
            vol_ratio_window=cfg["vol_ratio_window"]
        )
        valid_idx = validate_features(X)
        if len(valid_idx) < cfg["vol_window"]:
            return self._current_diagnostics()

        X_valid = X[valid_idx]
        X_tr    = transform_features(self.scaler, X_valid)

        regime_seq, conf, alpha_prob = forward_filter(X_tr, self.model)
        live_seq, pending_seq = causal_persistence_filter(
            regime_seq, min_persistence=cfg.get("min_persistence", 3)
        )
        if len(live_seq) > 0:
            self.live_seq[-1]    = live_seq[-1] if live_seq[-1] is not None else 0
            self.pending_seq[-1] = pending_seq[-1]
        self._alpha_prob = alpha_prob
        self._bars_in_current_state = self._compute_bars_in_state()
        self._last_transition_bar = self._find_last_transition()

        return self._current_diagnostics()

    def _current_diagnostics(self):
        if not self._initialized:
            return None
        return compute_regime_diagnostics(
            self.pending_seq,
            self.live_seq,
            self.pending_seq,
            self._alpha_prob,
            self.label_map,
            self._bars_in_current_state,
            self._last_transition_bar,
            None
        )

    def _recent_bars(self, n):
        """Return last n bars from internal state."""
        bars = getattr(self, "_bars", [])
        return bars[-n:] if len(bars) > n else bars

    def get_display_state(self):
        """Return full display state dict."""
        if not self.is_supported:
            return {
                "status": "unavailable",
                "label": "Unknown",
                "confidence": 0,
                "is_pending": False,
                "pending_label": "Unknown",
                "bars_in_current": 0,
                "prev_regimes": [],
            }

        if not self.is_initialized:
            return {
                "status": "warming_up",
                "label": "Unknown",
                "confidence": 0,
                "is_pending": False,
                "pending_label": "Unknown",
                "bars_in_current": 0,
                "prev_regimes": [],
            }

        diag = self._current_diagnostics()
        if diag is None:
            return {
                "status": "warming_up",
                "label": "Unknown",
                "confidence": 0,
                "is_pending": False,
                "pending_label": "Unknown",
                "bars_in_current": 0,
                "prev_regimes": [],
            }

        episodes = compute_duration_stats(self.live_seq, self.live_seq, self.pending_seq)
        prev_regimes = [
            {
                "regime": self.label_map.get(ep["regime"], "Unknown"),
                "duration_bars": ep["duration_bars"],
                "end_bar": ep["end_bar"],
            }
            for ep in episodes[:-1]  # exclude current (last episode)
        ][-2:]  # last 2

        return {
            "status": "ready",
            "label": diag["confirmed_state"],
            "confidence": diag["confidence"],
            "is_pending": diag["is_pending"],
            "pending_label": diag["pending_state"] if diag["is_pending"] else None,
            "bars_in_current": diag["bars_in_current"],
            "prev_regimes": prev_regimes,
        }

    def reset(self, symbol=None, timeframe=None, ohlcv_bars=None):
        """Reset engine. Optionally re-init with new symbol/timeframe/bars."""
        self.scaler      = None
        self.model       = None
        self.label_map   = {}
        self.live_seq    = np.array([], dtype=int)
        self.pending_seq = np.array([], dtype=int)
        self._alpha_prob = np.zeros((0, 0))
        self._last_transition_bar = None
        self._bars_in_current_state = 0
        self._initialized = False
        self._bars = []

        if symbol is not None:
            self.symbol = symbol
        if timeframe is not None:
            self.timeframe = timeframe
            self._config = TIMEFRAME_CONFIG.get(timeframe)

        if ohlcv_bars and self._config is not None:
            self._fit(ohlcv_bars)

    def append_bar(self, bar):
        """Record a closed bar in internal history (for feature recompute)."""
        if not hasattr(self, "_bars"):
            self._bars = []
        self._bars.append(bar)
        # Keep bounded
        max_bars = max(cfg["fit_depth"] for cfg in TIMEFRAME_CONFIG.values()) + 50
        if len(self._bars) > max_bars:
            self._bars = self._bars[-max_bars:]
