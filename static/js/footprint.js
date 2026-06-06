'use strict';
// ─── FOOTPRINT CHART ENGINE ──────────────────────────────────────────────────
// Aggregates live tick data (with real side field) into per-price-level
// buy/sell volumes per candle. Renders as canvas overlay on chart.
//
// Features:
//   Bid/Ask mode  — sell vol | buy vol per price level (always-visible cells)
//   Delta mode    — (buy - sell) per price level
//   Zero prints   — levels in candle range with no trades
//   Imbalances    — diagonal 3:1 ratio detection
//   Stacked imb.  — 3+ consecutive imbalanced levels
//   POC per candle— price level with highest volume (gold highlight)
//   Delta diverg. — price/delta non-confirmation markers
//   Absorption    — large vol at level without price movement

const FP_IMBALANCE_RATIO  = 3.0;
const FP_MIN_STACKED      = 3;
const FP_MAX_CANDLES      = 600;
const FP_MIN_ROW_PX       = 6;    // don't render rows thinner than this
const FP_RENDER_MIN_PX    = 12;   // min bar width before footprint hides

const FP_C = {
    buy:               'rgba(0, 230, 118, 0.90)',
    sell:              'rgba(255, 59,  59,  0.90)',
    buyFill:           'rgba(0, 230, 118, 0.22)',
    sellFill:          'rgba(255, 59,  59,  0.22)',
    cellBg:            'rgba(6, 8, 16, 0.78)',
    cellBgPOC:         'rgba(30, 22, 0, 0.85)',
    rowSep:            'rgba(42, 51, 71, 0.40)',
    centerDiv:         'rgba(60, 70, 95, 0.55)',
    pocBorder:         'rgba(255, 200, 0,   0.95)',
    zeroPrint:         'rgba(30, 35, 60,  0.60)',
    imbBuyBgSingle:    'rgba(0,   230, 118, 0.09)',  // single imbalance row
    imbSellBgSingle:   'rgba(255, 59,  59,  0.09)',
    imbBuyBg:          'rgba(0,   230, 118, 0.28)',  // stacked imbalance row
    imbSellBg:         'rgba(255, 59,  59,  0.28)',
    imbBuyStripe:      'rgba(0,   230, 118, 0.95)',  // solid side stripe for stacked
    imbSellStripe:     'rgba(255, 59,  59,  0.95)',
    imbBuyDot:         'rgba(0,   230, 118, 0.85)',
    imbSellDot:        'rgba(255, 59,  59,  0.85)',
    deltaPos:      'rgba(0,   230, 118, 0.30)',
    deltaNeg:      'rgba(255, 59,  59,  0.30)',
    deltaLabel:    'rgba(0,   230, 118, 0.98)',
    deltaLabelNeg: 'rgba(255, 59,  59,  0.98)',
    absorption:    'rgba(255, 200, 0,   0.95)',
    exhaustion:    'rgba(200, 100, 255, 0.95)',
    divBull:       '#00e676',
    divBear:       '#ff3b3b',
    text:          'rgba(220, 230, 245, 0.95)',
    textBuy:       'rgba(100, 240, 160, 0.95)',
    textSell:      'rgba(255, 110, 110, 0.95)',
    textDim:       'rgba(90, 105, 130,  0.70)',
};

// ── Aggregation tick (fine, price-based) — used by fpOnTick to bucket raw trades ──
function fpAutoTickSize(price) {
    if (price >= 50000) return 5;     // BTC: $5 buckets
    if (price >= 10000) return 2;     // ETH: $2
    if (price >= 5000)  return 1;
    if (price >= 1000)  return 0.25;
    if (price >= 100)   return 0.05;
    if (price >= 10)    return 0.01;
    if (price >= 1)     return 0.005;
    return 0.001;
}

