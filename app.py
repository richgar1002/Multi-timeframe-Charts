import json
import sys
import queue
import threading
import socket
import subprocess
from pathlib import Path
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
from flask_sock import Sock
import data_source
import regime_engine

app = Flask(__name__, static_folder="static", static_url_path="/static")
sock = Sock(app)

# Regime engine instances: pane_id -> PaneRegimeEngine
_pane_regimes = {}
_regime_lock = threading.Lock()

VALID_TIMEFRAMES = {"1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"}


@app.after_request
def disable_local_cache(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# Serve the index.html from templates folder or root
@app.route("/")
def index():
    return send_from_directory("templates", "index.html")

@app.route("/api/log", methods=["POST"])
def client_log():
    data = request.json or {}
    msg = f"\n>>> [BROWSER CONSOLE] {data.get('level', 'info').upper()}: {data.get('message')}\n"
    print(msg, file=sys.stderr)
    # Also append to file for persistence
    with open("/tmp/mtfc_browser_errors.log", "a") as f:
        f.write(f"{datetime.now().isoformat()} {msg}")
    return "", 204

@app.route("/api/history")
def history():
    symbol = request.args.get("symbol")
    timeframe = request.args.get("timeframe", "1m")
    
    if not symbol:
        return jsonify({"error": "Symbol parameter is required"}), 400
    if timeframe not in VALID_TIMEFRAMES:
        return jsonify({"error": f"Unsupported timeframe: {timeframe}"}), 400
        
    try:
        data = data_source.get_historical_data(symbol, timeframe)
        return jsonify(data)
    except data_source.DataSourceError as e:
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/regime/init", methods=["POST"])
def regime_init():
    """Initialize regime engine for a pane from its canonical bar history.

    Request body (JSON):
        paneId     : pane identifier
        symbol     : symbol name
        timeframe  : chart timeframe
        bars       : list of {time, open, high, low, close, volume}
    """
    body = request.json or {}
    pane_id    = body.get("paneId")
    symbol     = body.get("symbol")
    timeframe  = body.get("timeframe")
    bars       = body.get("bars", [])

    if not pane_id or not symbol or not timeframe:
        return jsonify({"error": "paneId, symbol, and timeframe are required"}), 400
    if timeframe not in regime_engine.SUPPORTED_TIMEFRAMES:
        return jsonify({
            "error": f"Unsupported regime timeframe: {timeframe}",
            "supported": list(regime_engine.SUPPORTED_TIMEFRAMES)
        }), 400

    try:
        engine = regime_engine.PaneRegimeEngine(symbol, timeframe, bars)
        with _regime_lock:
            _pane_regimes[pane_id] = engine

        state = engine.get_display_state()
        return jsonify({
            "paneId": pane_id,
            "initialized": engine.is_initialized,
            "supported": engine.is_supported,
            "state": state,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/regime/bar_close", methods=["POST"])
def regime_bar_close():
    """Append a confirmed closed bar to a pane's regime engine, or refresh state without a new bar.

    Request body (JSON):
        paneId : pane identifier
        bar    : {time, open, high, low, close, volume}  (optional — null refreshes state)
    """
    body = request.json or {}
    pane_id = body.get("paneId")
    bar     = body.get("bar")

    if not pane_id:
        return jsonify({"error": "paneId is required"}), 400

    with _regime_lock:
        engine = _pane_regimes.get(pane_id)

    if engine is None or not engine.is_supported:
        return jsonify({"error": "Regime not supported for this pane"}), 404
    if not engine.is_initialized:
        return jsonify({"error": "Regime not initialized"}), 409

    try:
        if bar is not None:
            engine.append_bar(bar)
            engine.on_bar_close(bar)

        state = engine.get_display_state()
        return jsonify({"paneId": pane_id, "state": state})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/regime/reset", methods=["POST"])
def regime_reset():
    """Reset regime engine for a pane (on symbol/timeframe change or pane rebuild).

    Request body (JSON):
        paneId    : pane identifier
        symbol    : new symbol (optional)
        timeframe : new timeframe (optional)
        bars      : new bar history (optional, for full re-init)
    """
    body = request.json or {}
    pane_id    = body.get("paneId")
    symbol     = body.get("symbol")
    timeframe  = body.get("timeframe")
    bars       = body.get("bars", [])

    if not pane_id:
        return jsonify({"error": "paneId is required"}), 400

    with _regime_lock:
        engine = _pane_regimes.get(pane_id)

    if engine is not None:
        engine.reset(symbol=symbol, timeframe=timeframe, ohlcv_bars=bars if bars else None)
        state = engine.get_display_state()
    else:
        state = {"status": "warming_up", "label": "Unknown", "confidence": 0,
                 "is_pending": False, "pending_label": None, "bars_in_current": 0, "prev_regimes": []}

    return jsonify({
        "paneId": pane_id,
        "state": state,
        "initialized": engine.is_initialized if engine else False,
        "supported": engine.is_supported if engine else (timeframe in regime_engine.SUPPORTED_TIMEFRAMES if timeframe else True),
    })


@app.route("/api/regime/destroy", methods=["POST"])
def regime_destroy():
    """Destroy regime engine for a pane — called when regime is disabled or pane is removed."""
    body = request.json or {}
    pane_id = body.get("paneId")

    if not pane_id:
        return jsonify({"error": "paneId is required"}), 400

    with _regime_lock:
        if pane_id in _pane_regimes:
            del _pane_regimes[pane_id]

    return jsonify({"paneId": pane_id, "destroyed": True})


@sock.route("/ws")
def ws_handler(ws):
    print("New WebSocket client connected.")
    
    # Track subscriptions for this specific connection:
    # pane_id -> { "symbol": symbol, "timeframe": timeframe, "callback": callback_func }
    subscriptions = {}
    outgoing = queue.Queue()
    stop_event = threading.Event()

    def sender_loop():
        while not stop_event.is_set():
            try:
                payload = outgoing.get(timeout=0.5)
            except queue.Empty:
                continue

            if payload is None:
                break

            try:
                ws.send(payload)
            except Exception as e:
                print(f"Error sending WS payload: {e}", file=sys.stderr)
                stop_event.set()
                break

    sender_thread = threading.Thread(target=sender_loop, daemon=True)
    sender_thread.start()
    
    def create_callback(pane_id):
        def callback(tick_data):
            try:
                outgoing.put_nowait(json.dumps({
                    "type": "tick",
                    "paneId": pane_id,
                    "data": tick_data
                }))
            except Exception:
                # Connection might be closed, it will be cleaned up in the main loop
                pass
        return callback

    try:
        while not stop_event.is_set():
            raw_msg = ws.receive()
            if not raw_msg:
                break
                
            try:
                msg = json.loads(raw_msg)
                action = msg.get("action")
                pane_id = msg.get("paneId")
                symbol = msg.get("symbol")
                timeframe = msg.get("timeframe", "1m")
                
                if not pane_id:
                    continue
                    
                if action == "subscribe" and symbol:
                    # 1. Check if this pane is already subscribed
                    if pane_id in subscriptions:
                        old_sub = subscriptions[pane_id]
                        # If subscription is unchanged, do nothing
                        if old_sub["symbol"] == symbol and old_sub["timeframe"] == timeframe:
                            continue
                        # Otherwise, unsubscribe from old
                        print(f"Unsubscribing {pane_id} from {old_sub['symbol']} ({old_sub['timeframe']})")
                        data_source.unsubscribe_live(old_sub["symbol"], old_sub["timeframe"], old_sub["callback"])
                        del subscriptions[pane_id]
                    
                    # 2. Subscribe to new symbol
                    print(f"Subscribing {pane_id} to {symbol} ({timeframe})")
                    cb = create_callback(pane_id)
                    data_source.subscribe_live(symbol, timeframe, cb)
                    
                    subscriptions[pane_id] = {
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "callback": cb
                    }
                    
                elif action == "unsubscribe":
                    if pane_id in subscriptions:
                        sub = subscriptions[pane_id]
                        print(f"Unsubscribing {pane_id} from {sub['symbol']} ({sub['timeframe']})")
                        data_source.unsubscribe_live(sub["symbol"], sub["timeframe"], sub["callback"])
                        del subscriptions[pane_id]
                        
            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f"Error handling WS message: {e}", file=sys.stderr)
                
    finally:
        print("WebSocket client disconnected. Cleaning up subscriptions...")
        stop_event.set()
        outgoing.put(None)
        # Unsubscribe all active feeds for this socket connection
        for pane_id, sub in list(subscriptions.items()):
            try:
                data_source.unsubscribe_live(sub["symbol"], sub["timeframe"], sub["callback"])
            except Exception as e:
                print(f"Error clean-sub: {e}", file=sys.stderr)
        subscriptions.clear()
        sender_thread.join(timeout=1)

if __name__ == "__main__":
    # Port 5000 exhibits a local routing quirk for the regime endpoints in this environment.
    # Serve the real app on 5002 and keep 5000 as a separate lightweight redirect process.
    def port_is_open(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            return sock.connect_ex(("127.0.0.1", port)) == 0

    redirect_script = Path(__file__).with_name("redirect_5000.py")
    if redirect_script.exists() and not port_is_open(5000):
        subprocess.Popen(
            [sys.executable, str(redirect_script)],
            cwd=str(Path(__file__).parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # Disable the reloader to avoid duplicate background subscription state in debug sessions.
    app.run(host="0.0.0.0", port=5002, debug=False, use_reloader=False)
