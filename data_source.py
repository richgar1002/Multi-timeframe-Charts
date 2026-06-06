import os
import sys
import json
import time
import subprocess
import threading
import requests
import yfinance as yf
import pandas as pd

_ALPACA_API_KEY = os.getenv("APCA_API_KEY_ID") or os.getenv("ALPACA_API_KEY")
_ALPACA_API_SECRET = os.getenv("APCA_API_SECRET_KEY") or os.getenv("ALPACA_API_SECRET")
_ALPACA_DATA_FEED = (os.getenv("ALPACA_DATA_FEED") or "iex").lower()
_ALPACA_DATA_BASE_URL = os.getenv("ALPACA_DATA_BASE_URL") or "https://data.alpaca.markets"

# Webull configuration
# Set WEBULL_TEST_ENV=1 to use the UAT test environment with the shared test credentials.
# Public test credentials (from Webull developer docs) — require token verification via portal:
#   App Key:    a88f2efed4dca02b9bc1a3cecbc35dba
#   App Secret: c2895b3526cc7c7588758351ddf425d6
# Set WEBULL_APP_KEY + WEBULL_APP_SECRET env vars to activate Webull.
# Set WEBULL_TEST_ENV=1 to use UAT test environment.
_WEBULL_APP_KEY    = os.getenv("WEBULL_APP_KEY",    "")
_WEBULL_APP_SECRET = os.getenv("WEBULL_APP_SECRET", "")
_WEBULL_USE_TEST   = os.getenv("WEBULL_TEST_ENV", "0").lower() in ("1", "true", "yes")
_WEBULL_API_HOST   = (
    "us-broker-api.uat.webullbroker.com" if _WEBULL_USE_TEST else "broker-api.webull.com"
)
_WEBULL_MQTT_HOST  = (
    "us-data-api.uat.webullbroker.com"   if _WEBULL_USE_TEST else "data-api.webull.com"
)

# Active subscriptions: symbol -> set of callback functions
_active_crypto_subs = {}
_active_stock_subs = {}

# Crypto stream tracking
_crypto_lock = threading.RLock()
_crypto_processes = {}
_crypto_threads = {}
_crypto_stream_modes = {}

# Stock polling tracking
_stock_thread = None
_stock_thread_lock = threading.Lock()
_stock_thread_running = False

# Webull streaming state
_webull_subs    = {}   # symbol -> set of callbacks
_webull_cvd     = {}   # symbol -> running cumulative delta (real side from exchange)
_webull_vwap    = {}   # symbol -> {"value": float, "volume": float}
_webull_stream  = None # shared DataStreamingClient instance
_webull_lock    = threading.RLock()


class DataSourceError(Exception):
    """Raised when a provider request fails rather than returning no data."""
    pass

# Provider mapping based on symbol heuristics.
# In a real system, the user could configure this explicitly.
def _get_provider(symbol):
    # Crypto → Hyperliquid (real order flow, real tick side)
    crypto_symbols = {"BTC", "ETH", "SOL", "ARB", "HYPE", "PURR", "LINK", "AVAX", "SUI", "APT", "OP"}
    if symbol.upper() in crypto_symbols or symbol.upper().endswith("USDT") or symbol.upper().endswith("USD"):
        clean_sym = symbol.upper()
        for suffix in ["USDT", "USD"]:
            if clean_sym.endswith(suffix) and clean_sym != suffix:
                clean_sym = clean_sym[:-len(suffix)]
        return "hyperliquid", clean_sym

    # Stocks: explicit override → auto-detect (Alpaca → Webull → yfinance)
    # Set STOCK_DATA_PROVIDER=webull  to force Webull even if Alpaca creds exist.
    # Set STOCK_DATA_PROVIDER=alpaca  to force Alpaca.
    # Set STOCK_DATA_PROVIDER=yfinance to force yfinance.
    override = os.getenv("STOCK_DATA_PROVIDER", "").lower().strip()
    if override == "webull":
        return "webull", symbol.upper()
    if override == "alpaca":
        return "alpaca", symbol.upper()
    if override == "yfinance":
        return "yfinance", symbol.upper()

    # Auto-detect: Alpaca (if configured) → Webull → yfinance
    if _has_alpaca_credentials():
        return "alpaca", symbol.upper()
    if _has_webull_credentials():
        return "webull", symbol.upper()
    return "yfinance", symbol.upper()