// ── Display tick (dynamic, zoom-based) — targets ~14px per row ────────────────
const FP_TARGET_ROW_PX = 14;
function fpDynDisplayTick(pxPerUnit) {
    const raw = FP_TARGET_ROW_PX / Math.max(pxPerUnit, 1e-9);
    const snaps = [0.001,0.002,0.005, 0.01,0.02,0.05,
                   0.1,0.2,0.5, 1,2,5,10,20,25,50,100,200,500];
    for (const s of snaps) { if (raw <= s) return s; }
    return 500;
}

// ── Merge fine aggregation levels → display tick, recompute POC/maxVol ────────
function fpGetView(candle, displayTick) {
    const levels = new Map();
    let maxVol = 0, poc = null;
    for (const [price, lvl] of candle.levels) {
        const bucket = fpSnap(price, displayTick);
        let m = levels.get(bucket);
        if (!m) { m = { buy: 0, sell: 0 }; levels.set(bucket, m); }
        m.buy  += lvl.buy;
        m.sell += lvl.sell;
        const vol = m.buy + m.sell;
        if (vol > maxVol) { maxVol = vol; poc = bucket; }
    }
    return { time: candle.time, levels, totalBuy: candle.totalBuy,
             totalSell: candle.totalSell, delta: candle.delta,
             poc, maxLevelVol: maxVol };
}

function fpSnap(price, tick) {
    return Math.round(price / tick) * tick;
}

// ── Pane initialization ───────────────────────────────────────────────────────
function initFootprintForPane(pane) {
    // Restore saved FP state from localStorage
    let savedFp = {};
    try {
        const cfg = JSON.parse(localStorage.getItem(`pane_config_${pane.id}`) || '{}');
        if (cfg.fp) savedFp = cfg.fp;
    } catch (e) {}

    pane.fp = {
        enabled:       savedFp.enabled  || false,
        mode:          savedFp.mode     || 'bidask',
        tickSize:      savedFp.tickSize || null,
        candles:       new Map(),  // candleTime → FpCandle
        imbalanceRatio: FP_IMBALANCE_RATIO,
        minStacked:    FP_MIN_STACKED,
        showZero:      true,
        showImb:       true,
        showPOC:       true,
        showDiv:       true,
        showAbs:       true,
    };

    // Dedicated canvas — below drawing canvas, above volume profile
    const container = pane.dom.container;
    const fpCanvas = document.createElement('canvas');
    fpCanvas.className = 'footprint-canvas';
    const existing = container.querySelector('.volume-profile-canvas, .drawing-canvas');
    if (existing) {
        container.insertBefore(fpCanvas, existing);
    } else {
        container.appendChild(fpCanvas);
    }
    const rect = container.getBoundingClientRect();
    fpCanvas.width  = rect.width  || 300;
    fpCanvas.height = rect.height || 200;
    pane.fpCanvas = fpCanvas;
}

// ── Tick aggregation ──────────────────────────────────────────────────────────
function fpOnTick(pane, tick) {
    if (!pane.fp || !pane.fp.enabled) return;
    const { price, size, side, time } = tick;
    if (!price || !size || !side) return;

    const fp = pane.fp;
    const ts   = fp.tickSize || fpAutoTickSize(price);
    const lvlP = fpSnap(price, ts);
    const ct   = roundTimestamp(time, pane.timeframe);

    let candle = fp.candles.get(ct);
    if (!candle) {
        candle = { time: ct, levels: new Map(), totalBuy: 0, totalSell: 0, delta: 0, poc: lvlP, maxLevelVol: 0 };
        fp.candles.set(ct, candle);
        if (fp.candles.size > FP_MAX_CANDLES) {
            fp.candles.delete(fp.candles.keys().next().value);
        }
    }

    let lvl = candle.levels.get(lvlP);
    if (!lvl) { lvl = { buy: 0, sell: 0 }; candle.levels.set(lvlP, lvl); }

    if (side === 'B') { lvl.buy += size; candle.totalBuy += size; }
    else              { lvl.sell += size; candle.totalSell += size; }
    candle.delta = candle.totalBuy - candle.totalSell;

    const vol = lvl.buy + lvl.sell;
    if (vol > candle.maxLevelVol) candle.maxLevelVol = vol;
    const pocLvl = candle.levels.get(candle.poc);
    if (!pocLvl || vol > (pocLvl.buy + pocLvl.sell)) candle.poc = lvlP;
}

// ── Imbalance detection ───────────────────────────────────────────────────────
// Diagonal comparison: ask vol at level N vs bid vol at level N-1 (one tick below)
function fpImbalances(candle, ts) {
    const result = new Map();
    const sorted = [...candle.levels.keys()].sort((a, b) => a - b);
    const R = FP_IMBALANCE_RATIO;

    for (let i = 1; i < sorted.length; i++) {
        const lo = sorted[i - 1], hi = sorted[i];
        if (hi - lo > ts * 1.5) continue;
        const lv = candle.levels.get(lo), hv = candle.levels.get(hi);
        if (!lv || !hv) continue;
        // Bid imbalance: buyers at lo dominate sellers at hi (bullish pressure)
        if (hv.sell > 0 && lv.buy / hv.sell >= R) result.set(lo, 'buy');
        // Ask imbalance: sellers at hi dominate buyers at lo (bearish pressure)
        if (lv.buy > 0 && hv.sell / lv.buy >= R) result.set(hi, 'sell');
    }
    return result;
}

function fpStacked(imbMap, sorted, minCount) {
    const stacks = [];
    let run = [], runDir = null;
    for (const p of sorted) {
        const d = imbMap.get(p);
        if (d && d === runDir) {
            run.push(p);
            if (run.length >= minCount) stacks.push({ levels: [...run], direction: runDir });
        } else {
            run = d ? [p] : [];
            runDir = d || null;
        }
    }
    return stacks;
}

// ── Delta divergence ──────────────────────────────────────────────────────────
function fpDivergences(pane) {
    const bars = pane.historyData;
    if (!bars || bars.length < 6) return [];
    const result = [];
    const recent = bars.slice(-30);

    for (let i = 3; i < recent.length; i++) {
        const b = recent[i], bp = recent[i - 3];
        const c = pane.fp.candles.get(b.time);
        const cp = pane.fp.candles.get(bp.time);
        if (!c || !cp) continue;

        // Bearish div: price higher high, delta weakening and negative
        if (b.high > bp.high && c.delta < cp.delta && c.delta < 0) {
            result.push({ time: b.time, type: 'bearish', price: b.high });
        }
        // Bullish div: price lower low, delta strengthening and positive
        if (b.low < bp.low && c.delta > cp.delta && c.delta > 0) {
            result.push({ time: b.time, type: 'bullish', price: b.low });
        }
    }
    return result;
}