def _has_alpaca_credentials():
    return bool(_ALPACA_API_KEY and _ALPACA_API_SECRET)

def _has_webull_credentials():
    return bool(_WEBULL_APP_KEY and _WEBULL_APP_SECRET)

def _alpaca_headers():
    if not _has_alpaca_credentials():
        raise DataSourceError("Alpaca credentials are not configured")
    return {
        "APCA-API-KEY-ID": _ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": _ALPACA_API_SECRET,
    }

def _alpaca_timeframe(interval):
    mapping = {
        "1m": "1Min",
        "3m": "3Min",
        "5m": "5Min",
        "15m": "15Min",
        "30m": "30Min",
        "1h": "1Hour",
        "4h": "4Hour",
        "1d": "1Day",
    }
    if interval not in mapping:
        raise DataSourceError(f"Unsupported Alpaca timeframe: {interval}")
    return mapping[interval]

def _alpaca_history_window(interval):
    return {
        "1m": "5D",
        "3m": "10D",
        "5m": "30D",
        "15m": "30D",
        "30m": "60D",
        "1h": "120D",
        "4h": "365D",
        "1d": "2Y",
    }.get(interval, "30D")

# --- PLUGGABLE DATA SOURCE PROVIDERS ---

def aggregate_candles(candles, target_seconds):
    if not candles:
        return []
    aggregated = []
    current_bucket = None
    for c in candles:
        bucket_time = (c["time"] // target_seconds) * target_seconds
        if current_bucket is None:
            current_bucket = {
                "time": bucket_time,
                "open": c["open"],
                "high": c["high"],
                "low": c["low"],
                "close": c["close"],
                "volume": c["volume"]
            }
        elif bucket_time == current_bucket["time"]:
            current_bucket["high"] = max(current_bucket["high"], c["high"])
            current_bucket["low"] = min(current_bucket["low"], c["low"])
            current_bucket["close"] = c["close"]
            current_bucket["volume"] += c["volume"]
        else:
            aggregated.append(current_bucket)
            current_bucket = {
                "time": bucket_time,
                "open": c["open"],
                "high": c["high"],
                "low": c["low"],
                "close": c["close"],
                "volume": c["volume"]
            }
    if current_bucket:
        aggregated.append(current_bucket)
    return aggregated

def get_historical_data(symbol, timeframe):
    """
    Exposes historical data fetching. Pluggable - delegates based on symbol type.
    """
    provider, clean_symbol = _get_provider(symbol)
    
    if provider == "hyperliquid":
        return _fetch_hyperliquid_history(clean_symbol, timeframe)
    elif provider == "alpaca":
        return _fetch_alpaca_stock_history(clean_symbol, timeframe)
    elif provider == "webull":
        return _fetch_webull_history(clean_symbol, timeframe)
    elif provider == "yfinance":
        return _fetch_yfinance_history(clean_symbol, timeframe)
    else:
        raise ValueError(f"Unknown provider for symbol: {symbol}")

# 1. Hyperliquid Historical Data
def _fetch_hyperliquid_history(coin, interval):
    """
    Fetches historical candle snapshots from Hyperliquid.
    Supports native: 1m, 5m, 15m, 1h, 4h, 1d
    Aggregates: 3m (from 1m), 30m (from 15m)
    """
    native_interval = interval
    aggregate_sec = None
    
    if interval == "3m":
        native_interval = "1m"
        aggregate_sec = 180
    elif interval == "30m":
        native_interval = "15m"
        aggregate_sec = 1800
        
    url = "https://api.hyperliquid.xyz/info"
    headers = {"Content-Type": "application/json"}
    
    # Map intervals to seconds to determine start time (fetch last ~500 candles)
    interval_seconds = {
        "1m": 60,
        "5m": 300,
        "15m": 900,
        "1h": 3600,
        "4h": 14400,
        "1d": 86400
    }
    
    sec = interval_seconds.get(native_interval, 60)
    end_time_ms = int(time.time() * 1000)
    fetch_count = 1000 if aggregate_sec else 500
    start_time_ms = end_time_ms - (sec * fetch_count * 1000)
    
    payload = {
        "type": "candleSnapshot",
        "req": {
            "coin": coin,
            "interval": native_interval,
            "startTime": start_time_ms,
            "endTime": end_time_ms
        }
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        response.raise_for_status()
        candles = response.json()
        
        # Sort candles by time
        candles = sorted(candles, key=lambda x: x["t"])
        
        formatted = []
        for c in candles:
            formatted.append({
                "time": int(c["t"] / 1000),
                "open": float(c["o"]),
                "high": float(c["h"]),
                "low": float(c["l"]),
                "close": float(c["c"]),
                "volume": float(c["v"])
            })
            
        if aggregate_sec:
            formatted = aggregate_candles(formatted, aggregate_sec)
            
        return formatted
    except Exception as e:
        raise DataSourceError(f"Hyperliquid history request failed for {coin}: {e}") from e

# 2. Yahoo Finance Historical Data
def _fetch_yfinance_history(symbol, interval):
    """
    Fetches historical candles from yfinance.
    Supports native: 1m, 5m, 15m, 30m, 1h, 1d
    Aggregates: 3m (from 1m), 4h (from 1h)
    """
    native_interval = interval
    aggregate_sec = None
    
    if interval == "3m":
        native_interval = "1m"
        aggregate_sec = 180
    elif interval == "4h":
        native_interval = "1h"
        aggregate_sec = 14400
        
    period_map = {
        "1m": "5d",
        "5m": "30d",
        "15m": "30d",
        "30m": "30d",
        "1h": "60d",
        "1d": "1y"
    }
    period = period_map.get(native_interval, "1y")
    
    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(period=period, interval=native_interval)
        
        if df.empty:
            return []
            
        formatted = []
        for index, row in df.iterrows():
            formatted.append({
                "time": int(index.timestamp()),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"])
            })
            
        if aggregate_sec:
            formatted = aggregate_candles(formatted, aggregate_sec)
            
        return formatted
    except Exception as e:
        raise DataSourceError(f"Yahoo Finance history request failed for {symbol}: {e}") from e

def _fetch_alpaca_stock_history(symbol, interval):
    timeframe = _alpaca_timeframe(interval)
    window = _alpaca_history_window(interval)
    url = f"{_ALPACA_DATA_BASE_URL}/v2/stocks/bars"
    params = {
        "symbols": symbol,
        "timeframe": timeframe,
        "limit": 10000,
        "adjustment": "raw",
        "feed": _ALPACA_DATA_FEED,
    }

    now_utc = pd.Timestamp.now(tz="UTC")
    if window.endswith("D"):
        params["start"] = (now_utc - pd.Timedelta(days=int(window[:-1]))).isoformat()
    elif window.endswith("Y"):
        params["start"] = (now_utc - pd.Timedelta(days=365 * int(window[:-1]))).isoformat()
    else:
        params["start"] = (now_utc - pd.Timedelta(days=30)).isoformat()
    params["end"] = now_utc.isoformat()

    all_bars = []
    next_page_token = None

    try:
        while True:
            if next_page_token:
                params["page_token"] = next_page_token
            elif "page_token" in params:
                del params["page_token"]

            response = requests.get(url, headers=_alpaca_headers(), params=params, timeout=15)
            response.raise_for_status()
            payload = response.json()
            bars = payload.get("bars", {}).get(symbol, [])
            for bar in bars:
                ts = pd.Timestamp(bar["t"])
                all_bars.append({
                    "time": int(ts.timestamp()),
                    "open": float(bar["o"]),
                    "high": float(bar["h"]),
                    "low": float(bar["l"]),
                    "close": float(bar["c"]),
                    "volume": float(bar["v"]),
                })

            next_page_token = payload.get("next_page_token")
            if not next_page_token:
                break

        return all_bars
    except Exception as e:
        raise DataSourceError(f"Alpaca history request failed for {symbol}: {e}") from e


# --- LIVE STREAMING MANAGER ---

def subscribe_live(symbol, timeframe, callback):
    """
    Subscribes a callback to live updates for a symbol/timeframe.
    """
    provider, clean_symbol = _get_provider(symbol)
    
    if provider == "hyperliquid":
        _subscribe_crypto(clean_symbol, callback)
    elif provider == "webull":
        _subscribe_webull_stock(clean_symbol, callback)
    elif provider in {"yfinance", "alpaca"}:
        _subscribe_stock(clean_symbol, callback)

def unsubscribe_live(symbol, timeframe, callback):
    """
    Unsubscribes a callback from live updates for a symbol/timeframe.
    """
    provider, clean_symbol = _get_provider(symbol)
    
    if provider == "hyperliquid":
        _unsubscribe_crypto(clean_symbol, callback)
    elif provider == "webull":
        _unsubscribe_webull_stock(clean_symbol, callback)
    elif provider in {"yfinance", "alpaca"}:
        _unsubscribe_stock(clean_symbol, callback)


# --- RUST SUBPROCESS MANAGEMENT FOR CRYPTO ---

def _subscribe_crypto(coin, callback):
    with _crypto_lock:
        if coin not in _active_crypto_subs:
            _active_crypto_subs[coin] = set()
        _active_crypto_subs[coin].add(callback)

        # Start exactly one producer per coin, regardless of mode.
        if coin not in _crypto_stream_modes:
            _start_rust_engine(coin)

def _unsubscribe_crypto(coin, callback):
    with _crypto_lock:
        if coin in _active_crypto_subs:
            _active_crypto_subs[coin].discard(callback)
            # If no callbacks left, stop the producer
            if not _active_crypto_subs[coin]:
                del _active_crypto_subs[coin]
                _stop_crypto_stream(coin)

def _start_rust_engine(coin):
    with _crypto_lock:
        if _crypto_stream_modes.get(coin) is not None:
            return
        # Reserve slot before releasing lock to prevent double-start race
        _crypto_stream_modes[coin] = "starting"

    executable_path = os.path.join(os.path.dirname(__file__), "order_flow_engine", "target", "release", "order_flow_engine.exe")
    if not os.path.exists(executable_path):
        # Fallback to debug build if release build doesn't exist
        executable_path = os.path.join(os.path.dirname(__file__), "order_flow_engine", "target", "debug", "order_flow_engine.exe")

    if not os.path.exists(executable_path):
        print(f"Error: Rust engine executable not found at {executable_path}", file=sys.stderr)
        with _crypto_lock:
            _crypto_stream_modes.pop(coin, None)
        _start_simulated_crypto_stream(coin)
        return

    try:
        # Launch Rust engine as a subprocess with coin as arg
        # The Rust engine reads coin trades and prints JSON lines
        p = subprocess.Popen(
            [executable_path, coin],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        with _crypto_lock:
            _crypto_processes[coin] = p
            _crypto_stream_modes[coin] = "rust"

        # Thread to read stdout
        t = threading.Thread(target=_read_process_stdout, args=(coin, p), daemon=True)
        with _crypto_lock:
            _crypto_threads[coin] = t
        t.start()
        print(f"Started Rust Order Flow Engine for {coin} (PID: {p.pid})")
    except Exception as e:
        print(f"Failed to start Rust engine for {coin}: {e}", file=sys.stderr)
        with _crypto_lock:
            _crypto_stream_modes.pop(coin, None)
        _start_simulated_crypto_stream(coin)

def _stop_crypto_stream(coin):
    with _crypto_lock:
        mode = _crypto_stream_modes.pop(coin, None)
        p = _crypto_processes.pop(coin, None)
        _crypto_threads.pop(coin, None)

    if p:
        print(f"Stopping Rust Order Flow Engine for {coin} (PID: {p.pid})")
        p.terminate()
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            p.kill()
    elif mode == "python":
        print(f"Stopping Python fallback stream for {coin}")

def _read_process_stdout(coin, process):
    """
    Reads JSON lines from the Rust subprocess and forwards them to subscribers.
    """
    for line in iter(process.stdout.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            # Forward data to all callbacks for this coin
            with _crypto_lock:
                callbacks = list(_active_crypto_subs.get(coin, []))
            for cb in callbacks:
                try:
                    cb(data)
                except Exception as e:
                    print(f"Callback error for {coin}: {e}", file=sys.stderr)
        except json.JSONDecodeError:
            print(f"Rust output debug [{coin}]: {line}", file=sys.stderr)
            
    # Subprocess ended (either stopped or crashed)
    stderr_output = process.stderr.read()
    if stderr_output:
        print(f"Rust engine [{coin}] stderr: {stderr_output}", file=sys.stderr)
    
    should_restart = False
    with _crypto_lock:
        if coin in _crypto_processes and _crypto_processes[coin] == process:
            del _crypto_processes[coin]
            _crypto_threads.pop(coin, None)
            _crypto_stream_modes.pop(coin, None)
            should_restart = bool(_active_crypto_subs.get(coin))

    if should_restart:
        print(f"Rust engine for {coin} exited. Restarting...")
        _start_rust_engine(coin)

# --- FALLBACK / PYTHON WEBSOCKET STREAM IN CASE RUST RUNS INTO COMPILATION ISSUES ---
def _start_simulated_crypto_stream(coin):
    with _crypto_lock:
        if _crypto_stream_modes.get(coin) is not None:
            return
        _crypto_stream_modes[coin] = "python"

    print(f"Using Python-based real WebSocket stream for {coin} (Rust engine compiled: False)")
    
    def run_stream():
        import asyncio
        import websockets
        import json
        
        async def main_loop():
            cvd = 0.0
            total_value = 0.0
            total_volume = 0.0
            
            while True:
                with _crypto_lock:
                    if coin not in _active_crypto_subs:
                        break
                try:
                    async with websockets.connect("wss://api.hyperliquid.xyz/ws", ping_interval=15, ping_timeout=10) as ws:
                        # Subscribe to trades
                        sub_msg = {
                            "method": "subscribe",
                            "subscription": {
                                "type": "trades",
                                "coin": coin
                            }
                        }
                        await ws.send(json.dumps(sub_msg))
                        
                        while True:
                            with _crypto_lock:
                                if coin not in _active_crypto_subs:
                                    break
                            msg_raw = await ws.recv()
                            msg = json.loads(msg_raw)
                            if isinstance(msg, dict) and msg.get("channel") == "trades":
                                trades_data = msg.get("data", [])
                                for t in trades_data:
                                    try:
                                        price = float(t["px"])
                                        size = float(t["sz"])
                                        side = t["side"]
                                        
                                        if side == "B":
                                            cvd += size
                                        elif side == "S":
                                            cvd -= size
                                            
                                        total_value += price * size
                                        total_volume += size
                                        vwap = total_value / total_volume if total_volume > 0.0 else price
                                        
                                        payload = {
                                            "coin": coin,
                                            "price": price,
                                            "size": size,
                                            "side": side,
                                            "time": t["time"],
                                            "cvd": cvd,
                                            "vwap": vwap
                                        }
                                        
                                        # Forward to callbacks
                                        with _crypto_lock:
                                            callbacks = list(_active_crypto_subs.get(coin, []))
                                        for cb in callbacks:
                                            try:
                                                cb(payload)
                                            except Exception:
                                                pass
                                    except Exception:
                                        pass
                except Exception as e:
                    print(f"Python WS stream error for {coin}: {e}", file=sys.stderr)
                    await asyncio.sleep(5)

            with _crypto_lock:
                if _crypto_stream_modes.get(coin) == "python" and coin not in _active_crypto_subs:
                    _crypto_stream_modes.pop(coin, None)
                    
        # Run asyncio loop in this thread
        asyncio.run(main_loop())
        
    t = threading.Thread(target=run_stream, daemon=True)
    with _crypto_lock:
        _crypto_threads[coin] = t
    t.start()


# --- STOCK POLLING FOR YFINANCE ---

def _subscribe_stock(symbol, callback):
    global _stock_thread, _stock_thread_running
    
    with _stock_thread_lock:
        if symbol not in _active_stock_subs:
            _active_stock_subs[symbol] = set()
        _active_stock_subs[symbol].add(callback)
        
        if not _stock_thread_running:
            _stock_thread_running = True
            _stock_thread = threading.Thread(target=_poll_stocks_loop, daemon=True)
            _stock_thread.start()
            print("Started stock polling thread.")

def _unsubscribe_stock(symbol, callback):
    global _stock_thread_running
    
    with _stock_thread_lock:
        if symbol in _active_stock_subs:
            _active_stock_subs[symbol].discard(callback)
            if not _active_stock_subs[symbol]:
                del _active_stock_subs[symbol]
                
        if not _active_stock_subs:
            _stock_thread_running = False
            print("Stopped stock polling thread (no active stock subscriptions).")

def _fetch_latest_stock_tick(symbol, last_prices):
    if _has_alpaca_credentials():
        try:
            trade_url = f"{_ALPACA_DATA_BASE_URL}/v2/stocks/{symbol}/trades/latest"
            trade_resp = requests.get(
                trade_url,
                headers=_alpaca_headers(),
                params={"feed": _ALPACA_DATA_FEED},
                timeout=10
            )
            trade_resp.raise_for_status()
            trade = trade_resp.json().get("trade") or {}
            price = float(trade.get("p") or 0)
            ts = trade.get("t")

            if price > 0 and ts:
                prev_price = last_prices.get(symbol, price)
                side = "B" if price >= prev_price else "S"
                last_prices[symbol] = price
                time_ms = int(pd.Timestamp(ts).timestamp() * 1000)

                bar_url = f"{_ALPACA_DATA_BASE_URL}/v2/stocks/bars/latest"
                bar_resp = requests.get(
                    bar_url,
                    headers=_alpaca_headers(),
                    params={"symbols": symbol, "feed": _ALPACA_DATA_FEED},
                    timeout=10
                )
                bar_resp.raise_for_status()
                latest_bar = (bar_resp.json().get("bars", {}) or {}).get(symbol) or {}
                vwap = float(latest_bar.get("vw") or price)
                size = float(trade.get("s") or latest_bar.get("v") or 100)
                cvd = (price - prev_price) * max(size, 1.0)

                return {
                    "coin": symbol,
                    "price": price,
                    "size": size,
                    "side": side,
                    "time": time_ms,
                    "cvd": cvd,
                    "vwap": vwap,
                }
        except Exception as e:
            print(f"Alpaca latest stock tick fallback for {symbol}: {e}", file=sys.stderr)

    # yfinance fallback
    ticker = yf.Ticker(symbol)
    try:
        price = float(ticker.fast_info['lastPrice'])
        if not price or price <= 0:
            raise ValueError("Invalid price in fast_info")
    except Exception:
        df = ticker.history(period="1d", interval="1m")
        if not df.empty:
            price = float(df['Close'].iloc[-1])
        else:
            price = 0.0

    if price <= 0:
        return None

    prev_price = last_prices.get(symbol, price)
    side = "B" if price >= prev_price else "S"
    last_prices[symbol] = price

    import random
    size = random.uniform(10, 500)
    return {
        "coin": symbol,
        "price": price,
        "size": size,
        "side": side,
        "time": int(time.time() * 1000),
        "cvd": (price - prev_price) * 10000.0,
        "vwap": price
    }

def _poll_stocks_loop():
    global _stock_thread_running
    
    # Store last prices to know if price went up or down (for the green/red tick)
    last_prices = {}
    
    while _stock_thread_running:
        with _stock_thread_lock:
            symbols = list(_active_stock_subs.keys())
            
        if not symbols:
            time.sleep(1)
            continue
            
        for symbol in symbols:
            try:
                payload = _fetch_latest_stock_tick(symbol, last_prices)
                if not payload:
                    continue
                
                with _stock_thread_lock:
                    callbacks = list(_active_stock_subs.get(symbol, []))
                    
                for cb in callbacks:
                    try:
                        cb(payload)
                    except Exception:
                        pass
                        
            except Exception as e:
                print(f"Error polling stock {symbol}: {e}", file=sys.stderr)

        # Poll every 2 seconds
        time.sleep(2)


# ─── WEBULL PROVIDER ──────────────────────────────────────────────────────────
# Provides real exchange-tagged tick side (buyer/seller aggressor) for US stocks.
# Uses the shared UAT test credentials by default (WEBULL_TEST_ENV=1).
# Set WEBULL_TEST_ENV=0 + WEBULL_APP_KEY/WEBULL_APP_SECRET for production.

def _webull_timespan(interval):
    """Returns (native_timespan, aggregate_seconds_or_None)."""
    mapping = {
        "1m":  ("M1",   None),
        "3m":  ("M1",   180),    # aggregate 1m → 3m
        "5m":  ("M5",   None),
        "15m": ("M15",  None),
        "30m": ("M30",  None),
        "1h":  ("M60",  None),
        "4h":  ("M240", None),
        "1d":  ("D",    None),
    }
    result = mapping.get(interval)
    if not result:
        raise DataSourceError(f"Unsupported Webull timeframe: {interval}")
    return result


def _fetch_webull_history(symbol, interval):
    try:
        from webull.core.client import ApiClient
        from webull.data.data_client import DataClient
        from webull.data.common.category import Category
    except ImportError:
        raise DataSourceError(
            "webull-openapi-python-sdk not installed. Run: pip install webull-openapi-python-sdk"
        )

    tf_name, aggregate_sec = _webull_timespan(interval)
    try:
        api_client = ApiClient(_WEBULL_APP_KEY, _WEBULL_APP_SECRET, "us")
        api_client.add_endpoint("us", _WEBULL_API_HOST)
        data_client = DataClient(api_client)

        res = data_client.market_data.get_history_bar(
            symbol, Category.US_STOCK.name, tf_name
        )
        if res.status_code != 200:
            raise DataSourceError(f"Webull API {res.status_code}: {res.text[:200]}")

        raw = res.json()
        # Response may be list directly or nested under "data"
        bars_raw = raw.get("data", raw) if isinstance(raw, dict) else raw
        if not isinstance(bars_raw, list):
            bars_raw = []

        result = []
        for b in bars_raw:
            t = b.get("time") or b.get("t")
            if not t:
                continue
            result.append({
                "time":   int(pd.Timestamp(str(t)).timestamp()),
                "open":   float(b.get("open",   b.get("o", 0))),
                "high":   float(b.get("high",   b.get("h", 0))),
                "low":    float(b.get("low",    b.get("l", 0))),
                "close":  float(b.get("close",  b.get("c", 0))),
                "volume": float(b.get("volume", b.get("v", 0))),
            })
        result = sorted(result, key=lambda x: x["time"])
        if aggregate_sec:
            result = aggregate_candles(result, aggregate_sec)
        return result
    except DataSourceError:
        raise
    except Exception as e:
        raise DataSourceError(f"Webull history failed for {symbol}: {e}") from e


def _subscribe_webull_stock(symbol, callback):
    global _webull_stream
    with _webull_lock:
        if symbol not in _webull_subs:
            _webull_subs[symbol] = set()
            _webull_cvd[symbol]  = 0.0
            _webull_vwap[symbol] = {"value": 0.0, "volume": 0.0}
        _webull_subs[symbol].add(callback)

        if _webull_stream is None:
            # Launch stream thread — it will subscribe all pending symbols on connect
            t = threading.Thread(target=_run_webull_stream, daemon=True)
            t.start()
        else:
            # Stream already running — subscribe this symbol immediately
            _webull_stream_subscribe([symbol])


def _unsubscribe_webull_stock(symbol, callback):
    with _webull_lock:
        if symbol in _webull_subs:
            _webull_subs[symbol].discard(callback)
            if not _webull_subs[symbol]:
                del _webull_subs[symbol]
                _webull_cvd.pop(symbol, None)
                _webull_vwap.pop(symbol, None)


def _webull_stream_subscribe(symbols):
    """Subscribe symbols on the active stream client. Call with _webull_lock held or after connect."""
    global _webull_stream
    if not symbols or _webull_stream is None:
        return
    try:
        from webull.data.common.category import Category
        from webull.data.common.subscribe_type import SubscribeType
        _webull_stream.subscribe(
            symbols,
            Category.US_STOCK.name,
            [SubscribeType.TICK.name, SubscribeType.SNAPSHOT.name],
        )
    except Exception as e:
        print(f"Webull subscribe error for {symbols}: {e}", file=sys.stderr)


def _run_webull_stream():
    """Runs in a daemon thread. Connects MQTT stream and loops forever."""
    global _webull_stream
    try:
        from webull.data.data_streaming_client import DataStreamingClient
    except ImportError:
        print("webull-openapi-python-sdk not installed — Webull streaming unavailable. "
              "Run: pip install webull-openapi-python-sdk", file=sys.stderr)
        with _webull_lock:
            _webull_stream = None
        return

    import uuid
    session_id = f"antigravity_{uuid.uuid4().hex[:8]}"
    env_tag = "TEST" if _WEBULL_USE_TEST else "PROD"

    client = DataStreamingClient(
        _WEBULL_APP_KEY,
        _WEBULL_APP_SECRET,
        "us",
        session_id,
        http_host=_WEBULL_API_HOST,
        mqtt_host=_WEBULL_MQTT_HOST,
    )

    def on_connect(cli, api_client, sess_id):
        print(f"Webull MQTT connected [{env_tag}] session={cli.get_session_id()}")
        with _webull_lock:
            symbols = list(_webull_subs.keys())
        if symbols:
            _webull_stream_subscribe(symbols)

    def on_message(cli, topic, quotes):
        _handle_webull_tick(topic, quotes)

    def on_subscribe(cli, api_client, sess_id):
        with _webull_lock:
            syms = list(_webull_subs.keys())
        print(f"Webull subscribed: {syms}")

    client.on_connect_success   = on_connect
    client.on_quotes_message    = on_message
    client.on_subscribe_success = on_subscribe

    with _webull_lock:
        _webull_stream = client

    print(f"Starting Webull MQTT stream [{env_tag}] api={_WEBULL_API_HOST}")
    try:
        client.connect_and_loop_forever()
    except Exception as e:
        print(f"Webull stream error: {e}", file=sys.stderr)
    finally:
        with _webull_lock:
            _webull_stream = None
        print("Webull MQTT stream stopped.")


def _handle_webull_tick(topic, quotes):
    """
    Process incoming Webull tick messages.
    The SDK decodes Protobuf — `quotes` arrives as a list of dicts.
    Tick fields: price, volume, side (B=buyer aggressor, S=seller aggressor), time.
    """
    if not isinstance(quotes, (list, tuple)):
        quotes = [quotes]

    for quote in quotes:
        if not isinstance(quote, dict):
            continue

        # Resolve symbol from payload or topic
        symbol = (
            quote.get("symbol") or quote.get("sym") or
            quote.get("ticker") or ""
        ).upper()
        if not symbol:
            # topic format: "tick/US_STOCK/AAPL" or similar
            parts = str(topic).replace(".", "/").split("/")
            for part in reversed(parts):
                if part and part not in ("US_STOCK", "tick", "snapshot", "quote"):
                    symbol = part.upper()
                    break
        if not symbol:
            continue

        # Extract tick fields — try both full names and single-char keys
        price  = float(quote.get("price")  or quote.get("p")  or 0)
        size   = float(quote.get("volume") or quote.get("size") or quote.get("v") or 0)
        side   = str(quote.get("side")     or quote.get("s")   or "").upper()
        ts_raw = quote.get("time")         or quote.get("t")   or quote.get("tradeTime")

        # Skip non-tick messages (snapshots have no side)
        if not price or not side:
            continue

        time_ms = (
            int(pd.Timestamp(str(ts_raw)).timestamp() * 1000)
            if ts_raw else int(time.time() * 1000)
        )

        # Normalize side to B / S
        if side in ("B", "BUY", "BUYER", "1"):
            norm_side = "B"
        elif side in ("S", "SELL", "SELLER", "2"):
            norm_side = "S"
        else:
            continue  # unknown side — skip

        with _webull_lock:
            if symbol not in _webull_subs:
                continue

            # Update real CVD (exchange-tagged side — not estimated)
            delta = size if norm_side == "B" else -size
            _webull_cvd[symbol] = _webull_cvd.get(symbol, 0.0) + delta

            # Update VWAP accumulator
            acc = _webull_vwap.setdefault(symbol, {"value": 0.0, "volume": 0.0})
            acc["value"]  += price * size
            acc["volume"] += size
            vwap = acc["value"] / acc["volume"] if acc["volume"] > 0 else price

            cvd       = _webull_cvd[symbol]
            callbacks = list(_webull_subs.get(symbol, []))

        payload = {
            "coin":  symbol,
            "price": price,
            "size":  size,
            "side":  norm_side,
            "time":  time_ms,
            "cvd":   cvd,
            "vwap":  vwap,
        }

        for cb in callbacks:
            try:
                cb(payload)
            except Exception as e:
                print(f"Webull callback error [{symbol}]: {e}", file=sys.stderr)