// ── Absorption / Exhaustion detection ────────────────────────────────────────
function fpAbsorption(candle, bar, ts) {
    const results = [];
    if (!candle || !bar) return results;
    const avg = candle.maxLevelVol > 0 ? candle.maxLevelVol * 0.5 : 1;
    const threshold = avg * 2;

    // Bid absorption at low: large buy vol but price bounced
    const lowLvl = candle.levels.get(fpSnap(bar.low, ts));
    if (lowLvl && lowLvl.buy >= threshold && bar.close > bar.low * 1.0008) {
        results.push({ type: 'bid_absorption', price: bar.low });
    }

    // Ask exhaustion at high: large sell vol but price rejected
    const highLvl = candle.levels.get(fpSnap(bar.high, ts));
    if (highLvl && highLvl.sell >= threshold && bar.close < bar.high * 0.9992) {
        results.push({ type: 'ask_exhaustion', price: bar.high });
    }

    return results;
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderFootprint(pane) {
    const fp = pane.fp;
    if (!fp) return;

    const canvas = pane.fpCanvas;
    if (!canvas || !pane.chart || !pane.candleSeries) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!fp.enabled) return;

    const bars = pane.historyData;
    if (!bars || bars.length < 2) return;

    const vr = pane.chart.timeScale().getVisibleLogicalRange();
    if (!vr) return;

    const visFrom = Math.max(0, Math.floor(vr.from));
    const visTo   = Math.min(bars.length - 1, Math.ceil(vr.to));

    // Bar width from consecutive x coords
    const xi = Math.max(0, visFrom);
    const xa = Math.min(bars.length - 1, visFrom + 1);
    const xA = pane.chart.timeScale().timeToCoordinate(bars[xi].time);
    const xB = pane.chart.timeScale().timeToCoordinate(bars[xa].time);
    const barWidthPx = (xA !== null && xB !== null) ? Math.abs(xB - xA) : 10;

    if (barWidthPx < FP_RENDER_MIN_PX) return;

    // ── Dynamic display tick — computed once per frame from price scale ──────
    // Targets FP_TARGET_ROW_PX pixels per row regardless of zoom level.
    // Aggregation uses fine fpAutoTickSize; fpGetView merges to display tick.
    let dynTs = fp.tickSize; // respect manual override
    if (!dynTs) {
        const midIdx  = Math.min(Math.floor((visFrom + visTo) / 2), bars.length - 1);
        const refBar  = bars[midIdx];
        const yRef    = pane.candleSeries.priceToCoordinate(refBar.close);
        const yRef1   = pane.candleSeries.priceToCoordinate(refBar.close + 1);
        if (yRef !== null && yRef1 !== null && Math.abs(yRef1 - yRef) > 1e-6) {
            dynTs = fpDynDisplayTick(Math.abs(yRef1 - yRef));
        } else {
            dynTs = fpAutoTickSize(refBar.close);
        }
    }

    const divs = fp.showDiv ? fpDivergences(pane) : [];

    for (let i = visFrom; i <= visTo; i++) {
        const bar     = bars[i];
        const rawCandle = fp.candles.get(bar.time);
        if (!rawCandle || rawCandle.levels.size === 0) continue;

        // Merge fine agg levels → current display tick
        const candle = fpGetView(rawCandle, dynTs);
        if (candle.levels.size === 0) continue;

        const xC = pane.chart.timeScale().timeToCoordinate(bar.time);
        if (xC === null) continue;

        const ts = dynTs;

        // Pixel height per tick row (dynTs ensures ~FP_TARGET_ROW_PX)
        const yLow  = pane.candleSeries.priceToCoordinate(bar.low);
        const yLowP = pane.candleSeries.priceToCoordinate(bar.low + ts);
        if (yLow === null || yLowP === null) continue;
        const rowH = Math.abs(yLowP - yLow);
        if (rowH < FP_MIN_ROW_PX) continue;

        const sorted = [...candle.levels.keys()].sort((a, b) => a - b);
        const imbMap = fp.showImb ? fpImbalances(candle, ts) : new Map();
        const stacks = fp.showImb ? fpStacked(imbMap, sorted, fp.minStacked) : [];
        const stackSet = new Set(stacks.flatMap(s => s.levels));
        const abs = fp.showAbs ? fpAbsorption(candle, bar, ts) : [];

        ctx.save();

        if (fp.mode === 'bidask') {
            _renderBidAsk(ctx, pane, candle, bar, sorted, xC, barWidthPx, rowH, ts, imbMap, stackSet, fp);
        } else {
            _renderDelta(ctx, pane, candle, bar, sorted, xC, barWidthPx, rowH, ts, imbMap, stackSet, fp);
        }

        // Stacked imbalance stripes drawn after cells so they render on top
        if (fp.showImb && stacks.length > 0) {
            _renderStackedStripes(ctx, pane, stacks, xC, barWidthPx, ts);
        }

        if (fp.showAbs) _renderAbs(ctx, pane, abs, xC);
        ctx.restore();
    }

    // Divergence markers on top
    if (fp.showDiv && divs.length > 0) {
        ctx.save();
        _renderDivs(ctx, pane, divs);
        ctx.restore();
    }
}

// ── Bid / Ask render ──────────────────────────────────────────────────────────
// Layout: [SELL cell | BUY cell]
// Each cell = dark background + proportional fill (from outer edge inward) + number
function _renderBidAsk(ctx, pane, candle, bar, sorted, xC, bw, rowH, ts, imbMap, stackSet, fp) {
    // Use up to 96% of bar width, leave a 2% gap each side
    const half = bw * 0.47;
    const maxV = candle.maxLevelVol || 1;

    // Font sizing: scales with row height, min 7px
    const fontSize  = Math.max(7, Math.min(10, Math.floor(rowH * 0.72)));
    const showTxt   = rowH >= FP_MIN_ROW_PX;   // always show if row visible
    const showPrice = bw >= 30;                 // price label when zoomed enough
    if (showTxt) {
        ctx.font = `${fontSize}px "Space Grotesk", monospace`;
        ctx.textBaseline = 'middle';
    }

    // Zero prints (background layer, under cells)
    if (fp.showZero) {
        _renderZero(ctx, pane, candle, bar, xC, half, rowH, ts);
    }

    for (const p of sorted) {
        const lvl = candle.levels.get(p);
        if (!lvl) continue;

        const yMid = pane.candleSeries.priceToCoordinate(p + ts * 0.5);
        if (yMid === null) continue;
        const yTop  = yMid - rowH * 0.5 + 0.5;
        const rowPx = rowH - 1;

        const isPOC   = fp.showPOC && p === candle.poc;
        const imbDir  = imbMap.get(p);
        const isStack = stackSet.has(p);

        // ── Cell backgrounds ──────────────────────────────────────────────────
        ctx.fillStyle = isPOC ? FP_C.cellBgPOC : FP_C.cellBg;
        ctx.fillRect(xC - half, yTop, half * 2, rowPx);

        // Imbalance tints — stacked brighter than single
        if (imbDir) {
            if (isStack) {
                ctx.fillStyle = imbDir === 'buy' ? FP_C.imbBuyBg : FP_C.imbSellBg;
            } else {
                ctx.fillStyle = imbDir === 'buy' ? FP_C.imbBuyBgSingle : FP_C.imbSellBgSingle;
            }
            ctx.fillRect(xC - half, yTop, half * 2, rowPx);
        }

        // ── Volume fills (proportional, from outer edges inward) ──────────────
        // Sell fill: grows from LEFT edge rightward
        const sellFrac = lvl.sell / maxV;
        if (sellFrac > 0) {
            ctx.fillStyle = FP_C.sellFill;
            ctx.fillRect(xC - half, yTop, half * sellFrac, rowPx);
        }

        // Buy fill: grows from RIGHT edge leftward
        const buyFrac = lvl.buy / maxV;
        if (buyFrac > 0) {
            ctx.fillStyle = FP_C.buyFill;
            ctx.fillRect(xC + half * (1 - buyFrac), yTop, half * buyFrac, rowPx);
        }

        // ── Center divider line ───────────────────────────────────────────────
        ctx.strokeStyle = FP_C.centerDiv;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xC, yTop);
        ctx.lineTo(xC, yTop + rowPx);
        ctx.stroke();

        // ── POC border ────────────────────────────────────────────────────────
        if (isPOC) {
            ctx.strokeStyle = FP_C.pocBorder;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.strokeRect(xC - half + 0.5, yTop + 0.5, half * 2 - 1, rowPx - 1);
        }

        // ── Row top separator ─────────────────────────────────────────────────
        ctx.strokeStyle = FP_C.rowSep;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xC - half, yTop);
        ctx.lineTo(xC + half, yTop);
        ctx.stroke();

        // Stacked imbalance continuous stripe rendered after level loop (see _renderStackedStripes)

        // ── Volume text ───────────────────────────────────────────────────────
        if (showTxt) {
            const gapToCentre = 3;

            // Sell (left cell, right-aligned near center)
            ctx.fillStyle = lvl.sell > 0 ? FP_C.textSell : FP_C.textDim;
            ctx.textAlign = 'right';
            ctx.fillText(_fmtV(lvl.sell), xC - gapToCentre, yMid);

            // Buy (right cell, left-aligned near center)
            ctx.fillStyle = lvl.buy > 0 ? FP_C.textBuy : FP_C.textDim;
            ctx.textAlign = 'left';
            ctx.fillText(_fmtV(lvl.buy), xC + gapToCentre, yMid);

            // Price level label — left of sell cell, right-aligned
            if (showPrice) {
                ctx.fillStyle = FP_C.textDim;
                ctx.textAlign = 'right';
                ctx.font = `${Math.max(6, fontSize - 1)}px "Space Grotesk", monospace`;
                ctx.fillText(_fmtPrice(p), xC - half - 2, yMid);
                // restore font for next row
                ctx.font = `${fontSize}px "Space Grotesk", monospace`;
            }
        }
    }

    _renderCandleDelta(ctx, candle, xC, bw, pane.candleSeries.priceToCoordinate(bar.low));
}

// ── Delta render ──────────────────────────────────────────────────────────────
function _renderDelta(ctx, pane, candle, bar, sorted, xC, bw, rowH, ts, imbMap, stackSet, fp) {
    const half = bw * 0.47;
    const maxD = Math.max(1, ...sorted.map(p => {
        const l = candle.levels.get(p);
        return l ? Math.abs(l.buy - l.sell) : 0;
    }));

    const fontSize = Math.max(7, Math.min(10, Math.floor(rowH * 0.72)));
    const showTxt  = rowH >= FP_MIN_ROW_PX;
    if (showTxt) {
        ctx.font = `${fontSize}px "Space Grotesk", monospace`;
        ctx.textBaseline = 'middle';
    }

    if (fp.showZero) _renderZero(ctx, pane, candle, bar, xC, half, rowH, ts);

    for (const p of sorted) {
        const lvl = candle.levels.get(p);
        if (!lvl) continue;

        const yMid = pane.candleSeries.priceToCoordinate(p + ts * 0.5);
        if (yMid === null) continue;
        const yTop  = yMid - rowH * 0.5 + 0.5;
        const rowPx = rowH - 1;
        const d     = lvl.buy - lvl.sell;
        const isPOC = fp.showPOC && p === candle.poc;

        // Dark background
        ctx.fillStyle = isPOC ? FP_C.cellBgPOC : FP_C.cellBg;
        ctx.fillRect(xC - half, yTop, half * 2, rowPx);

        // Delta fill from center
        const dw = (Math.abs(d) / maxD) * half;
        ctx.fillStyle = d >= 0 ? FP_C.deltaPos : FP_C.deltaNeg;
        if (d >= 0) {
            ctx.fillRect(xC, yTop, dw, rowPx);
        } else {
            ctx.fillRect(xC - dw, yTop, dw, rowPx);
        }

        // Row separator
        ctx.strokeStyle = FP_C.rowSep;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xC - half, yTop);
        ctx.lineTo(xC + half, yTop);
        ctx.stroke();

        // POC border
        if (isPOC) {
            ctx.strokeStyle = FP_C.pocBorder;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.strokeRect(xC - half + 0.5, yTop + 0.5, half * 2 - 1, rowPx - 1);
        }

        if (showTxt) {
            const sign = d >= 0 ? '+' : '';
            ctx.fillStyle = d >= 0 ? FP_C.deltaLabel : FP_C.deltaLabelNeg;
            ctx.textAlign = 'center';
            ctx.fillText(`${sign}${_fmtV(d)}`, xC, yMid);
        }
    }

    _renderCandleDelta(ctx, candle, xC, bw, pane.candleSeries.priceToCoordinate(bar.low));
}

// ── Stacked imbalance continuous side stripe ──────────────────────────────────
// Draws a solid colored bar outside the candle spanning all levels in each stack.
// Buy stacks → green stripe on RIGHT edge; Sell stacks → red stripe on LEFT edge.
function _renderStackedStripes(ctx, pane, stacks, xC, bw, ts) {
    if (!stacks || stacks.length === 0) return;
    const half     = bw * 0.47;
    const stripeW  = Math.max(2, Math.min(5, bw * 0.10));

    for (const stack of stacks) {
        const { levels, direction } = stack;
        // levels is sorted ascending; top of stack = levels.last + ts, bottom = levels[0]
        const topPrice = levels[levels.length - 1] + ts;
        const botPrice = levels[0];

        const yTop = pane.candleSeries.priceToCoordinate(topPrice);
        const yBot = pane.candleSeries.priceToCoordinate(botPrice);
        if (yTop === null || yBot === null) continue;

        const sY = Math.min(yTop, yBot);
        const sH = Math.abs(yBot - yTop);
        if (sH < 2) continue;

        ctx.fillStyle = direction === 'buy' ? FP_C.imbBuyStripe : FP_C.imbSellStripe;
        const sX = direction === 'buy' ? xC + half : xC - half - stripeW;
        ctx.fillRect(sX, sY, stripeW, sH);
    }
}

// ── Zero prints ───────────────────────────────────────────────────────────────
function _renderZero(ctx, pane, candle, bar, xC, half, rowH, ts) {
    const numLevels = Math.ceil((bar.high - bar.low) / ts) + 1;
    for (let i = 0; i <= numLevels; i++) {
        const p = fpSnap(bar.low + i * ts, ts);
        if (candle.levels.has(p)) continue;
        const yMid = pane.candleSeries.priceToCoordinate(p + ts * 0.5);
        if (yMid === null) continue;
        const yTop = yMid - rowH * 0.5 + 0.5;
        ctx.fillStyle = FP_C.zeroPrint;
        ctx.fillRect(xC - half, yTop, half * 2, rowH - 1);
    }
}

// ── Candle delta footer label ─────────────────────────────────────────────────
function _renderCandleDelta(ctx, candle, xC, bw, yBot) {
    if (yBot === null || bw < 16) return;
    const d = candle.delta;
    const sign = d >= 0 ? '+' : '';
    ctx.font = 'bold 9px "Space Grotesk", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = d >= 0 ? FP_C.deltaLabel : FP_C.deltaLabelNeg;
    ctx.fillText(`${sign}${_fmtV(d)}`, xC, yBot + 3);
}

// ── Absorption markers ────────────────────────────────────────────────────────
function _renderAbs(ctx, pane, absorptions, xC) {
    for (const a of absorptions) {
        const y = pane.candleSeries.priceToCoordinate(a.price);
        if (y === null) continue;

        if (a.type === 'bid_absorption') {
            ctx.fillStyle = FP_C.absorption;
            ctx.beginPath();
            ctx.moveTo(xC,     y + 6);
            ctx.lineTo(xC - 5, y + 12);
            ctx.lineTo(xC + 5, y + 12);
            ctx.closePath();
            ctx.fill();
            ctx.font = 'bold 8px "Space Grotesk", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = FP_C.absorption;
            ctx.fillText('ABS', xC, y + 14);
        } else {
            ctx.fillStyle = FP_C.exhaustion;
            ctx.beginPath();
            ctx.moveTo(xC,     y - 6);
            ctx.lineTo(xC - 5, y - 12);
            ctx.lineTo(xC + 5, y - 12);
            ctx.closePath();
            ctx.fill();
            ctx.font = 'bold 8px "Space Grotesk", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = FP_C.exhaustion;
            ctx.fillText('EXH', xC, y - 13);
        }
    }
}

// ── Divergence markers ────────────────────────────────────────────────────────
function _renderDivs(ctx, pane, divs) {
    for (const d of divs) {
        const x = pane.chart.timeScale().timeToCoordinate(d.time);
        const y = pane.candleSeries.priceToCoordinate(d.price);
        if (x === null || y === null) continue;

        const isBull = d.type === 'bullish';
        ctx.fillStyle   = isBull ? FP_C.divBull : FP_C.divBear;
        ctx.strokeStyle = isBull ? FP_C.divBull : FP_C.divBear;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([3, 2]);

        const ay = isBull ? y + 18 : y - 18;
        ctx.beginPath();
        ctx.moveTo(x, isBull ? y + 4 : y - 4);
        ctx.lineTo(x, ay);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 9px "Space Grotesk", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = isBull ? 'top' : 'bottom';
        ctx.fillText(isBull ? 'DIV↑' : 'DIV↓', x, isBull ? ay + 1 : ay - 1);
    }
}

// ── UI controls ───────────────────────────────────────────────────────────────
function addFootprintControls(pane) {
    if (document.getElementById(`${pane.id}-fp-wrap`)) return;
    const toolbar = document.querySelector(`#${pane.id} .pane-toolbar`);
    if (!toolbar) return;

    const wrap = document.createElement('div');
    wrap.id = `${pane.id}-fp-wrap`;
    wrap.className = 'fp-control-wrap';

    wrap.innerHTML = `
        <button class="fp-btn fp-toggle-btn" id="${pane.id}-fp-toggle" title="Toggle Footprint Chart">FP</button>
        <select class="fp-mode-select" id="${pane.id}-fp-mode" title="Footprint display mode">
            <option value="bidask">B/A</option>
            <option value="delta">Δ</option>
        </select>
    `;

    wrap.querySelector('.fp-toggle-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        fpToggle(pane);
    });
    wrap.querySelector('.fp-mode-select').addEventListener('change', (e) => {
        e.stopPropagation();
        fpSetMode(pane, e.target.value);
    });

    toolbar.appendChild(wrap);

    // Sync button/select to restored state
    if (pane.fp) {
        const btn = document.getElementById(`${pane.id}-fp-toggle`);
        if (btn) btn.classList.toggle('active', !!pane.fp.enabled);
        const sel = document.getElementById(`${pane.id}-fp-mode`);
        if (sel) sel.value = pane.fp.mode || 'bidask';
    }
}

function _fpSaveState(pane) {
    try {
        const existing = JSON.parse(localStorage.getItem(`pane_config_${pane.id}`) || '{}');
        existing.fp = { enabled: pane.fp.enabled, mode: pane.fp.mode, tickSize: pane.fp.tickSize };
        localStorage.setItem(`pane_config_${pane.id}`, JSON.stringify(existing));
    } catch (e) {}
}

function fpToggle(pane) {
    if (!pane.fp) initFootprintForPane(pane);
    pane.fp.enabled = !pane.fp.enabled;
    const btn = document.getElementById(`${pane.id}-fp-toggle`);
    if (btn) btn.classList.toggle('active', pane.fp.enabled);
    _fpSaveState(pane);
    renderFootprint(pane);
}

function fpSetMode(pane, mode) {
    if (!pane.fp) return;
    pane.fp.mode = mode;
    _fpSaveState(pane);
    renderFootprint(pane);
}

// ── Price level format helper ─────────────────────────────────────────────────
// Compact: 97050 → "97.1K", 1234 → "1234", 97.5 → "97.5"
function _fmtPrice(p) {
    if (p >= 10000) return (p / 1000).toFixed(1) + 'K';
    if (p >= 1000)  return p.toFixed(0);
    if (p >= 100)   return p.toFixed(1);
    if (p >= 10)    return p.toFixed(2);
    return p.toFixed(3);
}

// ── Volume format helper ──────────────────────────────────────────────────────
function _fmtV(v) {
    const a = Math.abs(v);
    const prefix = v < 0 ? '-' : '';
    if (a >= 1e6)  return prefix + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1000) return prefix + (a / 1000).toFixed(1) + 'K';
    if (a >= 10)   return prefix + a.toFixed(0);
    if (a >= 1)    return prefix + a.toFixed(1);
    return prefix + a.toFixed(3);
}
