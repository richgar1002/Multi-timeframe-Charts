// Dashboard State
const state = {
    gridCount: 3,
    panes: {}, // paneId -> paneObject
    socket: null,
    fullscreenPaneId: null,
    symbolsPreset: [
        // US Stocks
        { symbol: "AAPL", name: "Apple Inc.", type: "stock" },
        { symbol: "MSFT", name: "Microsoft Corp.", type: "stock" },
        { symbol: "NVDA", name: "Nvidia Corp.", type: "stock" },
        { symbol: "TSLA", name: "Tesla Inc.", type: "stock" },
        { symbol: "SPY", name: "S&P 500 ETF", type: "stock" },
        // Cryptos (Hyperliquid)
        { symbol: "BTC", name: "Bitcoin", type: "crypto" },
        { symbol: "ETH", name: "Ethereum", type: "crypto" },
        { symbol: "SOL", name: "Solana", type: "crypto" },
        { symbol: "HYPE", name: "Hyperliquid", type: "crypto" },
        { symbol: "PURR", name: "Purr Coin", type: "crypto" },
        { symbol: "ARB", name: "Arbitrum", type: "crypto" }
    ],
    timeframes: [
        { value: "1m", label: "1 Min" },
        { value: "3m", label: "3 Min" },
        { value: "5m", label: "5 Min" },
        { value: "15m", label: "15 Min" },
        { value: "30m", label: "30 Min" },
        { value: "1h", label: "1 Hour" },
        { value: "4h", label: "4 Hours" },
        { value: "1d", label: "1 Day" }
    ]
};

const VALID_GRID_COUNTS = new Set([1, 2, 3, '3M', 6, 9, 12, 24]);
const CRYPTO_SYMBOLS = new Set(["BTC", "ETH", "SOL", "ARB", "HYPE", "PURR", "LINK", "AVAX", "SUI", "APT", "OP"]);
const NEW_YORK_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
});
const NY_TIME_ONLY_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: false
});
const NY_MONTH_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric"
});
const NY_YEAR_MONTH_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric"
});

function normalizeGridCount(count) {
    const str = String(count);
    if (VALID_GRID_COUNTS.has(str)) return str;
    const parsed = Number(str);
    return VALID_GRID_COUNTS.has(parsed) ? parsed : 3;
}

function gridPaneCount(gridCount) {
    if (gridCount === '3M') return 3;
    return Number(gridCount);
}

function normalizeIndicatorConfig(indicators = {}) {
    const normalized = { ...indicators };
    const settings = { ...(indicators.settings || {}) };

    if (normalized.ema9 !== undefined && normalized.ema10 === undefined) normalized.ema10 = normalized.ema9;
    if (normalized.sma50 !== undefined && normalized.ema50 === undefined) normalized.ema50 = normalized.sma50;
    if (settings.ema9Period !== undefined && settings.ema10Period === undefined) settings.ema10Period = settings.ema9Period;
    if (settings.sma50Period !== undefined && settings.ema50Period === undefined) settings.ema50Period = settings.sma50Period;

    delete normalized.ema9;
    delete normalized.sma50;
    delete normalized.cvd;
    delete normalized.rsi;
    delete normalized.macd;
    delete settings.ema9Period;
    delete settings.sma50Period;
    delete settings.rsiPeriod;
    delete settings.macdFast;
    delete settings.macdSlow;
    delete settings.macdSignal;

    normalized.settings = settings;
    return normalized;
}

// --- SYSTEM INITIALIZATION ---

document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    initWebSocket();
    initGrid();
    setInterval(updateBarTimers, 1000);
    
    // Grid count selector event listener
    const gridSelect = document.getElementById("grid-count-select");
    gridSelect.value = state.gridCount.toString();
    gridSelect.addEventListener("change", (e) => {
        updateGridCount(e.target.value);
    });

    // Window resize event handler
    window.addEventListener("resize", () => {
        resizeAllCharts();
    });
});

// --- GRID MANAGEMENT ---

function initGrid() {
    const gridContainer = document.getElementById("chart-grid");
    state.fullscreenPaneId = null;
    document.body.classList.remove("fullscreen-active");
    
    // Set grid layout class
    const gc = state.gridCount;
    const paneCount = gridPaneCount(gc);
    const layoutClasses = [`grid-${gc}`];
    if (Number(gc) >= 6) layoutClasses.push("grid-compact");
    if (Number(gc) >= 12) layoutClasses.push("grid-dense");
    gridContainer.className = layoutClasses.join(" ");
    gridContainer.dataset.layout = String(gc);
    gridContainer.innerHTML = "";

    // Clear old charts if any
    Object.values(state.panes).forEach(pane => {
        if (pane.chart) {
            if (pane.resizeObserver) {
                pane.resizeObserver.disconnect();
            }
            pane.chart.remove();
        }
        // Destroy backend regime instance for this pane
        if (pane.indicators && pane.indicators.regime) {
            fetch("/api/regime/destroy", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({paneId: pane.id})
            }).catch(() => {});
        }
    });

    const oldPanes = { ...state.panes };
    state.panes = {};

    // Create new panes
    for (let i = 1; i <= paneCount; i++) {
        const paneId = `pane-${i}`;
        
        // Restore previous pane config if available, otherwise default
        let symbol = "BTC";
        let timeframe = "1m";
        let indicators = {
            vwap: true,
            volumeProfile: false,
            ema10: false,
            ema20: false,
            ema50: false,
            ema100: false,
            ema200: false,
            bbands: false,
            vwrsi: false,
            vwmacd: false,
            bvd: false,
            deltaProfile: false,
            atr: false,
            divergence: false,
            regime: true,
            vol: false,
            settings: {
                ema10Period: 10,
                ema20Period: 20,
                ema50Period: 50,
                ema100Period: 100,
                ema200Period: 200,
                bbPeriod: 20,
                bbStdDev: 2,
                vwrsiPeriod: 14,
                vwmacdFast: 12,
                vwmacdSlow: 26,
                vwmacdSignal: 9,
                atrPeriod: 14,
                vpBins: 48,
                vpWidth: 22,
                vpValueAreaPct: 70,
                vpDetail: 8,
                showVertGrid: true,
                showHorzGrid: true,
                oscillatorHeightPct: 22,
                oscillatorHeights: {}
            }
        };

        if (oldPanes[paneId]) {
            symbol = oldPanes[paneId].symbol;
            timeframe = oldPanes[paneId].timeframe;
            indicators = normalizeIndicatorConfig(oldPanes[paneId].indicators || indicators);
        } else {
            try {
                const savedPane = localStorage.getItem(`pane_config_${paneId}`);
                if (savedPane) {
                    const config = JSON.parse(savedPane);
                    symbol = config.symbol || symbol;
                    timeframe = config.timeframe || timeframe;
                    if (config.indicators) {
                        indicators = { ...indicators, ...normalizeIndicatorConfig(config.indicators) };
                    }
                } else {
                    // Distribute some initial presets across charts
                    if (i === 1) symbol = "BTC";
                    if (i === 2) symbol = "ETH";
                    if (i === 3) symbol = "AAPL";
                    if (i === 4) symbol = "TSLA";
                    if (i === 5) symbol = "SOL";
                    if (i === 6) symbol = "HYPE";
                }
            } catch (e) {
                console.warn(`Failed to parse pane configuration for ${paneId}`, e);
            }
        }
        
        indicators.regime = true;
        createChartPane(paneId, symbol, timeframe, indicators);
    }

    saveSettings();
}

function updateGridCount(count) {
    state.gridCount = normalizeGridCount(count);
    initGrid();
    
    // Send subscription messages for all new/reconfigured panes
    Object.values(state.panes).forEach(pane => {
        sendSubscription(pane.id, pane.symbol, pane.timeframe);
    });
}

function getVolumeProfileSourceTimeframe(chartTimeframe) {
    switch (chartTimeframe) {
        case "1d":
        case "4h":
            return "15m";
        case "1h":
            return "5m";
        default:
            return chartTimeframe;
    }
}

function getTimeframeDurationSeconds(timeframe) {
    switch (timeframe) {
        case "1m": return 60;
        case "3m": return 180;
        case "5m": return 300;
        case "15m": return 900;
        case "30m": return 1800;
        case "1h": return 3600;
        case "4h": return 14400;
        case "1d": return 86400;
        default: return 60;
    }
}

function isCryptoSymbol(symbol) {
    const clean = String(symbol || "").trim().toUpperCase();
    return CRYPTO_SYMBOLS.has(clean) || clean.endsWith("USD") || clean.endsWith("USDT");
}

function getNewYorkDateParts(unixSeconds) {
    const parts = NEW_YORK_FORMATTER.formatToParts(new Date(unixSeconds * 1000));

    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
        dateKey: `${values.year}-${values.month}-${values.day}`,
        minutes: parseInt(values.hour, 10) * 60 + parseInt(values.minute, 10)
    };
}

function getDailyVolumeProfileBars(pane, sourceBars) {
    if (!sourceBars || sourceBars.length === 0) {
        return [];
    }

    if (isCryptoSymbol(pane.symbol)) {
        const latestBar = sourceBars[sourceBars.length - 1];
        const sessionStart = Math.floor(latestBar.time / 86400) * 86400;
        const sessionEnd = sessionStart + 86400;
        return sourceBars.filter(bar => bar.time >= sessionStart && bar.time < sessionEnd);
    }

    const regularSessionBars = sourceBars.filter(bar => {
        const session = getNewYorkDateParts(bar.time);
        return session.minutes >= 570 && session.minutes <= 960;
    });

    const sessionGroups = new Map();
    regularSessionBars.forEach(bar => {
        const session = getNewYorkDateParts(bar.time).dateKey;
        if (!sessionGroups.has(session)) {
            sessionGroups.set(session, []);
        }
        sessionGroups.get(session).push(bar);
    });

    const sessionKeys = Array.from(sessionGroups.keys()).sort();
    if (sessionKeys.length > 0) {
        const latestSessionKey = sessionKeys[sessionKeys.length - 1];
        const latestSessionBars = sessionGroups.get(latestSessionKey) || [];

        let estimatedBarsPerSession = 78;
        if (latestSessionBars.length >= 2) {
            const intervalSeconds = Math.max(60, latestSessionBars[1].time - latestSessionBars[0].time);
            estimatedBarsPerSession = Math.max(1, Math.round((6.5 * 60 * 60) / intervalSeconds));
        }

        const sessionCompletionThreshold = Math.max(8, Math.floor(estimatedBarsPerSession * 0.7));
        const usePreviousCompletedSession = (
            latestSessionBars.length < sessionCompletionThreshold &&
            sessionKeys.length > 1
        );

        const targetSessionKey = usePreviousCompletedSession
            ? sessionKeys[sessionKeys.length - 2]
            : latestSessionKey;

        return sessionGroups.get(targetSessionKey) || latestSessionBars;
    }

    const latestDate = getNewYorkDateParts(sourceBars[sourceBars.length - 1].time).dateKey;
    return sourceBars.filter(bar => getNewYorkDateParts(bar.time).dateKey === latestDate);
}

function getDailySessionGroups(pane, sourceBars) {
    if (!sourceBars || sourceBars.length === 0) {
        return [];
    }

    const visibleRange = pane.chart?.timeScale?.().getVisibleRange?.() || null;
    const timeframePadding = getTimeframeDurationSeconds(getVolumeProfileSourceTimeframe(pane.timeframe));
    const visibleSessionKeys = new Set();

    if (visibleRange && typeof visibleRange.from === "number" && typeof visibleRange.to === "number") {
        sourceBars.forEach(bar => {
            if (bar.time < visibleRange.from - timeframePadding || bar.time > visibleRange.to + timeframePadding) {
                return;
            }

            if (isCryptoSymbol(pane.symbol)) {
                visibleSessionKeys.add(String(Math.floor(bar.time / 86400)));
            } else {
                const session = getNewYorkDateParts(bar.time);
                if (session.minutes >= 570 && session.minutes <= 960) {
                    visibleSessionKeys.add(session.dateKey);
                }
            }
        });
    }

    const groups = new Map();

    if (isCryptoSymbol(pane.symbol)) {
        sourceBars.forEach(bar => {
            const dayKey = String(Math.floor(bar.time / 86400));
            if (visibleSessionKeys.size > 0 && !visibleSessionKeys.has(dayKey)) {
                return;
            }
            if (!groups.has(dayKey)) {
                groups.set(dayKey, []);
            }
            groups.get(dayKey).push(bar);
        });
    } else {
        sourceBars.forEach(bar => {
            const session = getNewYorkDateParts(bar.time);
            if (session.minutes < 570 || session.minutes > 960) {
                return;
            }
            if (visibleSessionKeys.size > 0 && !visibleSessionKeys.has(session.dateKey)) {
                return;
            }
            if (!groups.has(session.dateKey)) {
                groups.set(session.dateKey, []);
            }
            groups.get(session.dateKey).push(bar);
        });
    }

    const keys = Array.from(groups.keys()).sort();
    return keys.map((key, index) => {
        const bars = groups.get(key) || [];
        return {
            key,
            bars,
            startTime: bars[0]?.time ?? null,
            endTime: bars[bars.length - 1]?.time ?? null,
            isCurrent: index === keys.length - 1
        };
    }).filter(group => group.bars.length > 0 && group.startTime !== null && group.endTime !== null);
}

function getDayStartTimes(pane, bars) {
    if (!bars || bars.length === 0) {
        return [];
    }

    if (isCryptoSymbol(pane.symbol)) {
        const seenDays = new Set();
        const boundaries = [];
        bars.forEach(bar => {
            const dayKey = Math.floor(bar.time / 86400);
            if (!seenDays.has(dayKey)) {
                seenDays.add(dayKey);
                boundaries.push(bar.time);
            }
        });
        return boundaries;
    }

    const seenSessions = new Set();
    const boundaries = [];
    bars.forEach(bar => {
        const session = getNewYorkDateParts(bar.time);
        if (session.minutes < 570 || session.minutes > 960) {
            return;
        }
        if (!seenSessions.has(session.dateKey)) {
            seenSessions.add(session.dateKey);
            boundaries.push(bar.time);
        }
    });
    return boundaries;
}

function formatChartTickMark(pane, time) {
    if (typeof time !== "number") {
        return "";
    }

    const date = new Date(time * 1000);
    if (isCryptoSymbol(pane.symbol)) {
        if (pane.timeframe === "1d") {
            return NY_MONTH_DAY_FORMATTER.format(date);
        }
        if (pane.timeframe === "4h") {
            return `${NY_MONTH_DAY_FORMATTER.format(date)} ${NY_TIME_ONLY_FORMATTER.format(date)}`;
        }
        return NY_TIME_ONLY_FORMATTER.format(date);
    }

    if (pane.timeframe === "1d") {
        return NY_MONTH_DAY_FORMATTER.format(date);
    }
    if (pane.timeframe === "4h") {
        return `${NY_MONTH_DAY_FORMATTER.format(date)} ${NY_TIME_ONLY_FORMATTER.format(date)}`;
    }
    if (pane.timeframe === "1h" || pane.timeframe === "30m" || pane.timeframe === "15m" || pane.timeframe === "5m" || pane.timeframe === "3m" || pane.timeframe === "1m") {
        return NY_TIME_ONLY_FORMATTER.format(date);
    }

    return NY_YEAR_MONTH_DAY_FORMATTER.format(date);
}

function resizeAllCharts() {
    Object.values(state.panes).forEach(pane => {
        if (!pane.chart) return;
        const rect = pane.dom.container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            pane.chart.resize(rect.width, rect.height);
            requestVolumeProfileDraw(pane);
        }
    });
}

function formatCountdown(totalSeconds) {
    const safe = Math.max(0, totalSeconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateBarTimers() {
    const nowSec = Math.floor(Date.now() / 1000);
    Object.values(state.panes).forEach(pane => {
        if (!pane.dom.barTimer) return;
        if (!pane.lastBar || !pane.lastBar.time) {
            pane.dom.barTimer.textContent = "--:--";
            return;
        }

        const closeTime = pane.lastBar.time + getTimeframeDurationSeconds(pane.timeframe);
        pane.dom.barTimer.textContent = formatCountdown(closeTime - nowSec);
    });
}

function scheduleLayoutRefresh() {
    requestAnimationFrame(() => {
        resizeAllCharts();
        requestAnimationFrame(() => {
            resizeAllCharts();
        });
    });

    setTimeout(() => {
        resizeAllCharts();
    }, 120);
}

function requestVolumeProfileDraw(pane) {
    if (!pane || pane.volumeProfileDrawScheduled) return;
    pane.volumeProfileDrawScheduled = true;

    requestAnimationFrame(() => {
        pane.volumeProfileDrawScheduled = false;
        drawVolumeProfile(pane);
    });
}

function buildVolumeProfileModelForBars(profileBars, settings) {
    if (!profileBars || profileBars.length === 0) {
        return null;
    }

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    profileBars.forEach(bar => {
        if (bar.low < minPrice) minPrice = bar.low;
        if (bar.high > maxPrice) maxPrice = bar.high;
    });

    if (minPrice === Infinity || maxPrice === -Infinity || minPrice === maxPrice) {
        return null;
    }

    const numBins = settings.vpBins || 24;
    const binSize = (maxPrice - minPrice) / numBins;
    const bins = Array(numBins).fill(0);
    const detail = Math.max(1, Math.round(settings.vpDetail || 4));
    const valueAreaTarget = Math.min(0.95, Math.max(0.4, (settings.vpValueAreaPct || 68) / 100));

    profileBars.forEach(bar => {
        const priceLow = Math.max(minPrice, bar.low);
        const priceHigh = Math.min(maxPrice, bar.high);
        const range = Math.max(priceHigh - priceLow, binSize);
        const slices = Math.max(1, Math.min(numBins * 2, Math.ceil(detail * (range / binSize))));
        const volPerSlice = (bar.volume || 0) / slices;

        for (let i = 0; i < slices; i++) {
            const pricePoint = slices === 1
                ? (priceLow + priceHigh) / 2
                : priceLow + ((i + 0.5) / slices) * range;
            const binIndex = Math.max(0, Math.min(numBins - 1, Math.floor((pricePoint - minPrice) / binSize)));
            bins[binIndex] += volPerSlice;
        }
    });

    let maxVol = 0;
    let pocBinIndex = 0;
    bins.forEach((vol, idx) => {
        if (vol > maxVol) {
            maxVol = vol;
            pocBinIndex = idx;
        }
    });

    const totalVol = bins.reduce((sum, vol) => sum + vol, 0);
    let valueAreaLow = pocBinIndex;
    let valueAreaHigh = pocBinIndex;
    let accumulatedValueArea = bins[pocBinIndex] || 0;

    while (
        accumulatedValueArea < totalVol * valueAreaTarget &&
        (valueAreaLow > 0 || valueAreaHigh < numBins - 1)
    ) {
        const nextLow = valueAreaLow > 0 ? bins[valueAreaLow - 1] : -1;
        const nextHigh = valueAreaHigh < numBins - 1 ? bins[valueAreaHigh + 1] : -1;

        if (nextHigh >= nextLow) {
            valueAreaHigh += 1;
            accumulatedValueArea += Math.max(0, bins[valueAreaHigh] || 0);
        } else {
            valueAreaLow -= 1;
            accumulatedValueArea += Math.max(0, bins[valueAreaLow] || 0);
        }
    }

    return {
        bins,
        minPrice,
        maxPrice,
        maxVol,
        binSize,
        pocBinIndex,
        valueAreaLow,
        valueAreaHigh
    };
}

// --- PANE GENERATION & CHART CONFIGURATION ---

function createChartPane(paneId, initialSymbol, initialTimeframe, initialIndicators) {
    const gridContainer = document.getElementById("chart-grid");

    const indicatorRow = (indicator, label, settingsGroup = "") => `
        <div class="indicator-row">
            ${settingsGroup
                ? `<button class="indicator-settings-btn" type="button" data-settings-group="${settingsGroup}" title="${label} settings">⚙</button>`
                : `<span class="indicator-settings-spacer"></span>`}
            <label class="menu-label"><input type="checkbox" data-indicator="${indicator}"> ${label}</label>
        </div>
    `;
    
    // Create HTML template structure
    const paneDiv = document.createElement("div");
    paneDiv.className = "chart-pane";
    paneDiv.id = paneId;
    
    paneDiv.innerHTML = `
        <div class="ticker-bar" id="${paneId}-ticker">
            <div class="pane-info">
                <span class="pane-symbol" id="${paneId}-sym-label">${initialSymbol}</span>
                <span class="pane-timeframe" id="${paneId}-tf-label">${initialTimeframe}</span>
            </div>
            <div class="pane-price-wrapper">
                <div class="pane-price-row">
                    <span class="pane-price" id="${paneId}-price-label">--</span>
                    <div class="pane-bar-timer-wrap">
                        <span class="pane-bar-timer" id="${paneId}-bar-timer">--:--</span>
                    </div>
                </div>
                <div class="regime-module" id="${paneId}-regime-module">
                    <span class="regime-label" id="${paneId}-regime-label">--</span>
                    <span class="regime-confidence" id="${paneId}-regime-confidence"></span>
                    <span class="regime-status" id="${paneId}-regime-status"></span>
                    <span class="regime-age" id="${paneId}-regime-age"></span>
                </div>
            </div>
            <div class="pane-metrics">
                <div class="metric-item">
                    <span class="metric-label" id="${paneId}-cvd-label">CVD</span>
                    <span class="metric-value" id="${paneId}-cvd-val">--</span>
                </div>
                <div class="metric-item">
                    <span class="metric-label">VWAP</span>
                    <span class="metric-value" id="${paneId}-vwap-val">--</span>
                </div>
                <div class="metric-item metric-hidden" id="${paneId}-atr-metric">
                    <span class="metric-label" id="${paneId}-atr-label">ATR(14)</span>
                    <span class="metric-value" id="${paneId}-atr-val">--</span>
                </div>
                <div class="metric-item metric-hidden" id="${paneId}-vol-metric">
                    <span class="metric-label">VOL</span>
                    <span class="metric-value vol-bucket" id="${paneId}-vol-bucket">--</span>
                    <span class="metric-value vol-hv" id="${paneId}-vol-hv"></span>
                </div>
            </div>
        </div>
        <div class="pane-toolbar">
            <div class="select-wrapper">
                <select id="${paneId}-preset-select">
                    <option value="">-- Presets --</option>
                    ${state.symbolsPreset.map(s => `<option value="${s.symbol}">${s.symbol} (${s.name})</option>`).join("")}
                </select>
            </div>
            <div class="symbol-input-wrapper">
                <input type="text" id="${paneId}-custom-input" class="symbol-input" placeholder="Custom Ticker..." value="${initialSymbol}">
            </div>
            <div class="select-wrapper">
                <select id="${paneId}-tf-select">
                    ${state.timeframes.map(t => `<option value="${t.value}">${t.label}</option>`).join("")}
                </select>
            </div>
            <button class="pane-action-btn" id="${paneId}-fullscreen-btn" title="Toggle fullscreen">⛶ Focus</button>
            <div class="indicator-menu-container">
                <button class="indicator-btn" id="${paneId}-ind-btn">⚡ Indicators</button>
                <div class="indicator-menu" id="${paneId}-ind-menu">
                    <div class="indicator-menu-scroll">
                    <div class="menu-title">Overlays</div>
                    ${indicatorRow("vwap", "VWAP")}
                    ${indicatorRow("volumeProfile", "Volume Profile", "vp")}
                    ${indicatorRow("ema10", "EMA 10", "ma")}
                    ${indicatorRow("ema20", "EMA 20", "ma")}
                    ${indicatorRow("ema50", "EMA 50", "ma")}
                    ${indicatorRow("ema100", "EMA 100", "ma")}
                    ${indicatorRow("ema200", "EMA 200", "ma")}
                    ${indicatorRow("bbands", "Bollinger Bands", "bb")}
                    <div class="menu-divider"></div>
                    <div class="menu-title">Oscillators</div>
                    ${indicatorRow("vwrsi", "VW-RSI", "vwrsi")}
                    ${indicatorRow("vwmacd", "VW-MACD", "vwmacd")}
                    ${indicatorRow("bvd", "Bar Vol Delta")}
                    ${indicatorRow("atr", "ATR")}
                    ${indicatorRow("divergence", "Divergence")}
                    <div class="menu-divider"></div>
                    <div class="menu-title">Context</div>
                    ${indicatorRow("regime", "Regime Detector")}
                    ${indicatorRow("vol", "Volatility Study")}
                    <div class="menu-divider"></div>
                    <div class="menu-title">Chart</div>
                    <div class="quick-settings-group">
                        <div class="settings-row settings-toggle-row">
                            <label for="${paneId}-quick-delta-profile">Delta Profile</label>
                            <input type="checkbox" id="${paneId}-quick-delta-profile" data-indicator="deltaProfile">
                        </div>
                        <div class="settings-row settings-toggle-row">
                            <label for="${paneId}-quick-vert-grid">Vertical Grid</label>
                            <input type="checkbox" id="${paneId}-quick-vert-grid" data-setting="showVertGrid">
                        </div>
                        <div class="settings-row settings-toggle-row">
                            <label for="${paneId}-quick-horz-grid">Horizontal Grid</label>
                            <input type="checkbox" id="${paneId}-quick-horz-grid" data-setting="showHorzGrid">
                        </div>
                        <div class="settings-row settings-range-row">
                            <label for="${paneId}-subchart-size">Subchart Size</label>
                            <div class="settings-range-control">
                                <input type="range" id="${paneId}-subchart-size" data-setting="oscillatorHeightPct" min="12" max="42" step="1">
                                <span class="settings-value" data-setting-value="oscillatorHeightPct">22%</span>
                            </div>
                        </div>
                        <div class="settings-row settings-range-row">
                            <label for="${paneId}-vp-width">Profile Width</label>
                            <div class="settings-range-control">
                                <input type="range" id="${paneId}-vp-width" data-setting="vpWidth" min="10" max="38" step="1">
                                <span class="settings-value" data-setting-value="vpWidth">22%</span>
                            </div>
                        </div>
                        <div class="settings-row settings-range-row">
                            <label for="${paneId}-va-pct">Value Area %</label>
                            <div class="settings-range-control">
                                <input type="range" id="${paneId}-va-pct" data-setting="vpValueAreaPct" min="40" max="95" step="1">
                                <span class="settings-value" data-setting-value="vpValueAreaPct">70%</span>
                            </div>
                        </div>
                    </div>
                    </div>
                    <div class="settings-pane" id="${paneId}-sett-pane">
                        <div class="settings-group" data-settings-group="ma">
                            <span class="settings-group-title">Exponential Moving Averages</span>
                            <div class="settings-row">
                                <label>EMA 10:</label>
                                <input type="number" data-setting="ema10Period" min="1" max="200">
                            </div>
                            <div class="settings-row">
                                <label>EMA 20:</label>
                                <input type="number" data-setting="ema20Period" min="1" max="200">
                            </div>
                            <div class="settings-row">
                                <label>EMA 50:</label>
                                <input type="number" data-setting="ema50Period" min="1" max="500">
                            </div>
                            <div class="settings-row">
                                <label>EMA 100:</label>
                                <input type="number" data-setting="ema100Period" min="1" max="500">
                            </div>
                            <div class="settings-row">
                                <label>EMA 200:</label>
                                <input type="number" data-setting="ema200Period" min="1" max="500">
                            </div>
                        </div>
                        <div class="settings-group" data-settings-group="vwrsi">
                            <span class="settings-group-title">VW-RSI</span>
                            <div class="settings-row">
                                <label>VW-RSI:</label>
                                <input type="number" data-setting="vwrsiPeriod" min="1" max="100">
                            </div>
                        </div>
                        <div class="settings-group" data-settings-group="vwmacd">
                            <span class="settings-group-title">VW-MACD</span>
                            <div class="settings-row">
                                <label>VW-MACD:</label>
                                <div class="settings-inputs">
                                    <input type="number" data-setting="vwmacdFast" min="1" max="100">
                                    <input type="number" data-setting="vwmacdSlow" min="1" max="100">
                                    <input type="number" data-setting="vwmacdSignal" min="1" max="100">
                                </div>
                            </div>
                        </div>
                        <div class="settings-group" data-settings-group="bb">
                            <span class="settings-group-title">Bollinger Bands</span>
                            <div class="settings-row">
                                <label>Period:</label>
                                <input type="number" data-setting="bbPeriod" min="1" max="100">
                            </div>
                            <div class="settings-row">
                                <label>Std Dev:</label>
                                <input type="number" data-setting="bbStdDev" step="0.1" min="0.1" max="10">
                            </div>
                        </div>
                        <div class="settings-group" data-settings-group="atr">
                            <span class="settings-group-title">ATR</span>
                            <div class="settings-row">
                                <label>Period:</label>
                                <input type="number" data-setting="atrPeriod" min="1" max="100">
                            </div>
                        </div>
                        <div class="settings-group" data-settings-group="vp">
                            <span class="settings-group-title">Volume Profile</span>
                            <div class="settings-row">
                                <label>Bins:</label>
                                <input type="number" data-setting="vpBins" min="5" max="100">
                            </div>
                            <div class="settings-row">
                                <label>Width %:</label>
                                <input type="number" data-setting="vpWidth" min="5" max="50">
                            </div>
                            <div class="settings-row">
                                <label>Value Area %:</label>
                                <input type="number" data-setting="vpValueAreaPct" min="40" max="95" step="1">
                            </div>
                            <div class="settings-row">
                                <label>Detail:</label>
                                <input type="number" data-setting="vpDetail" min="1" max="12" step="1">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="pane-body" id="${paneId}-body">
            <!-- Main chart area: Delta | Candles+Footprint | VP -->
            <div class="chart-main-area" id="${paneId}-main-area">
                <div class="of-left-panel" id="${paneId}-of-panel">
                    <canvas class="delta-canvas" id="${paneId}-delta-canvas"></canvas>
                </div>
                <div class="chart-column" id="${paneId}-chart-col">
                    <div class="chart-container-inner" id="${paneId}-container"></div>
                    <div class="pane-loading" id="${paneId}-loading">Loading data...</div>
                </div>
                <div class="vp-right-panel" id="${paneId}-vp-right">
                    <canvas class="vp-canvas" id="${paneId}-vp-canvas"></canvas>
                </div>
            </div>
            <!-- Subchart oscillator area (panels shown/hidden when toggled) -->
            <div class="subcharts-area" id="${paneId}-subcharts"></div>
            <!-- Time axis at the very bottom -->
            <div class="time-axis" id="${paneId}-time-axis">
                <canvas class="time-axis-canvas" id="${paneId}-time-canvas"></canvas>
            </div>
        </div>
    `;
    
    gridContainer.appendChild(paneDiv);
    
    // Keep DOM references
    const paneObj = {
        id: paneId,
        symbol: initialSymbol.toUpperCase(),
        timeframe: initialTimeframe,
        indicators: initialIndicators,
        rootEl: paneDiv,
        chart: null,
        candleSeries: null,
        cvdSeries: null,
        vwrsiSeries: null,
        vwMacdLineSeries: null,
        vwMacdSignalSeries: null,
        vwMacdHistSeries: null,
        vwapSeries: null,
        ema10Series: null,
        ema20Series: null,
        ema50Series: null,
        ema100Series: null,
        ema200Series: null,
        bbUpperSeries: null,
        bbMiddleSeries: null,
        bbLowerSeries: null,
        atrSeries: null,
        divergenceMarkers: [],
        volumeProfileCanvas: null,
        decorationOverlay: null,
        subchartOverlay: null,
        lastBar: null,
        lastPrice: 0,
        lastCvd: 0,
        historyData: [],
        volumeProfileData: [],
        subchartPanels: {},  // {oscId: {panel, canvas, ctx, height, ...}}
        subchartData: {},    // cached oscillator data for redraw on scroll
        dom: {
            container:  document.getElementById(`${paneId}-container`),
            body:       document.getElementById(`${paneId}-body`),
            mainArea:   document.getElementById(`${paneId}-main-area`),
            ofPanel:    document.getElementById(`${paneId}-of-panel`),
            deltaCanvas:document.getElementById(`${paneId}-delta-canvas`),
            chartCol:   document.getElementById(`${paneId}-chart-col`),
            vpRight:    document.getElementById(`${paneId}-vp-right`),
            vpCanvas:   document.getElementById(`${paneId}-vp-canvas`),
            subchartsArea:document.getElementById(`${paneId}-subcharts`),
            timeAxis:   document.getElementById(`${paneId}-time-axis`),
            timeCanvas: document.getElementById(`${paneId}-time-canvas`),
            loading:    document.getElementById(`${paneId}-loading`),
            priceLabel: document.getElementById(`${paneId}-price-label`),
            cvdValue: document.getElementById(`${paneId}-cvd-val`),
            cvdLabel: document.getElementById(`${paneId}-cvd-label`),
            vwapValue: document.getElementById(`${paneId}-vwap-val`),
            atrMetric: document.getElementById(`${paneId}-atr-metric`),
            atrLabel: document.getElementById(`${paneId}-atr-label`),
            atrValue: document.getElementById(`${paneId}-atr-val`),
            volMetric: document.getElementById(`${paneId}-vol-metric`),
            volBucket: document.getElementById(`${paneId}-vol-bucket`),
            volHv:     document.getElementById(`${paneId}-vol-hv`),
            barTimer: document.getElementById(`${paneId}-bar-timer`),
            symLabel: document.getElementById(`${paneId}-sym-label`),
            tfLabel: document.getElementById(`${paneId}-tf-label`),
            presetSelect: document.getElementById(`${paneId}-preset-select`),
            customInput: document.getElementById(`${paneId}-custom-input`),
            tfSelect: document.getElementById(`${paneId}-tf-select`),
            fullscreenBtn: document.getElementById(`${paneId}-fullscreen-btn`)
        }
    };
    
    state.panes[paneId] = paneObj;

    // Load saved drawings
    try {
        const savedDrawings = localStorage.getItem(`symbol_drawings_${initialSymbol.toUpperCase()}`);
        if (savedDrawings) paneObj.drawings = JSON.parse(savedDrawings);
    } catch (e) { paneObj.drawings = []; }

    // Initialize Lightweight Chart
    initLightweightChart(paneObj);
    
    // Initialize Form values
    paneObj.dom.presetSelect.value = state.symbolsPreset.some(s => s.symbol === paneObj.symbol) ? paneObj.symbol : "";
    paneObj.dom.tfSelect.value = paneObj.timeframe;
    
    // Wire UI events
    paneObj.dom.presetSelect.addEventListener("change", (e) => {
        if (e.target.value) {
            paneObj.dom.customInput.value = e.target.value;
            updatePaneSymbol(paneObj, e.target.value);
        }
    });
    
    paneObj.dom.customInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const sym = e.target.value.trim().toUpperCase();
            if (sym) {
                paneObj.dom.presetSelect.value = state.symbolsPreset.some(s => s.symbol === sym) ? sym : "";
                updatePaneSymbol(paneObj, sym);
            }
        }
    });
    
    paneObj.dom.tfSelect.addEventListener("change", (e) => {
        updatePaneTimeframe(paneObj, e.target.value);
    });
    
    // Wire Indicator Menu UI
    const indMenu = document.getElementById(`${paneId}-ind-menu`);
    const indBtn = document.getElementById(`${paneId}-ind-btn`);
    const settPane = document.getElementById(`${paneId}-sett-pane`);
    
    // Set checked states
    indMenu.querySelector('[data-indicator="vwap"]').checked = paneObj.indicators.vwap;
    indMenu.querySelector('[data-indicator="volumeProfile"]').checked = paneObj.indicators.volumeProfile || false;
    indMenu.querySelector('[data-indicator="ema10"]').checked = paneObj.indicators.ema10;
    indMenu.querySelector('[data-indicator="ema20"]').checked = paneObj.indicators.ema20;
    indMenu.querySelector('[data-indicator="ema50"]').checked = paneObj.indicators.ema50;
    indMenu.querySelector('[data-indicator="ema100"]').checked = paneObj.indicators.ema100 || false;
    indMenu.querySelector('[data-indicator="ema200"]').checked = paneObj.indicators.ema200 || false;
    indMenu.querySelector('[data-indicator="bbands"]').checked = paneObj.indicators.bbands;
    
    // Checkboxes for oscillators
    indMenu.querySelector('[data-indicator="vwrsi"]').checked = paneObj.indicators.vwrsi || false;
    indMenu.querySelector('[data-indicator="vwmacd"]').checked = paneObj.indicators.vwmacd || false;
    indMenu.querySelector('[data-indicator="atr"]').checked = paneObj.indicators.atr || false;
    indMenu.querySelector('[data-indicator="bvd"]').checked = paneObj.indicators.bvd || false;
    indMenu.querySelector('[data-indicator="deltaProfile"]').checked = paneObj.indicators.deltaProfile || false;
    indMenu.querySelector('[data-indicator="divergence"]').checked = paneObj.indicators.divergence || false;
    indMenu.querySelector('[data-indicator="regime"]').checked = paneObj.indicators.regime || false;
    indMenu.querySelector('[data-indicator="vol"]').checked = paneObj.indicators.vol || false;
    
    // Load setting inputs from indicators settings
    const defaultSettings = {
        ema10Period: 10, ema20Period: 20, ema50Period: 50, ema100Period: 100, ema200Period: 200,
        bbPeriod: 20, bbStdDev: 2,
        vwrsiPeriod: 14,
        vwmacdFast: 12, vwmacdSlow: 26, vwmacdSignal: 9,
        atrPeriod: 14,
        vpBins: 48, vpWidth: 22, vpValueAreaPct: 68, vpDetail: 8,
        showVertGrid: true, showHorzGrid: true, oscillatorHeightPct: 22,
        oscillatorHeights: {}
    };
    const settings = { ...defaultSettings, ...(paneObj.indicators.settings || {}) };
    if (settings.vpBins === 24) settings.vpBins = 48;
    if (settings.vpDetail === 4) settings.vpDetail = 8;
    paneObj.indicators.settings = settings; // Save resolved settings reference
    
    indMenu.querySelectorAll('.settings-row input').forEach(input => {
        const key = input.getAttribute("data-setting");
        if (settings[key] !== undefined) {
            input.value = settings[key];
        }
    });
    indMenu.querySelectorAll('input[type="checkbox"][data-setting]').forEach(input => {
        const key = input.getAttribute("data-setting");
        if (settings[key] !== undefined) {
            input.checked = !!settings[key];
        }
    });
    indMenu.querySelectorAll("[data-setting-value]").forEach(label => {
        const key = label.getAttribute("data-setting-value");
        if (settings[key] !== undefined) {
            const val = settings[key];
            label.textContent = key === "oscillatorHeightPct" ? `${val}%` : (key === "vpWidth" ? `${val}%` : (key === "vpValueAreaPct" ? `${val}%` : String(val)));
        }
    });
    
    updateIndicatorBtnState(paneObj);

    paneObj.dom.fullscreenBtn.addEventListener("click", () => {
        togglePaneFullscreen(paneObj);
    });
    
    indBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        Object.values(state.panes).forEach(otherPane => {
            if (otherPane.id !== paneId) {
                otherPane.rootEl.classList.remove("menu-open");
            }
        });
        document.querySelectorAll(".indicator-menu").forEach(menu => {
            if (menu.id !== `${paneId}-ind-menu`) {
                menu.classList.remove("show");
            }
        });
        const shouldShow = !indMenu.classList.contains("show");
        paneObj.rootEl.classList.toggle("menu-open", shouldShow);
        indMenu.classList.toggle("show", shouldShow);
    });
    
    const closeSettingsPane = () => {
        settPane.classList.remove("show");
        delete settPane.dataset.activeGroup;
    };

    // Prevent dropdown closing when clicking settings fields
    settPane.addEventListener("click", (e) => {
        e.stopPropagation();
    });

    indMenu.querySelectorAll('.indicator-settings-btn').forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const group = btn.getAttribute("data-settings-group");
            const groups = settPane.querySelectorAll('.settings-group');
            groups.forEach(el => {
                el.style.display = el.getAttribute("data-settings-group") === group ? "" : "none";
            });
            const shouldShow = settPane.dataset.activeGroup !== group || !settPane.classList.contains("show");
            settPane.classList.toggle("show", shouldShow);
            if (shouldShow) {
                settPane.dataset.activeGroup = group;
            } else {
                delete settPane.dataset.activeGroup;
            }
        });
    });
    
    indMenu.querySelectorAll('input[type="checkbox"][data-indicator]').forEach(cb => {
        cb.addEventListener("change", (e) => {
            const indName = e.target.getAttribute("data-indicator");
            paneObj.indicators[indName] = e.target.checked;
            updateIndicatorBtnState(paneObj);
            localStorage.setItem(`pane_config_${paneId}`, JSON.stringify({
                symbol: paneObj.symbol,
                timeframe: paneObj.timeframe,
                indicators: paneObj.indicators
            }));
            if (indName !== "divergence") {
                closeSettingsPane();
            }
            applyIndicators(paneObj);
        });
    });
    
    indMenu.querySelectorAll('input[data-setting]').forEach(input => {
        const handler = (e) => {
            const key = e.target.getAttribute("data-setting");
            let val;

            if (e.target.type === "checkbox") {
                val = e.target.checked;
            } else {
                val = parseFloat(e.target.value);
                if (isNaN(val)) return;
                if (e.target.min && val < parseFloat(e.target.min)) val = parseFloat(e.target.min);
                if (e.target.max && val > parseFloat(e.target.max)) val = parseFloat(e.target.max);
            }

            paneObj.indicators.settings[key] = val;
            if (key === "oscillatorHeightPct") {
                paneObj.indicators.settings.oscillatorHeights = {};
            }
            indMenu.querySelectorAll(`[data-setting-value="${key}"]`).forEach(label => {
                label.textContent = key === "oscillatorHeightPct" ? `${val}%` : (key === "vpWidth" ? `${val}%` : (key === "vpValueAreaPct" ? `${val}%` : String(val)));
            });

            localStorage.setItem(`pane_config_${paneId}`, JSON.stringify({
                symbol: paneObj.symbol,
                timeframe: paneObj.timeframe,
                indicators: paneObj.indicators
            }));

            applyIndicators(paneObj);
        };

        input.addEventListener(input.type === "checkbox" ? "change" : "input", handler);
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
        });
    });

    indMenu.addEventListener("click", (e) => {
        e.stopPropagation();
    });

    document.addEventListener("click", () => {
        indMenu.classList.remove("show");
        paneObj.rootEl.classList.remove("menu-open");
        closeSettingsPane();
    });
    
    // Load data
    loadHistoricalData(paneObj);
}

function togglePaneFullscreen(pane) {
    const isActive = state.fullscreenPaneId === pane.id;
    if (isActive) {
        state.fullscreenPaneId = null;
        document.body.classList.remove("fullscreen-active");
        initGrid();
        return;
    }

    state.fullscreenPaneId = pane.id;
    document.body.classList.add("fullscreen-active");

    Object.values(state.panes).forEach(currentPane => {
        const focused = state.fullscreenPaneId === currentPane.id;
        currentPane.rootEl.classList.toggle("fullscreen-pane", focused);
        currentPane.dom.fullscreenBtn.textContent = focused ? "⤫ Exit" : "⛶ Focus";
    });

    scheduleLayoutRefresh();
}

// --- DRAWING TOOLS ---

const DRAWING_TOOLS = [
    { id: 'cursor',  icon: '↖', title: 'Select / Move' },
    { id: 'hline',   icon: '─', title: 'Horizontal Line' },
    { id: 'vline',   icon: '│', title: 'Vertical Line' },
    { id: 'line',    icon: '╱', title: 'Trend Line' },
    { id: 'ray',     icon: '⟶', title: 'Ray' },
    { id: 'rect',    icon: '▭', title: 'Rectangle' },
    { id: 'measure', icon: '↔', title: 'Measure' },
];

function pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitTestDrawing(pane, cx, cy) {
    const HANDLE_R = 10;
    const BODY_TOL = 8;
    const drawings = pane.drawings || [];
    for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i];
        const p = d.points;
        for (let h = 0; h < p.length; h++) {
            const hpx = chartCoordsToPixel(pane, p[h].price, p[h].time);
            if (hpx && Math.hypot(cx - hpx.x, cy - hpx.y) <= HANDLE_R) {
                return { drawingId: d.id, handleIdx: h };
            }
        }
        const type = d.type;
        let hit = false;
        if (type === 'hline' && p[0]) {
            const hy = pane.candleSeries ? pane.candleSeries.priceToCoordinate(p[0].price) : null;
            if (hy !== null && Math.abs(cy - hy) <= BODY_TOL) hit = true;
        } else if (type === 'vline' && p[0]) {
            const hpx = chartCoordsToPixel(pane, p[0].price, p[0].time);
            if (hpx && Math.abs(cx - hpx.x) <= BODY_TOL) hit = true;
        } else if ((type === 'line' || type === 'ray') && p[0] && p[1]) {
            const px1 = chartCoordsToPixel(pane, p[0].price, p[0].time);
            const px2 = chartCoordsToPixel(pane, p[1].price, p[1].time);
            if (px1 && px2 && pointToSegmentDist(cx, cy, px1.x, px1.y, px2.x, px2.y) <= BODY_TOL) hit = true;
        } else if (type === 'rect' && p[0] && p[1]) {
            const px1 = chartCoordsToPixel(pane, p[0].price, p[0].time);
            const px2 = chartCoordsToPixel(pane, p[1].price, p[1].time);
            if (px1 && px2) {
                const x1 = Math.min(px1.x, px2.x), x2 = Math.max(px1.x, px2.x);
                const y1 = Math.min(px1.y, px2.y), y2 = Math.max(px1.y, px2.y);
                if ((Math.abs(cx - x1) <= BODY_TOL && cy >= y1 && cy <= y2) ||
                    (Math.abs(cx - x2) <= BODY_TOL && cy >= y1 && cy <= y2) ||
                    (Math.abs(cy - y1) <= BODY_TOL && cx >= x1 && cx <= x2) ||
                    (Math.abs(cy - y2) <= BODY_TOL && cx >= x1 && cx <= x2)) hit = true;
            }
        }
        if (hit) return { drawingId: d.id, handleIdx: -1 };
    }
    return null;
}

function initDrawingTools(pane) {
    const container = pane.dom.container;

    const drawingCanvas = document.createElement('canvas');
    drawingCanvas.className = 'drawing-canvas';
    container.appendChild(drawingCanvas);
    pane.drawingCanvas = drawingCanvas;

    const captureLayer = document.createElement('div');
    captureLayer.className = 'drawing-capture-layer';
    captureLayer.style.pointerEvents = 'none';
    container.appendChild(captureLayer);
    pane.drawingCaptureLayer = captureLayer;

    // Left-side toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'drawing-toolbar';

    DRAWING_TOOLS.forEach(tool => {
        const btn = document.createElement('button');
        btn.className = 'drawing-tool-btn' + (tool.id === 'cursor' ? ' active' : '');
        btn.dataset.tool = tool.id;
        btn.title = tool.title;
        btn.textContent = tool.icon;
        btn.addEventListener('click', (e) => { e.stopPropagation(); setDrawingTool(pane, tool.id); });
        toolbar.appendChild(btn);
    });

    const sep = document.createElement('div');
    sep.className = 'drawing-tool-divider';
    toolbar.appendChild(sep);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'drawing-tool-btn drawing-tool-clear';
    clearBtn.title = 'Clear All Drawings';
    clearBtn.textContent = '✕';
    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pane.drawings = [];
        pane.drawingInProgress = null;
        pane.selectedDrawingId = null;
        pane.drawingDragState = null;
        renderDrawings(pane);
        localStorage.setItem(`symbol_drawings_${pane.symbol}`, '[]');
    });
    toolbar.appendChild(clearBtn);

    // Inject toolbar as first flex child of chart-main-area (left column)
    const paneBody = pane.dom.mainArea || pane.dom.body || container;
    paneBody.insertBefore(toolbar, paneBody.firstChild);
    pane.drawingToolbar = toolbar;
    pane.activeTool = 'cursor';
    pane.drawingInProgress = null;
    pane.selectedDrawingId = null;
    pane.drawingDragState = null;
    if (!Array.isArray(pane.drawings)) pane.drawings = [];

    // Document-level CAPTURE mousedown — fires before LWC's own listeners on the container.
    // When cursor tool is active, intercepts clicks on drawings for selection/drag.
    pane._onDocSelectDown = (e) => {
        if (pane.activeTool !== 'cursor') return;
        if (!container.contains(e.target)) return;
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = hitTestDrawing(pane, x, y);
        if (hit) {
            e.stopPropagation();
            pane.selectedDrawingId = hit.drawingId;
            const d = pane.drawings.find(d => d.id === hit.drawingId);
            if (d) {
                const coords = pixelToChartCoords(pane, x, y);
                pane.drawingDragState = {
                    drawingId: hit.drawingId,
                    type: hit.handleIdx >= 0 ? 'handle' : 'move',
                    handleIdx: hit.handleIdx,
                    startMouseCoords: coords,
                    startPoints: d.points.map(p => ({ ...p }))
                };
            }
        } else {
            pane.selectedDrawingId = null;
            pane.drawingDragState = null;
        }
        renderDrawings(pane);
    };

    // Document-level mousemove: drag updating + hover cursor hint
    pane._onDocMouseMove = (e) => {
        if (pane.activeTool !== 'cursor') return;
        const rect = container.getBoundingClientRect();
        if (pane.drawingDragState) {
            const ds = pane.drawingDragState;
            const coords = pixelToChartCoords(pane, e.clientX - rect.left, e.clientY - rect.top);
            if (!coords) return;
            const d = pane.drawings.find(d => d.id === ds.drawingId);
            if (!d) return;
            if (ds.type === 'handle') {
                d.points[ds.handleIdx] = coords;
            } else {
                const dprice = coords.price - ds.startMouseCoords.price;
                const dtime  = coords.time  - ds.startMouseCoords.time;
                d.points = ds.startPoints.map(p => ({ price: p.price + dprice, time: p.time + dtime }));
            }
            renderDrawings(pane);
        } else if (container.contains(e.target)) {
            const hit = hitTestDrawing(pane, e.clientX - rect.left, e.clientY - rect.top);
            container.style.cursor = hit ? (hit.handleIdx >= 0 ? 'crosshair' : 'move') : '';
        }
    };

    pane._onDocMouseUp = () => {
        if (!pane.drawingDragState) return;
        pane.drawingDragState = null;
        localStorage.setItem(`symbol_drawings_${pane.symbol}`, JSON.stringify(pane.drawings));
        renderDrawings(pane);
    };
    pane._onDocKeyDown = (e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && pane.selectedDrawingId !== null) {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
            pane.drawings = pane.drawings.filter(d => d.id !== pane.selectedDrawingId);
            pane.selectedDrawingId = null;
            pane.drawingDragState = null;
            renderDrawings(pane);
            localStorage.setItem(`symbol_drawings_${pane.symbol}`, JSON.stringify(pane.drawings));
        }
    };
    document.addEventListener('mousedown', pane._onDocSelectDown, true); // capture phase
    document.addEventListener('mousemove', pane._onDocMouseMove);
    document.addEventListener('mouseup',   pane._onDocMouseUp);
    document.addEventListener('keydown',   pane._onDocKeyDown);

    // Capture layer for active drawing tools (non-cursor)
    captureLayer.addEventListener('mousedown',  (e) => onDrawingMouseDown(pane, e));
    captureLayer.addEventListener('mousemove',  (e) => onDrawingMouseMove(pane, e));
    captureLayer.addEventListener('mouseup',    (e) => onDrawingMouseUp(pane, e));
    captureLayer.addEventListener('mouseleave', () => {
        if (pane.drawingInProgress) { pane.drawingInProgress.preview = null; renderDrawings(pane); }
    });
}

function setDrawingTool(pane, toolId) {
    pane.activeTool = toolId;
    pane.drawingInProgress = null;
    pane.selectedDrawingId = null;
    pane.drawingDragState = null;
    if (pane.drawingToolbar) {
        pane.drawingToolbar.querySelectorAll('.drawing-tool-btn[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolId);
        });
    }
    if (pane.drawingCaptureLayer) {
        pane.drawingCaptureLayer.style.pointerEvents = toolId === 'cursor' ? 'none' : 'auto';
    }
    renderDrawings(pane);
}

function pixelToChartCoords(pane, x, y) {
    if (!pane.chart || !pane.candleSeries) return null;
    try {
        const logical = pane.chart.timeScale().coordinateToLogical(x);
        if (logical === null) return null;
        const bars = pane.historyData || [];
        const idx = Math.max(0, Math.min(bars.length - 1, Math.round(logical)));
        const time = bars[idx]?.time ?? null;
        const price = pane.candleSeries.coordinateToPrice(y);
        if (time === null || price === null) return null;
        return { price, time };
    } catch (e) { return null; }
}

function chartCoordsToPixel(pane, price, time) {
    if (!pane.chart || !pane.candleSeries) return null;
    try {
        let x = pane.chart.timeScale().timeToCoordinate(time);
        if (x === null) {
            // Exact timestamp missing in current timeframe — snap to nearest bar
            const bars = pane.historyData || [];
            if (bars.length === 0) return null;
            let nearest = bars[0], minDist = Math.abs(bars[0].time - time);
            for (const bar of bars) {
                const dist = Math.abs(bar.time - time);
                if (dist < minDist) { minDist = dist; nearest = bar; }
            }
            x = pane.chart.timeScale().timeToCoordinate(nearest.time);
        }
        const y = pane.candleSeries.priceToCoordinate(price);
        if (x === null || y === null) return null;
        return { x, y };
    } catch (e) { return null; }
}

function onDrawingMouseDown(pane, e) {
    if (pane.activeTool === 'cursor') return;
    const rect = pane.drawingCaptureLayer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const coords = pixelToChartCoords(pane, x, y);
    if (!coords) return;

    if (pane.activeTool === 'hline' || pane.activeTool === 'vline') {
        pane.drawings.push({ id: Date.now(), type: pane.activeTool, points: [coords], color: '#a0b4cc', lineWidth: 1 });
        localStorage.setItem(`symbol_drawings_${pane.symbol}`, JSON.stringify(pane.drawings));
        setDrawingTool(pane, 'cursor');
        return;
    }
    pane.drawingInProgress = { type: pane.activeTool, points: [coords], preview: coords };
}

function onDrawingMouseMove(pane, e) {
    if (!pane.drawingInProgress) return;
    const rect = pane.drawingCaptureLayer.getBoundingClientRect();
    const coords = pixelToChartCoords(pane, e.clientX - rect.left, e.clientY - rect.top);
    if (!coords) return;
    pane.drawingInProgress.preview = coords;
    renderDrawings(pane);
}

function onDrawingMouseUp(pane, e) {
    if (!pane.drawingInProgress) return;
    const rect = pane.drawingCaptureLayer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const coords = pixelToChartCoords(pane, x, y);
    if (!coords) { pane.drawingInProgress = null; return; }

    const startPt = pane.drawingInProgress.points[0];
    const px1 = chartCoordsToPixel(pane, startPt.price, startPt.time);
    const dx = px1 ? Math.abs(x - px1.x) : 0;
    const dy = px1 ? Math.abs(y - px1.y) : 0;

    if (dx > 4 || dy > 4) {
        pane.drawings.push({ id: Date.now(), type: pane.drawingInProgress.type, points: [startPt, coords], color: '#a0b4cc', lineWidth: 1 });
        localStorage.setItem(`symbol_drawings_${pane.symbol}`, JSON.stringify(pane.drawings));
        pane.drawingInProgress = null;
        setDrawingTool(pane, 'cursor');
    } else {
        pane.drawingInProgress = null;
        renderDrawings(pane);
    }
}

function computeBarDiff(pane, t1, t2) {
    const bars = pane.historyData || [];
    if (bars.length === 0) return 0;
    const tMin = Math.min(t1, t2), tMax = Math.max(t1, t2);
    let i1 = bars.findIndex(b => b.time >= tMin);
    let i2 = bars.findIndex(b => b.time >= tMax);
    if (i1 < 0) i1 = 0;
    if (i2 < 0) i2 = bars.length - 1;
    return i2 - i1;
}

function renderDrawings(pane) {
    const canvas = pane.drawingCanvas;
    if (!canvas || !pane.chart) return;

    const rect = pane.dom.container.getBoundingClientRect();
    if (rect.width > 0 && (canvas.width !== rect.width || canvas.height !== rect.height)) {
        canvas.width = rect.width;
        canvas.height = rect.height;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const all = [...(pane.drawings || [])];
    const inp = pane.drawingInProgress;
    if (inp && inp.preview) {
        all.push({ id: '__preview', type: inp.type, points: [inp.points[0], inp.preview], color: '#a0b4cc', lineWidth: 1, isPreview: true });
    }

    all.forEach(d => {
        const isSelected = !d.isPreview && d.id === pane.selectedDrawingId;
        ctx.save();
        ctx.strokeStyle = isSelected ? '#e2e8f0' : (d.color || '#a0b4cc');
        ctx.fillStyle   = isSelected ? '#e2e8f0' : (d.color || '#a0b4cc');
        ctx.lineWidth   = isSelected ? (d.lineWidth || 1) + 0.75 : (d.lineWidth || 1);
        ctx.globalAlpha = d.isPreview ? 0.65 : 1;
        ctx.setLineDash(d.isPreview ? [5, 3] : []);

        const type = d.type;
        const p = d.points;
        const W = canvas.width;
        const H = canvas.height;

        if (type === 'hline' && p[0]) {
            const y = pane.candleSeries.priceToCoordinate(p[0].price);
            if (y === null) { ctx.restore(); return; }
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            const rightScaleW = (pane.chart && pane.chart.priceScale('right').width && typeof pane.chart.priceScale('right').width === 'function' && pane.chart.priceScale('right').width()) || 65;
            const labelText = formatPrice(p[0].price);
            ctx.font = '10px "Space Grotesk", monospace';
            const textW = ctx.measureText(labelText).width;
            const labelX = W - rightScaleW + 6;
            ctx.globalAlpha *= 0.85;
            // Background pill
            ctx.fillStyle = 'rgba(11, 14, 20, 0.88)';
            ctx.fillRect(labelX - 2, y - 13, textW + 6, 14);
            ctx.fillStyle = '#8e9aaf';
            ctx.fillText(labelText, labelX, y - 4);

        } else if (type === 'vline' && p[0]) {
            const px = chartCoordsToPixel(pane, p[0].price, p[0].time);
            if (!px) { ctx.restore(); return; }
            ctx.beginPath(); ctx.moveTo(px.x, 0); ctx.lineTo(px.x, H); ctx.stroke();

        } else if ((type === 'line' || type === 'ray') && p[0] && p[1]) {
            const px1 = chartCoordsToPixel(pane, p[0].price, p[0].time);
            const px2 = chartCoordsToPixel(pane, p[1].price, p[1].time);
            if (!px1 || !px2) { ctx.restore(); return; }
            ctx.beginPath(); ctx.moveTo(px1.x, px1.y);
            if (type === 'ray') {
                const ddx = px2.x - px1.x, ddy = px2.y - px1.y;
                const t = ddx !== 0 ? (W - px1.x) / ddx : 1e6;
                ctx.lineTo(px1.x + ddx * t, px1.y + ddy * t);
            } else {
                ctx.lineTo(px2.x, px2.y);
            }
            ctx.stroke();

        } else if (type === 'rect' && p[0] && p[1]) {
            const px1 = chartCoordsToPixel(pane, p[0].price, p[0].time);
            const px2 = chartCoordsToPixel(pane, p[1].price, p[1].time);
            if (!px1 || !px2) { ctx.restore(); return; }
            ctx.globalAlpha = d.isPreview ? 0.15 : 0.08;
            ctx.fillStyle = d.color || '#a0b4cc';
            ctx.fillRect(px1.x, px1.y, px2.x - px1.x, px2.y - px1.y);
            ctx.globalAlpha = d.isPreview ? 0.65 : 1;
            ctx.strokeRect(px1.x, px1.y, px2.x - px1.x, px2.y - px1.y);

        } else if (type === 'measure' && p[0] && p[1]) {
            const px1 = chartCoordsToPixel(pane, p[0].price, p[0].time);
            const px2 = chartCoordsToPixel(pane, p[1].price, p[1].time);
            if (!px1 || !px2) { ctx.restore(); return; }
            const rx = Math.min(px1.x, px2.x), ry = Math.min(px1.y, px2.y);
            const rw = Math.abs(px2.x - px1.x), rh = Math.abs(px2.y - px1.y);

            const upColor   = 'rgba(0, 230, 118, 0.85)';
            const downColor = 'rgba(255, 23, 68, 0.85)';
            const priceDiff = p[1].price - p[0].price;
            const barColor  = priceDiff >= 0 ? upColor : downColor;

            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = barColor;
            ctx.lineWidth = 1;
            ctx.globalAlpha = d.isPreview ? 0.65 : 1;
            ctx.fillStyle = priceDiff >= 0 ? 'rgba(0, 230, 118, 0.07)' : 'rgba(255, 23, 68, 0.07)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.setLineDash([]);

            if (rw > 30 && rh > 20) {
                const pctChange = (priceDiff / p[0].price) * 100;
                const sign = priceDiff >= 0 ? '+' : '';
                const bars = computeBarDiff(pane, p[0].time, p[1].time);
                const pctLabel  = `${sign}${pctChange.toFixed(2)}%`;
                const absLabel  = `${sign}${formatPrice(Math.abs(priceDiff))}`;
                const barLabel  = `${bars} bar${bars !== 1 ? 's' : ''}`;

                ctx.font = 'bold 11px "Space Grotesk", monospace';
                ctx.fillStyle = barColor;
                ctx.globalAlpha = 1;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const cx = rx + rw / 2;
                const cy = ry + rh / 2;
                if (rh > 36) {
                    ctx.fillText(pctLabel, cx, cy - 10);
                    ctx.fillText(absLabel, cx, cy + 6);
                    ctx.font = '10px "Space Grotesk", monospace';
                    ctx.globalAlpha = 0.75;
                    ctx.fillText(barLabel, cx, ry + rh - 8);
                } else {
                    ctx.fillText(`${pctLabel}  ${barLabel}`, cx, cy);
                }
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
            }
        }

        // Selection handles — small circles at each defining point
        if (isSelected) {
            d.points.forEach(pt => {
                const hpx = chartCoordsToPixel(pane, pt.price, pt.time);
                if (!hpx) return;
                ctx.save();
                ctx.globalAlpha = 1;
                ctx.setLineDash([]);
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#6c5ce7';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(hpx.x, hpx.y, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            });
        }

        ctx.restore();
    });
}

function initLightweightChart(pane) {
    const rect = pane.dom.container.getBoundingClientRect();
    
    // 1. Create Chart
    const chart = LightweightCharts.createChart(pane.dom.container, {
        width: rect.width || 300,
        height: rect.height || 200,
        layout: {
            background: { type: 'solid', color: '#0b0e14' },
            textColor: '#8e9aaf',
            fontSize: 11,
            fontFamily: "'Space Grotesk', monospace"
        },
        grid: {
            vertLines: { color: '#1a202c' },
            horzLines: { color: '#1a202c' }
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: '#6c5ce7', width: 1, style: 2 },
            horzLine: { color: '#6c5ce7', width: 1, style: 2 }
        },
        timeScale: {
            borderColor: '#2a3347',
            timeVisible: true,
            secondsVisible: false,
            rightOffset: 12,
            visible: false,
            tickMarkFormatter: (time) => formatChartTickMark(pane, time)
        },
        rightPriceScale: {
            borderColor: '#2a3347',
            autoScale: true
        },
        handleScale: {
            axisPressedMouseMove: {
                price: false,  // Prevent y-axis drag from moving candles into sub-chart areas
                time: true
            },
            axisDoubleClickReset: {
                price: true,   // Double-click price axis to reset auto-scale
                time: true
            }
        }
    });
    
    // 2. Add Candle Series
    const candleSeries = chart.addCandlestickSeries({
        upColor: '#00e676',
        downColor: '#ff1744',
        borderUpColor: '#00e676',
        borderDownColor: '#ff1744',
        wickUpColor: '#00e676',
        wickDownColor: '#ff1744',
        priceFormat: {
            type: 'price',
            precision: 2,
            minMove: 0.01
        }
    });
    
    // 3. Add VWAP Line Series (Overlay on price chart)
    const vwapSeries = chart.addLineSeries({
        color: '#ffbe0b',
        lineWidth: 1.5,
        title: 'VWAP',
        priceLineVisible: false
    });
    
    // Add EMA 10 Series
    const ema10Series = chart.addLineSeries({
        color: '#00b0ff',
        lineWidth: 1.5,
        title: '',
        priceLineVisible: false,
        visible: false
    });
    
    // Add EMA 20 Series
    const ema20Series = chart.addLineSeries({
        color: '#e040fb',
        lineWidth: 1.5,
        title: '',
        priceLineVisible: false,
        visible: false
    });
    
    // Add EMA 50 Series
    const ema50Series = chart.addLineSeries({
        color: '#00e676',
        lineWidth: 1.5,
        title: '',
        priceLineVisible: false,
        visible: false
    });

    const ema100Series = chart.addLineSeries({
        color: '#ffd166',
        lineWidth: 1.5,
        title: '',
        priceLineVisible: false,
        visible: false
    });

    const ema200Series = chart.addLineSeries({
        color: '#ff7b72',
        lineWidth: 1.5,
        title: '',
        priceLineVisible: false,
        visible: false
    });
    
    // Add Bollinger Bands Series
    const bbUpperSeries = chart.addLineSeries({
        color: '#ff5252',
        lineWidth: 1,
        lineStyle: 2,
        title: '',
        priceLineVisible: false,
        visible: false
    });
    const bbMiddleSeries = chart.addLineSeries({
        color: '#7c8ba1',
        lineWidth: 1,
        lineStyle: 2,
        title: '',
        priceLineVisible: false,
        visible: false
    });
    const bbLowerSeries = chart.addLineSeries({
        color: '#ff5252',
        lineWidth: 1,
        lineStyle: 2,
        title: '',
        priceLineVisible: false,
        visible: false
    });

    // 4. Add hidden CVD Series (metric source only)
    const cvdSeries = chart.addLineSeries({
        color: '#706fd3',
        lineWidth: 2,
        title: 'CVD',
        priceScaleId: 'cvd-scale',
        priceLineVisible: false,
        lastValueVisible: false,
        visible: false
    });
    chart.priceScale('cvd-scale').applyOptions({
        borderColor: '#2a3347',
        visible: false
    });
    
    // Price scale margins for candlesticks (no bottom reserved for oscillators anymore)
    chart.priceScale('right').applyOptions({
        scaleMargins: {
            top: 0.05,
            bottom: 0.05
        }
    });

    // Volume Profile canvas — rendered in right panel instead of overlay
    pane.volumeProfileCanvas = pane.dom.vpCanvas;
    if (pane.volumeProfileCanvas) {
        pane.volumeProfileCanvas.width = pane.dom.vpRight.clientWidth || 100;
        pane.volumeProfileCanvas.height = pane.dom.container.clientHeight || 200;
    }
    // Delta Profile canvas — rendered in left panel
    if (pane.dom.deltaCanvas) {
        pane.dom.deltaCanvas.width = pane.dom.ofPanel.clientWidth || 80;
        pane.dom.deltaCanvas.height = pane.dom.container.clientHeight || 200;
    }
    // Time axis canvas
    if (pane.dom.timeCanvas) {
        pane.dom.timeCanvas.width = pane.dom.timeAxis.clientWidth || 300;
        pane.dom.timeCanvas.height = pane.dom.timeAxis.clientHeight || 24;
    }

    const decorationOverlay = document.createElement('div');
    decorationOverlay.className = 'chart-decoration-overlay';
    pane.dom.container.appendChild(decorationOverlay);
    pane.decorationOverlay = decorationOverlay;

    // Auto-resize chart and subchart canvases when container changes
    const resizeObserver = new ResizeObserver(entries => {
        if (entries.length === 0 || !entries[0].contentRect) return;
        const { width, height } = entries[0].contentRect;
        chart.resize(width, height);
        if (pane.drawingCanvas) {
            pane.drawingCanvas.width = width;
            pane.drawingCanvas.height = height;
        }
        if (pane.fpCanvas) {
            pane.fpCanvas.width  = width;
            pane.fpCanvas.height = height;
        }
        // Resize VP canvas in right panel
        if (pane.dom.vpCanvas) {
            pane.dom.vpCanvas.width = pane.dom.vpRight.clientWidth || 100;
            pane.dom.vpCanvas.height = pane.dom.container.clientHeight || 200;
        }
        // Resize delta canvas in left panel
        if (pane.dom.deltaCanvas) {
            pane.dom.deltaCanvas.width = pane.dom.ofPanel.clientWidth || 80;
            pane.dom.deltaCanvas.height = pane.dom.container.clientHeight || 200;
        }
        // Resize all subchart canvases
        Object.values(pane.subchartPanels).forEach(sp => {
            const wrap = sp.canvas.parentElement;
            if (wrap) {
                sp.canvas.width = wrap.clientWidth;
                sp.canvas.height = wrap.clientHeight;
            }
        });
        // Resize time axis canvas
        if (pane.dom.timeCanvas) {
            pane.dom.timeCanvas.width = pane.dom.timeAxis.clientWidth || 300;
            pane.dom.timeCanvas.height = pane.dom.timeAxis.clientHeight || 24;
        }
        requestVolumeProfileDraw(pane);
        renderDrawings(pane);
        renderFootprint(pane);
        renderAllSubcharts(pane);
        drawDeltaProfile(pane);
        renderTimeAxis(pane);
    });
    resizeObserver.observe(pane.dom.container);

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        requestVolumeProfileDraw(pane);
        renderDrawings(pane);
        renderFootprint(pane);
        renderAllSubcharts(pane);
        drawDeltaProfile(pane);
        renderTimeAxis(pane);
    });

    // --- Time axis drag-to-pan ---
    const timeCanvas = pane.dom.timeCanvas;
    if (timeCanvas) {
        let taDragging = false;
        let taStartX = 0;
        let taStartRange = null;

        timeCanvas.addEventListener('mousedown', (e) => {
            const ts = chart.timeScale();
            const vr = ts.getVisibleRange();
            if (!vr) return;
            taDragging = true;
            taStartX = e.clientX;
            taStartRange = { from: vr.from, to: vr.to };
            timeCanvas.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!taDragging || !taStartRange) return;
            const dx = e.clientX - taStartX;
            if (Math.abs(dx) < 1) return;

            const contRect = pane.dom.container.getBoundingClientRect();
            const effectiveWidth = contRect.width;
            if (effectiveWidth <= 0) return;

            const span = taStartRange.to - taStartRange.from;
            const shift = (dx / effectiveWidth) * span;

            chart.timeScale().setVisibleRange({
                from: taStartRange.from - shift,
                to: taStartRange.to - shift,
            });
        });

        document.addEventListener('mouseup', () => {
            if (taDragging) {
                taDragging = false;
                taStartRange = null;
                timeCanvas.style.cursor = 'grab';
            }
        });

        timeCanvas.style.cursor = 'grab';
    }

    initDrawingTools(pane);
    initFootprintForPane(pane);
    addFootprintControls(pane);
    
    pane.chart = chart;
    pane.resizeObserver = resizeObserver;
    pane.candleSeries = candleSeries;
    pane.vwapSeries = vwapSeries;
    pane.ema10Series = ema10Series;
    pane.ema20Series = ema20Series;
    pane.ema50Series = ema50Series;
    pane.ema100Series = ema100Series;
    pane.ema200Series = ema200Series;
    pane.bbUpperSeries = bbUpperSeries;
    pane.bbMiddleSeries = bbMiddleSeries;
    pane.bbLowerSeries = bbLowerSeries;
    pane.cvdSeries = cvdSeries;
    pane.divergenceMarkers = [];
}

// --- DATA ACTIONS & SYMBOL / TIMEFRAME UPDATES ---

function updatePaneSymbol(pane, newSymbol) {
    newSymbol = newSymbol.trim().toUpperCase();
    if (!newSymbol) return;
    if (pane.symbol === newSymbol) return;

    // Save drawings for outgoing symbol
    localStorage.setItem(`symbol_drawings_${pane.symbol}`, JSON.stringify(pane.drawings || []));

    // Unsubscribe from old live stream
    sendUnsubscription(pane.id);

    pane.symbol = newSymbol;
    pane.dom.symLabel.textContent = newSymbol;
    localStorage.setItem(`pane_config_${pane.id}`, JSON.stringify({
        symbol: pane.symbol,
        timeframe: pane.timeframe,
        indicators: pane.indicators
    }));

    // Load drawings for incoming symbol
    try {
        const saved = localStorage.getItem(`symbol_drawings_${newSymbol}`);
        pane.drawings = saved ? JSON.parse(saved) : [];
    } catch (e) { pane.drawings = []; }
    pane.selectedDrawingId = null;
    pane.drawingInProgress = null;
    pane.drawingDragState = null;
    renderDrawings(pane);

    // Invalidate regime so it reinitializes after historical bars load
    if (pane.indicators.regime) {
        pane.regimeInitialized = false;
        pane._regimeState = null;
        setRegimeDisplay(pane, "warming_up", "Unknown", 0, false, null, 0, []);
    }

    // Load historical candles
    loadHistoricalData(pane);
}

function updatePaneTimeframe(pane, newTimeframe) {
    if (pane.timeframe === newTimeframe) return;

    // Unsubscribe from old live stream
    sendUnsubscription(pane.id);

    pane.timeframe = newTimeframe;
    pane.dom.tfLabel.textContent = newTimeframe;
    localStorage.setItem(`pane_config_${pane.id}`, JSON.stringify({
        symbol: pane.symbol,
        timeframe: pane.timeframe,
        indicators: pane.indicators
    }));

    // Invalidate regime so it reinitializes after historical bars load
    if (pane.indicators.regime) {
        pane.regimeInitialized = false;
        pane._regimeState = null;
        setRegimeDisplay(pane, "warming_up", "Unknown", 0, false, null, 0, []);
    }

    applyChartSettings(pane);

    // Load historical candles
    loadHistoricalData(pane);
}

async function loadHistoricalData(pane) {
    pane.historyRequestId = (pane.historyRequestId || 0) + 1;
    const requestId = pane.historyRequestId;
    const requestedSymbol = pane.symbol;
    const requestedTimeframe = pane.timeframe;

    pane.dom.loading.classList.add("active");
    pane.dom.priceLabel.textContent = "LOADING...";
    
    try {
        const response = await fetch(`/api/history?symbol=${encodeURIComponent(requestedSymbol)}&timeframe=${requestedTimeframe}`);
        if (!response.ok) {
            const errorPayload = await response.json().catch(() => ({}));
            throw new Error(errorPayload.error || "Fetch failed");
        }
        
        const data = await response.json();

        if (
            requestId !== pane.historyRequestId ||
            requestedSymbol !== pane.symbol ||
            requestedTimeframe !== pane.timeframe
        ) {
            return;
        }
        
        const normalizedData = Array.isArray(data)
            ? data.map(normalizeOhlcvBar).filter(Boolean)
            : [];

        if (normalizedData.length > 0) {
            // Set candle data
            pane.candleSeries.setData(normalizedData);
            pane.historyData = normalizedData;
            pane.volumeProfileData = normalizedData.slice();
            
            // Generate historical VWAP and CVD approximations to seed charts
            const vwapData = [];
            const cvdData = [];
            let cumulativeCvd = 0;
            
            normalizedData.forEach(bar => {
                // Seed VWAP close
                vwapData.push({ time: bar.time, value: bar.close });
                
                // Seed some fake CVD
                const diff = bar.close - bar.open;
                cumulativeCvd += diff * bar.volume * 0.1; 
                cvdData.push({ time: bar.time, value: cumulativeCvd });
            });
            
            pane.vwapSeries.setData(vwapData);
            pane.cvdSeries.setData(cvdData);
            pane.lastCvd = cumulativeCvd;
            
            // Set last price tracking
            const lastBar = normalizedData[normalizedData.length - 1];
            pane.lastBar = lastBar;
            pane.lastPrice = lastBar.close;
            pane.lastIndicatorUpdateTime = lastBar.time;
            pane.lastIndicatorRealtimeAt = 0;

            const volumeProfileSourceTimeframe = getVolumeProfileSourceTimeframe(requestedTimeframe);
            if (volumeProfileSourceTimeframe !== requestedTimeframe) {
                try {
                    const profileResponse = await fetch(
                        `/api/history?symbol=${encodeURIComponent(requestedSymbol)}&timeframe=${volumeProfileSourceTimeframe}`
                    );
                    if (profileResponse.ok) {
                        const profileData = await profileResponse.json();
                        if (
                            requestId === pane.historyRequestId &&
                            requestedSymbol === pane.symbol &&
                            requestedTimeframe === pane.timeframe &&
                            Array.isArray(profileData) &&
                            profileData.length > 0
                        ) {
                            pane.volumeProfileData = profileData
                                .map(normalizeOhlcvBar)
                                .filter(Boolean);
                        }
                    }
                } catch (profileError) {
                    console.warn("Volume profile session data fallback in use:", profileError);
                }
            }
            
            pane.dom.priceLabel.textContent = formatPrice(lastBar.close);
            pane.dom.cvdValue.textContent = formatCvd(cumulativeCvd);
            pane.dom.cvdValue.className = "metric-value " + (cumulativeCvd >= 0 ? "up" : "down");
            pane.dom.vwapValue.textContent = formatPrice(lastBar.close);
            
            // Calculate and apply all technical indicators
            applyIndicators(pane);

            // Re-init regime after historical load if already enabled
            if (pane.indicators.regime) {
                pane.regimeInitialized = false;
                initRegimeForPane(pane);
            }

            // Fit content
            pane.chart.timeScale().fitContent();
            requestAnimationFrame(() => {
                requestVolumeProfileDraw(pane);
                renderDrawings(pane);
                renderFootprint(pane);
                renderTimeAxis(pane);
            });
        } else {
            pane.candleSeries.setData([]);
            pane.vwapSeries.setData([]);
            pane.cvdSeries.setData([]);
            pane.historyData = [];
            pane.volumeProfileData = [];
            pane.lastBar = null;
            pane.lastIndicatorUpdateTime = 0;
            pane.lastIndicatorRealtimeAt = 0;
            pane.dom.priceLabel.textContent = "NO DATA";
        }
    } catch (e) {
        if (requestId !== pane.historyRequestId) {
            return;
        }
        console.error(e);
        pane.dom.priceLabel.textContent = "ERROR";
    } finally {
        if (requestId !== pane.historyRequestId) {
            return;
        }
        pane.dom.loading.classList.remove("active");
        
        // Connect to WebSocket stream for this pane
        sendSubscription(pane.id, pane.symbol, pane.timeframe);
    }
}

// --- WEBSOCKET CLIENT & TICK PROCESSING ---

function initWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    console.log("Connecting web client WS to:", wsUrl);
    const ws = new WebSocket(wsUrl);
    state.socket = ws;
    
    ws.onopen = () => {
        console.log("Web client WS connected.");
        document.querySelector(".system-status .status-dot").className = "status-dot green";
        document.querySelector(".system-status .status-text").textContent = "Live Stream Connected";
        
        // Re-subscribe all active panes
        Object.values(state.panes).forEach(pane => {
            sendSubscription(pane.id, pane.symbol, pane.timeframe);
        });
    };
    
    ws.onclose = () => {
        console.log("Web client WS disconnected.");
        document.querySelector(".system-status .status-dot").className = "status-dot";
        document.querySelector(".system-status .status-text").textContent = "Reconnecting...";
        
        // Attempt reconnection
        setTimeout(initWebSocket, 3000);
    };
    
    ws.onerror = (err) => {
        console.error("WS error:", err);
        reportClientLog("error", `WS error: ${err?.message || err}`);
    };
    
    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === "tick") {
                processLiveTick(msg.paneId, msg.data);
            }
        } catch (e) {
            console.error("Failed to process message:", e);
            reportClientLog("error", `Failed to process message: ${e?.stack || e}`);
        }
    };
}

function sendSubscription(paneId, symbol, timeframe) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({
            action: "subscribe",
            paneId: paneId,
            symbol: symbol,
            timeframe: timeframe
        }));
    }
}

function sendUnsubscription(paneId) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({
            action: "unsubscribe",
            paneId: paneId
        }));
    }
}

function reportClientLog(level, message) {
    try {
        if (typeof window.__reportClientLog === "function") {
            window.__reportClientLog(level, message);
            return;
        }
        const payload = JSON.stringify({ level, message });
        if (navigator.sendBeacon) {
            navigator.sendBeacon("/api/log", new Blob([payload], { type: "application/json" }));
            return;
        }
        fetch("/api/log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
        }).catch(() => {});
    } catch (_) {
        // Logging should never break the chart.
    }
}

function processLiveTick(paneId, tick) {
    const pane = state.panes[paneId];
    if (!pane) return;
    
    // Ensure the tick corresponds to the currently configured symbol
    const cleanSym = tick.coin.toUpperCase();
    if (cleanSym !== pane.symbol) return;
    
    const price = tick.price;
    const timeMs = tick.time; // timestamp in ms from stream
    if (!Number.isFinite(price) || !Number.isFinite(timeMs)) {
        return;
    }
    
    // 1. Flash price indicator
    const priceLabel = pane.dom.priceLabel;
    priceLabel.textContent = formatPrice(price);
    
    if (price > pane.lastPrice) {
        priceLabel.classList.add("flash-up");
        priceLabel.classList.remove("flash-down");
    } else if (price < pane.lastPrice) {
        priceLabel.classList.add("flash-down");
        priceLabel.classList.remove("flash-up");
    }
    
    // Remove flash color after a short time
    clearTimeout(pane.flashTimeout);
    pane.flashTimeout = setTimeout(() => {
        priceLabel.classList.remove("flash-up", "flash-down");
    }, 150);
    
    pane.lastPrice = price;
    
    // 2. Aggregate tick into candle bar based on timeframe
    const candleTimeSec = roundTimestamp(timeMs, pane.timeframe);
    const volumeProfileTimeSec = roundTimestamp(timeMs, getVolumeProfileSourceTimeframe(pane.timeframe));
    let lastBar = pane.lastBar;
    if (lastBar && candleTimeSec < lastBar.time) {
        return;
    }
    const isNewBar = !lastBar || candleTimeSec > lastBar.time;
    
    if (isNewBar) {
        // Capture the just-closed bar before creating the new one
        const closedBar = lastBar;

        // Create a new bar
        lastBar = {
            time: candleTimeSec,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: Number.isFinite(tick.size) ? tick.size : 0
        };
        lastBar = normalizeOhlcvBar(lastBar);
        pane.lastBar = lastBar;
        if (!pane.historyData) pane.historyData = [];
        pane.historyData.push(lastBar);
        // keep historyData reasonably sized, e.g. last 1000 bars
        if (pane.historyData.length > 1000) {
            pane.historyData.shift();
        }

        // Notify regime engine of the confirmed closed bar (not the new bar)
        if (closedBar && pane.indicators.regime && pane.regimeInitialized) {
            handleBarCloseForRegime(pane, closedBar);
        }
    } else if (candleTimeSec === lastBar.time) {
        // Update current bar
        lastBar.close = price;
        lastBar.high = Math.max(lastBar.high, price);
        lastBar.low = Math.min(lastBar.low, price);
        lastBar.volume += Number.isFinite(tick.size) ? tick.size : 0;
        lastBar = normalizeOhlcvBar(lastBar);
        pane.lastBar = lastBar;
        if (pane.historyData && pane.historyData.length > 0) {
            pane.historyData[pane.historyData.length - 1] = lastBar;
        }
    }
    
    // Push update to Lightweight Charts
    if (!safeSeriesUpdate(pane, pane.candleSeries, lastBar, "candleSeries")) {
        return;
    }

    if (!pane.volumeProfileData) {
        pane.volumeProfileData = [];
    }
    let lastProfileBar = pane.volumeProfileData[pane.volumeProfileData.length - 1];
    if (!lastProfileBar || volumeProfileTimeSec > lastProfileBar.time) {
        lastProfileBar = {
            time: volumeProfileTimeSec,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: Number.isFinite(tick.size) ? tick.size : 0
        };
        lastProfileBar = normalizeOhlcvBar(lastProfileBar);
        pane.volumeProfileData.push(lastProfileBar);
        if (pane.volumeProfileData.length > 2000) {
            pane.volumeProfileData.shift();
        }
    } else if (volumeProfileTimeSec === lastProfileBar.time) {
        lastProfileBar.close = price;
        lastProfileBar.high = Math.max(lastProfileBar.high, price);
        lastProfileBar.low = Math.min(lastProfileBar.low, price);
        lastProfileBar.volume += Number.isFinite(tick.size) ? tick.size : 0;
        lastProfileBar = normalizeOhlcvBar(lastProfileBar);
        pane.volumeProfileData[pane.volumeProfileData.length - 1] = lastProfileBar;
    }
    
    // 3. Update VWAP (Overlay on price scale)
    if (tick.vwap !== undefined) {
        safeSeriesUpdate(pane, pane.vwapSeries, {
            time: candleTimeSec,
            value: tick.vwap
        }, "vwapSeries");
        pane.dom.vwapValue.textContent = formatPrice(tick.vwap);
    }
    
    // 4. Update CVD metric source
    if (tick.cvd !== undefined) {
        if (isCryptoSymbol(pane.symbol)) {
            pane.lastCvd = tick.cvd;
        } else {
            pane.lastCvd = (Number.isFinite(pane.lastCvd) ? pane.lastCvd : 0) + tick.cvd;
        }
    }
    
    // 5. Footprint aggregation — uses raw tick price/size/side before candle aggregation
    fpOnTick(pane, tick);
    // Throttled re-render: request one animation frame per pane (deduped)
    if (pane.fp && pane.fp.enabled && !pane._fpRafPending) {
        pane._fpRafPending = true;
        requestAnimationFrame(() => {
            pane._fpRafPending = false;
            renderFootprint(pane);
        });
    }

    // 6. Update other indicators on tick
    updateIndicatorsRealtime(pane, isNewBar);
}

// --- UTILITIES & STORAGE ---

function roundTimestamp(ms, timeframe) {
    const sec = Math.floor(ms / 1000);
    switch (timeframe) {
        case "1m":
            return Math.floor(sec / 60) * 60;
        case "3m":
            return Math.floor(sec / 180) * 180;
        case "5m":
            return Math.floor(sec / 300) * 300;
        case "15m":
            return Math.floor(sec / 900) * 900;
        case "30m":
            return Math.floor(sec / 1800) * 1800;
        case "1h":
            return Math.floor(sec / 3600) * 3600;
        case "4h":
            return Math.floor(sec / 14400) * 14400;
        case "1d":
            // Align to start of UTC day
            return Math.floor(sec / 86400) * 86400;
        default:
            return sec;
    }
}

function normalizeBarTime(timeValue) {
    if (typeof timeValue === "number" && Number.isFinite(timeValue)) {
        return Math.floor(timeValue);
    }
    if (typeof timeValue === "string") {
        const parsed = Number(timeValue);
        if (Number.isFinite(parsed)) {
            return Math.floor(parsed);
        }
    }
    if (timeValue && typeof timeValue === "object") {
        if (typeof timeValue.timestamp === "number" && Number.isFinite(timeValue.timestamp)) {
            return Math.floor(timeValue.timestamp);
        }
        if (
            typeof timeValue.year === "number" &&
            typeof timeValue.month === "number" &&
            typeof timeValue.day === "number"
        ) {
            return Math.floor(Date.UTC(timeValue.year, timeValue.month - 1, timeValue.day) / 1000);
        }
    }
    return null;
}

function normalizeOhlcvBar(bar) {
    if (!bar) return null;
    const time = normalizeBarTime(bar.time);
    if (time === null) return null;
    return {
        ...bar,
        time,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : 0,
    };
}

function normalizeLinePoint(point) {
    if (!point) return null;
    const time = normalizeBarTime(point.time);
    const value = Number(point.value);
    if (time === null || !Number.isFinite(value)) {
        return null;
    }
    return {
        ...point,
        time,
        value,
    };
}

function safeSeriesUpdate(pane, series, point, label) {
    if (!series || !point) return false;
    let normalizedPoint = point;
    if ("open" in point && "high" in point && "low" in point && "close" in point) {
        normalizedPoint = normalizeOhlcvBar(point);
    } else if ("value" in point) {
        normalizedPoint = normalizeLinePoint(point);
    }
    if (!normalizedPoint) {
        return false;
    }
    try {
        series.update(normalizedPoint);
        return true;
    } catch (error) {
        console.warn(`Recovering ${label} update for ${pane.symbol} ${pane.timeframe}:`, error);
        reportClientLog("warn", `Recovering ${label} update for ${pane.symbol} ${pane.timeframe}: ${error?.stack || error}`);
        if (label === "candleSeries" && Array.isArray(pane.historyData) && pane.historyData.length > 0) {
            const normalizedHistory = pane.historyData
                .map(normalizeOhlcvBar)
                .filter(Boolean);
            pane.historyData = normalizedHistory;
            pane.lastBar = normalizedHistory[normalizedHistory.length - 1] || pane.lastBar;
            series.setData(normalizedHistory);
            return true;
        }
        return false;
    }
}

function formatPrice(p) {
    if (p === undefined || p === null) return "--";
    if (p >= 1000) {
        return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (p >= 1) {
        return p.toFixed(2);
    } else {
        return p.toFixed(5);
    }
}

function formatCvd(val) {
    if (val === undefined || val === null) return "--";
    const sign = val >= 0 ? "+" : "";
    if (Math.abs(val) >= 1000000) {
        return `${sign}${(val / 1000000).toFixed(2)}M`;
    } else if (Math.abs(val) >= 1000) {
        return `${sign}${(val / 1000).toFixed(2)}K`;
    } else {
        return `${sign}${val.toFixed(2)}`;
    }
}

function formatAtrValue(val) {
    if (val === undefined || val === null || !Number.isFinite(val)) return "--";
    if (Math.abs(val) >= 1000) {
        return val.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    } else if (Math.abs(val) >= 100) {
        return val.toFixed(1);
    } else if (Math.abs(val) >= 1) {
        return val.toFixed(2);
    } else {
        return val.toFixed(4);
    }
}

function saveSettings() {
    localStorage.setItem("grid_count_select", state.gridCount);
}

function loadSettings() {
    const savedCount = localStorage.getItem("grid_count_select");
    if (savedCount) {
        state.gridCount = normalizeGridCount(savedCount);
    }
}

// Close all indicator menus when clicking outside
document.addEventListener("click", (e) => {
    if (!e.target.closest(".indicator-menu-container")) {
        document.querySelectorAll(".indicator-menu").forEach(menu => {
            menu.classList.remove("show");
        });
        Object.values(state.panes).forEach(pane => pane.rootEl.classList.remove("menu-open"));
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.fullscreenPaneId) {
        const pane = state.panes[state.fullscreenPaneId];
        if (pane) {
            togglePaneFullscreen(pane);
        }
    }
});

// --- INDICATOR CALCULATION ENGINE ---

function calculateSMA(data, period) {
    const sma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            sma.push({ time: data[i].time });
            continue;
        }
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += data[i - j].close;
        }
        sma.push({ time: data[i].time, value: sum / period });
    }
    return sma;
}

function calculateEMA(data, period) {
    const ema = [];
    if (data.length === 0) return ema;
    
    const k = 2 / (period + 1);
    let prevEma = data[0].close;
    ema.push({ time: data[0].time, value: prevEma });
    
    for (let i = 1; i < data.length; i++) {
        if (i < period - 1) {
            let sum = 0;
            for (let j = 0; j <= i; j++) sum += data[j].close;
            prevEma = sum / (i + 1);
            ema.push({ time: data[i].time, value: prevEma });
        } else {
            const currentEma = data[i].close * k + prevEma * (1 - k);
            ema.push({ time: data[i].time, value: currentEma });
            prevEma = currentEma;
        }
    }
    return ema;
}

function calculateBollingerBands(data, period, stdDevMultiplier) {
    const upper = [];
    const middle = [];
    const lower = [];
    
    const sma = calculateSMA(data, period);
    
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1 || sma[i].value === undefined) {
            upper.push({ time: data[i].time });
            middle.push({ time: data[i].time });
            lower.push({ time: data[i].time });
            continue;
        }
        
        const midVal = sma[i].value;
        let sumSq = 0;
        for (let j = 0; j < period; j++) {
            const diff = data[i - j].close - midVal;
            sumSq += diff * diff;
        }
        const stdDev = Math.sqrt(sumSq / period);
        
        middle.push({ time: data[i].time, value: midVal });
        upper.push({ time: data[i].time, value: midVal + stdDevMultiplier * stdDev });
        lower.push({ time: data[i].time, value: midVal - stdDevMultiplier * stdDev });
    }
    
    return { upper, middle, lower };
}

function calculateRSI(data, period = 14) {
    const rsi = [];
    if (data.length === 0) return rsi;
    
    rsi.push({ time: data[0].time, value: 50 });
    if (data.length < 2) return rsi;
    
    let gains = 0;
    let losses = 0;
    const limit = Math.min(data.length, period + 1);
    
    for (let i = 1; i < limit; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) {
            gains += change;
        } else {
            losses -= change;
        }
        if (i < period) {
            rsi.push({ time: data[i].time, value: 50 });
        }
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    const firstRSI = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    if (data.length > period) {
        rsi.push({ time: data[period].time, value: firstRSI });
    }
    
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        const rsVal = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
        rsi.push({ time: data[i].time, value: rsVal });
    }
    
    return rsi;
}

function calculateCVD(data) {
    const cvd = [];
    let cumulativeCvd = 0;

    for (let i = 0; i < data.length; i++) {
        const bar = data[i];
        const volume = bar.volume || 0;
        const directionalMove = (bar.close ?? 0) - (bar.open ?? bar.close ?? 0);

        // Historical CVD is an approximation in this app: directional bar move weighted by volume.
        cumulativeCvd += directionalMove * volume * 0.1;
        cvd.push({ time: bar.time, value: cumulativeCvd });
    }

    return cvd;
}

function calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const fastEma = calculateEMA(data, fastPeriod);
    const slowEma = calculateEMA(data, slowPeriod);
    
    const macdLines = [];
    for (let i = 0; i < data.length; i++) {
        if (fastEma[i].value === undefined || slowEma[i].value === undefined) {
            macdLines.push({ time: data[i].time, value: 0 });
        } else {
            macdLines.push({ time: data[i].time, value: fastEma[i].value - slowEma[i].value });
        }
    }
    
    const signalLines = [];
    if (macdLines.length > 0) {
        const k = 2 / (signalPeriod + 1);
        let prevSignal = macdLines[0].value;
        signalLines.push({ time: macdLines[0].time, value: prevSignal });
        
        for (let i = 1; i < macdLines.length; i++) {
            const currentSignal = macdLines[i].value * k + prevSignal * (1 - k);
            signalLines.push({ time: macdLines[i].time, value: currentSignal });
            prevSignal = currentSignal;
        }
    }
    
    const histogram = [];
    for (let i = 0; i < macdLines.length; i++) {
        const macdVal = macdLines[i].value;
        const signalVal = signalLines[i] ? signalLines[i].value : 0;
        const histVal = macdVal - signalVal;
        const prevHistVal = i > 0 ? (macdLines[i-1].value - (signalLines[i-1] ? signalLines[i-1].value : 0)) : 0;

        let color;
        if (histVal >= 0 && histVal >= prevHistVal) {
            color = '#00e676';          // strong positive: bright green
        } else if (histVal >= 0 && histVal < prevHistVal) {
            color = '#4caf50';          // weakening positive: muted green
        } else if (histVal < 0 && histVal <= prevHistVal) {
            color = '#ff1744';          // strengthening negative: strong red
        } else {
            color = '#e57373';          // weakening negative: light red
        }

        histogram.push({
            time: macdLines[i].time,
            value: histVal,
            color: color
        });
    }
    
    return {
        macd: macdLines,
        signal: signalLines,
        histogram: histogram
    };
}

function calculateVWMA(data, period) {
    const vwma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            vwma.push({ time: data[i].time });
            continue;
        }
        let sumPV = 0;
        let sumV = 0;
        for (let j = 0; j < period; j++) {
            const bar = data[i - j];
            const vol = bar.volume || 1;
            sumPV += bar.close * vol;
            sumV += vol;
        }
        vwma.push({ time: data[i].time, value: sumV > 0 ? sumPV / sumV : data[i].close });
    }
    return vwma;
}

function calculateVWRSI(data, period = 14) {
    const rsi = [];
    if (data.length === 0) return rsi;

    rsi.push({ time: data[0].time, value: 50 });
    if (data.length < 2) return rsi;

    let gains = 0;
    let losses = 0;
    const limit = Math.min(data.length, period + 1);

    for (let i = 1; i < limit; i++) {
        const change = data[i].close - data[i - 1].close;
        const vol = data[i].volume || 1;
        if (change > 0) {
            gains += change * vol;
        } else {
            losses -= change * vol;
        }
        if (i < period) {
            rsi.push({ time: data[i].time, value: 50 });
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    const firstRSI = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    if (data.length > period) {
        rsi.push({ time: data[period].time, value: firstRSI });
    }

    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        const vol = data[i].volume || 1;
        const gain = change > 0 ? change * vol : 0;
        const loss = change < 0 ? -change * vol : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        const rsVal = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
        rsi.push({ time: data[i].time, value: rsVal });
    }

    return rsi;
}

function calculateVWMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const fastVwma = calculateVWMA(data, fastPeriod);
    const slowVwma = calculateVWMA(data, slowPeriod);

    const macdLines = [];
    for (let i = 0; i < data.length; i++) {
        if (fastVwma[i].value === undefined || slowVwma[i].value === undefined) {
            macdLines.push({ time: data[i].time, value: 0 });
        } else {
            macdLines.push({ time: data[i].time, value: fastVwma[i].value - slowVwma[i].value });
        }
    }

    const signalLines = [];
    if (macdLines.length > 0) {
        const k = 2 / (signalPeriod + 1);
        let prevSignal = macdLines[0].value;
        signalLines.push({ time: macdLines[0].time, value: prevSignal });

        for (let i = 1; i < macdLines.length; i++) {
            const currentSignal = macdLines[i].value * k + prevSignal * (1 - k);
            signalLines.push({ time: macdLines[i].time, value: currentSignal });
            prevSignal = currentSignal;
        }
    }

    // 4-color momentum shading
    const histogram = [];
    for (let i = 0; i < macdLines.length; i++) {
        const macdVal = macdLines[i].value;
        const signalVal = signalLines[i] ? signalLines[i].value : 0;
        const histVal = macdVal - signalVal;
        const prevHistVal = i > 0 ? (macdLines[i-1].value - (signalLines[i-1] ? signalLines[i-1].value : 0)) : 0;

        let color;
        if (histVal >= 0 && histVal >= prevHistVal) {
            color = '#00e676';          // strong positive: bright green
        } else if (histVal >= 0 && histVal < prevHistVal) {
            color = '#4caf50';          // weakening positive: muted green
        } else if (histVal < 0 && histVal <= prevHistVal) {
            color = '#ff1744';          // strengthening negative: strong red
        } else {
            color = '#e57373';          // weakening negative: light red
        }

        histogram.push({
            time: macdLines[i].time,
            value: histVal,
            color: color
        });
    }

    return {
        macd: macdLines,
        signal: signalLines,
        histogram: histogram
    };
}

function calculateATR(data, period = 14) {
    const atr = [];
    if (data.length < 2) {
        for (let i = 0; i < data.length; i++) {
            atr.push({ time: data[i].time, value: 0 });
        }
        return atr;
    }

    // True Range: max of (H-L), |H-PrevClose|, |L-PrevClose|
    const tr = [];
    tr.push({ time: data[0].time, value: data[0].high - data[0].low });

    for (let i = 1; i < data.length; i++) {
        const hl = data[i].high - data[i].low;
        const hpc = Math.abs(data[i].high - data[i-1].close);
        const lpc = Math.abs(data[i].low - data[i-1].close);
        tr.push({ time: data[i].time, value: Math.max(hl, hpc, lpc) });
    }

    // ATR as EMA of TR
    const k = 2 / (period + 1);
    let prevAtr = tr[1] ? tr[1].value : (data[0].high - data[0].low);

    for (let i = 0; i < tr.length; i++) {
        if (i === 0) {
            atr.push({ time: tr[i].time, value: 0 });
        } else if (i < period) {
            // Warm-up: simple average
            let sum = 0;
            for (let j = 0; j <= i; j++) sum += tr[j].value;
            prevAtr = sum / (i + 1);
            atr.push({ time: tr[i].time, value: prevAtr });
        } else {
            const currAtr = tr[i].value * k + prevAtr * (1 - k);
            atr.push({ time: tr[i].time, value: currAtr });
            prevAtr = currAtr;
        }
    }
    return atr;
}

// ─── VOLATILITY STUDY ────────────────────────────────────────────────────────

function calculateHV(bars, window = 20) {
    // Annualized historical volatility (as percentage, e.g. 45 = 45%)
    const n = bars.length;
    const logRet = new Float64Array(n);
    for (let i = 1; i < n; i++) {
        if (bars[i - 1].close > 0 && bars[i].close > 0) {
            logRet[i] = Math.log(bars[i].close / bars[i - 1].close);
        }
    }
    const result = [];
    for (let i = 0; i < n; i++) {
        if (i < window - 1) { result.push({ time: bars[i].time, value: null }); continue; }
        let sum = 0, sumSq = 0;
        for (let j = i - window + 1; j <= i; j++) { sum += logRet[j]; sumSq += logRet[j] * logRet[j]; }
        const mean = sum / window;
        const variance = (sumSq - window * mean * mean) / (window - 1);
        result.push({ time: bars[i].time, value: Math.sqrt(Math.max(0, variance) * 252) * 100 });
    }
    return result;
}

function calculateAtrPct(bars, period = 14) {
    // ATR as percentage of closing price
    const atr = calculateATR(bars, period);
    return atr.map((d, i) => {
        const close = bars[i] ? bars[i].close : 0;
        if (!close || !d.value) return { time: d.time, value: null };
        return { time: d.time, value: (d.value / close) * 100 };
    });
}

function calculateRollingPercentile(valueSeries, rankWindow = 252) {
    // Rolling percentile rank of each value vs its own trailing history (0–100)
    const n = valueSeries.length;
    const result = [];
    for (let i = 0; i < n; i++) {
        const cur = valueSeries[i].value;
        if (cur === null || cur === undefined) { result.push({ time: valueSeries[i].time, value: null }); continue; }
        const start = Math.max(0, i - rankWindow + 1);
        let count = 0, total = 0;
        for (let j = start; j <= i; j++) {
            const v = valueSeries[j].value;
            if (v !== null && v !== undefined) { total++; if (v <= cur) count++; }
        }
        result.push({ time: valueSeries[i].time, value: total > 1 ? (count / total) * 100 : 50 });
    }
    return result;
}

function getVolBucket(pct) {
    if (pct === null || pct === undefined) return null;
    if (pct < 25) return 'Low';
    if (pct < 75) return 'Medium';
    if (pct < 90) return 'High';
    return 'Extreme';
}

// ─── DIVERGENCE DETECTION ───────────────────────────────────────────────────

function findPriceSwingPivots(data, pivotWindow = 5) {
    /** Price-bar pivots using high/low. Returns { pivotHighs, pivotLows } as index arrays. */
    const pivotHighs = [];
    const pivotLows  = [];

    for (let i = pivotWindow; i < data.length - pivotWindow; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= pivotWindow; j++) {
            if (data[i].high <= data[i-j].high || data[i].high <= data[i+j].high) isHigh = false;
            if (data[i].low  >= data[i-j].low  || data[i].low  >= data[i+j].low)  isLow  = false;
        }
        if (isHigh) pivotHighs.push(i);
        if (isLow)  pivotLows.push(i);
    }

    return { pivotHighs, pivotLows };
}

function findIndicatorSwingPivots(data, pivotWindow = 5) {
    /** Indicator pivots using .value field. Returns { pivotHighs, pivotLows } as index arrays. */
    const pivotHighs = [];
    const pivotLows  = [];

    for (let i = pivotWindow; i < data.length - pivotWindow; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= pivotWindow; j++) {
            if (data[i].value === undefined || data[i-j].value === undefined || data[i+j].value === undefined) {
                isHigh = false; isLow = false;
                break;
            }
            if (data[i].value <= data[i-j].value || data[i].value <= data[i+j].value) isHigh = false;
            if (data[i].value >= data[i-j].value || data[i].value >= data[i+j].value) isLow  = false;
        }
        if (isHigh) pivotHighs.push(i);
        if (isLow)  pivotLows.push(i);
    }

    return { pivotHighs, pivotLows };
}

function findNearestPivotIndex(targetIdx, pivotIndices, maxDistance) {
    let bestIdx = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const pivotIdx of pivotIndices) {
        const distance = Math.abs(pivotIdx - targetIdx);
        if (distance <= maxDistance && distance < bestDistance) {
            bestIdx = pivotIdx;
            bestDistance = distance;
        }
    }

    return bestIdx;
}

function detectDivergences(priceData, indicatorData, pivotWindow = 5) {
    /** Return divergence markers: { type: 'bullish'|'bearish', barIdx, source }
     *  Uses price high/low pivots and indicator value pivots separately.
     *  Price pivots are matched to the nearest indicator pivot within pivotWindow bars
     *  to avoid suppressing valid signals that do not peak on the exact same candle. */
    const { pivotHighs: pH, pivotLows: pL } = findPriceSwingPivots(priceData, pivotWindow);
    const { pivotHighs: iH, pivotLows: iL } = findIndicatorSwingPivots(indicatorData, pivotWindow);
    const markers = [];
    let lastDivBar = -999;

    for (let idx = 1; idx < pL.length; idx++) {
        const prevPriceLow = pL[idx - 1];
        const currPriceLow = pL[idx];
        const prevIndicatorLow = findNearestPivotIndex(prevPriceLow, iL, pivotWindow);
        const currIndicatorLow = findNearestPivotIndex(currPriceLow, iL, pivotWindow);

        if (prevIndicatorLow < 0 || currIndicatorLow < 0) continue;

        const priceLowerLow = priceData[currPriceLow].low < priceData[prevPriceLow].low;
        const indHigherLow = indicatorData[currIndicatorLow].value > indicatorData[prevIndicatorLow].value;

        if (priceLowerLow && indHigherLow && currPriceLow - lastDivBar > pivotWindow * 2) {
            markers.push({ type: 'bullish', barIdx: currPriceLow });
            lastDivBar = currPriceLow;
        }
    }

    for (let idx = 1; idx < pH.length; idx++) {
        const prevPriceHigh = pH[idx - 1];
        const currPriceHigh = pH[idx];
        const prevIndicatorHigh = findNearestPivotIndex(prevPriceHigh, iH, pivotWindow);
        const currIndicatorHigh = findNearestPivotIndex(currPriceHigh, iH, pivotWindow);

        if (prevIndicatorHigh < 0 || currIndicatorHigh < 0) continue;

        const priceHigherHigh = priceData[currPriceHigh].high > priceData[prevPriceHigh].high;
        const indLowerHigh = indicatorData[currIndicatorHigh].value < indicatorData[prevIndicatorHigh].value;

        if (priceHigherHigh && indLowerHigh && currPriceHigh - lastDivBar > pivotWindow * 2) {
            markers.push({ type: 'bearish', barIdx: currPriceHigh });
            lastDivBar = currPriceHigh;
        }
    }

    return markers;
}

function drawDivergenceMarkers(pane, markers) {
    if (!pane.candleSeries || typeof pane.candleSeries.setMarkers !== "function") return;

    const candleData = pane.historyData;
    const merged = new Map();

    markers.forEach(({ type, barIdx, source }) => {
        const bar = candleData[barIdx];
        if (!bar) return;

        const key = `${type}:${barIdx}`;
        if (!merged.has(key)) {
            merged.set(key, {
                time: bar.time,
                position: type === "bullish" ? "belowBar" : "aboveBar",
                color: type === "bullish" ? "#00e676" : "#ff5252",
                shape: type === "bullish" ? "arrowUp" : "arrowDown",
                sources: new Set(),
            });
        }

        if (source) {
            merged.get(key).sources.add(source);
        }
    });

    pane.divergenceMarkers = Array.from(merged.values())
        .sort((a, b) => a.time - b.time)
        .map(marker => ({
            time: marker.time,
            position: marker.position,
            color: marker.color,
            shape: marker.shape,
            text: `${marker.position === "belowBar" ? "Bullish" : "Bearish"}${marker.sources.size > 0 ? ` ${Array.from(marker.sources).join("/")}` : ""}`,
        }));

    pane.candleSeries.setMarkers(pane.divergenceMarkers);
}

function clearDivergenceMarkers(pane) {
    pane.divergenceMarkers = [];
    if (pane.candleSeries && typeof pane.candleSeries.setMarkers === "function") {
        pane.candleSeries.setMarkers([]);
    }
}

function updatePriceScaleMargins(pane) {
    // Main chart only — oscillators are now separate subchart panels
    pane.chart.priceScale('right').applyOptions({
        scaleMargins: {
            top: 0.05,
            bottom: 0.05
        }
    });
    pane.subchartBoundaries = [];
}

function updateMetricLabels(pane) {
    const inds = pane.indicators;
    const settings = inds.settings || {};

    if (pane.dom.atrMetric && pane.dom.atrLabel && pane.dom.atrValue) {
        if (inds.atr) {
            const atrSeries = calculateATR(pane.historyData, settings.atrPeriod || 14);
            const atrVal = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1].value : null;
            const price = pane.lastBar?.close || pane.lastPrice || null;
            const atrPct = (price && atrVal !== null && Number.isFinite(atrVal) && price !== 0)
                ? (atrVal / price) * 100
                : null;

            pane.dom.atrMetric.classList.remove("metric-hidden");
            pane.dom.atrLabel.textContent = `ATR(${settings.atrPeriod || 14})`;
            pane.dom.atrValue.textContent = atrVal !== null && atrPct !== null
                ? `${formatAtrValue(atrVal)} | ${atrPct.toFixed(2)}%`
                : "--";
            pane.dom.atrValue.className = "metric-value";
        } else {
            pane.dom.atrMetric.classList.add("metric-hidden");
            pane.dom.atrLabel.textContent = `ATR(${settings.atrPeriod || 14})`;
            pane.dom.atrValue.textContent = "--";
            pane.dom.atrValue.className = "metric-value";
        }
    }
    
    pane.dom.cvdLabel.textContent = isCryptoSymbol(pane.symbol) ? "CVD" : "Est. CVD";
    const val = pane.lastCvd || 0;
    pane.dom.cvdValue.textContent = formatCvd(val);
    pane.dom.cvdValue.className = "metric-value " + (val >= 0 ? "up" : "down");

    if (pane.dom.volMetric) {
        if (inds.vol && pane._volLastPct !== null && pane._volLastPct !== undefined) {
            pane.dom.volMetric.classList.remove("metric-hidden");
            const bucket = getVolBucket(pane._volLastPct);
            pane.dom.volBucket.textContent = bucket || "--";
            pane.dom.volBucket.className = `metric-value vol-bucket vol-bucket-${(bucket || 'unknown').toLowerCase()}`;
            pane.dom.volHv.textContent = pane._volLastHv !== null
                ? `HV ${pane._volLastHv.toFixed(1)}%`
                : "";
        } else {
            pane.dom.volMetric.classList.add("metric-hidden");
        }
    }
}

function applyChartSettings(pane) {
    const settings = pane.indicators.settings || {};
    const showVert = settings.showVertGrid !== false && pane.timeframe !== '1d';
    pane.chart.applyOptions({
        grid: {
            vertLines: {
                color: '#1a202c',
                visible: showVert
            },
            horzLines: {
                color: '#1a202c',
                visible: settings.showHorzGrid !== false
            }
        }
    });
}

// ─── SUBCHART PANEL ENGINE ──────────────────────────────────────────────────
// Oscillators are rendered as separate canvas panels below the main chart.

const SUBCHART_DEFS = {
    vwrsi: {
        title: 'VW-RSI',
        defaultHeight: 120,
        minHeight: 30,
        maxHeight: 9999,
        render: renderSubchartVWRSI,
        compute: (pane, settings) => calculateVWRSI(pane.historyData, settings.vwrsiPeriod || 14)
    },
    vwmacd: {
        title: 'VW-MACD',
        defaultHeight: 130,
        minHeight: 30,
        maxHeight: 9999,
        render: renderSubchartVWMACD,
        compute: (pane, settings) => calculateVWMACD(pane.historyData, settings.vwmacdFast || 12, settings.vwmacdSlow || 26, settings.vwmacdSignal || 9)
    },
    bvd: {
        title: 'BAR VOL DELTA',
        defaultHeight: 100,
        minHeight: 30,
        maxHeight: 9999,
        render: renderSubchartBVD,
        compute: (pane, settings) => calculateBarVolumeDelta(pane.historyData)
    },
    vol: {
        title: 'VOLATILITY',
        defaultHeight: 120,
        minHeight: 30,
        maxHeight: 9999,
        render: renderSubchartVol,
        compute: (pane, settings) => {
            const hv = calculateHV(pane.historyData, settings.hvWindow || 20);
            const atrPct = calculateAtrPct(pane.historyData, settings.atrPeriod || 14);
            const rankWindow = settings.volRankWindow || 252;
            return {
                hvPct: calculateRollingPercentile(hv, rankWindow).filter(d => d.value !== null),
                atrPct: calculateRollingPercentile(atrPct, rankWindow).filter(d => d.value !== null)
            };
        }
    }
};

function ensureSubchartPanel(pane, oscId) {
    if (pane.subchartPanels[oscId]) return pane.subchartPanels[oscId];
    const def = SUBCHART_DEFS[oscId];
    if (!def) return null;

    const subchartsEl = pane.dom.subchartsArea;
    if (!subchartsEl) return null;

    // Create panel DOM
    const panel = document.createElement('div');
    panel.className = 'subchart-panel';
    panel.dataset.osc = oscId;

    const dragHandle = document.createElement('div');
    dragHandle.className = 'subchart-drag-handle';
    panel.appendChild(dragHandle);

    const header = document.createElement('div');
    header.className = 'subchart-header';
    header.textContent = def.title;
    panel.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'subchart-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'subchart-canvas';
    wrap.appendChild(canvas);
    panel.appendChild(wrap);

    subchartsEl.appendChild(panel);

    // Set initial panel height so it's visible on first load
    panel.style.height = def.defaultHeight + 'px';

    // Size canvas
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width || 200;
    canvas.height = rect.height || def.defaultHeight;

    // Drag-to-resize
    let dragActive = false;
    const onDragStart = (e) => {
        e.preventDefault();
        dragActive = true;
        const startY = e.clientY;
        const startH = panel.getBoundingClientRect().height;
        const onMove = (me) => {
            if (!dragActive) return;
            const delta = startY - me.clientY;
            const newH = Math.max(def.minHeight, Math.min(def.maxHeight, startH + delta));
            panel.style.height = newH + 'px';
            canvas.width = wrap.clientWidth;
            canvas.height = wrap.clientHeight;
            renderAllSubcharts(pane);
        };
        const onUp = () => {
            dragActive = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };
    dragHandle.addEventListener('mousedown', onDragStart);

    const sp = { panel, canvas, ctx: canvas.getContext('2d'), wrap, def, dragHandle };
    pane.subchartPanels[oscId] = sp;
    return sp;
}

function removeSubchartPanel(pane, oscId) {
    const sp = pane.subchartPanels[oscId];
    if (!sp) return;
    sp.panel.remove();
    delete pane.subchartPanels[oscId];
}

function renderAllSubcharts(pane) {
    if (!pane.historyData || pane.historyData.length === 0) return;
    const inds = pane.indicators;
    const settings = inds.settings || {};

    // Ensure panels exist for enabled oscillators
    const activeOscs = [];
    if (inds.vwrsi) activeOscs.push('vwrsi');
    if (inds.vwmacd) activeOscs.push('vwmacd');
    if (inds.bvd) activeOscs.push('bvd');
    if (inds.vol) activeOscs.push('vol');

    // Remove panels for disabled oscillators
    Object.keys(pane.subchartPanels).forEach(oscId => {
        if (!activeOscs.includes(oscId)) {
            removeSubchartPanel(pane, oscId);
        }
    });

    // Ensure panels for enabled oscillators and render
    activeOscs.forEach(oscId => {
        const sp = ensureSubchartPanel(pane, oscId);
        if (!sp) return;
        const wrap = sp.wrap;
        const rect = wrap.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            sp.canvas.width = rect.width;
            sp.canvas.height = rect.height;
        }
        const ctx = sp.ctx;
        const w = sp.canvas.width;
        const h = sp.canvas.height;
        if (w < 10 || h < 10) return;

        ctx.clearRect(0, 0, w, h);

        // Compute X offset so subchart drawing aligns with candle chart
        const contRect = pane.dom.container.getBoundingClientRect();
        const canRect = sp.canvas.getBoundingClientRect();
        const xOffset = contRect.left - canRect.left;

        // Compute data and render
        const def = SUBCHART_DEFS[oscId];
        if (def.compute && def.render) {
            const data = def.compute(pane, settings);
            def.render(pane, ctx, w, h, data, settings, xOffset);
        }
    });
}

// ─── Grid & Axis helpers for subchart canvases ───────────────────────────

function drawSubchartBackground(ctx, w, h) {
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, w, h);
}

function drawSubchartGrid(ctx, w, h, numLines, leftMargin, rightMargin) {
    ctx.strokeStyle = '#1a202c';
    ctx.lineWidth = 1;
    const chartW = w - leftMargin - rightMargin;
    for (let i = 0; i < numLines; i++) {
        const y = (i / (numLines - 1)) * h;
        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(leftMargin + chartW, y);
        ctx.stroke();
    }
}

function drawSubchartAxisRight(ctx, w, h, labels, title, rightMargin) {
    const axisW = rightMargin;
    const chartRight = w - axisW;

    // Axis background
    ctx.fillStyle = 'rgba(11, 14, 20, 0.95)';
    ctx.fillRect(chartRight, 0, axisW, h);

    // Separator line
    ctx.strokeStyle = 'rgba(42, 51, 71, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartRight, 0);
    ctx.lineTo(chartRight, h);
    ctx.stroke();

    // Labels
    ctx.font = '10px "Space Grotesk", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    labels.forEach(label => {
        if (label.y === null || label.y === undefined) return;
        const y = label.y;
        if (y < 0 || y > h) return;
        ctx.fillStyle = 'rgba(196, 206, 221, 0.9)';
        ctx.fillText(label.text, w - 6, y);
        // Small tick mark
        ctx.strokeStyle = 'rgba(42, 51, 71, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(chartRight, y);
        ctx.lineTo(chartRight + 6, y);
        ctx.stroke();
    });

    // Title at top
    ctx.font = 'bold 9px "Space Grotesk", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(174, 186, 204, 0.7)';
    ctx.fillText(title, w - 6, 4);
}

function getSubchartValueY(value, minVal, maxVal, h, margin) {
    if (maxVal === minVal) return h / 2;
    const range = maxVal - minVal;
    return margin + ((maxVal - value) / range) * (h - 2 * margin);
}

// ─── VW-RSI Subchart ────────────────────────────────────────────────────

function renderSubchartVWRSI(pane, ctx, w, h, data, settings, xOffset = 0) {
    const leftMargin = 0;
    const rightMargin = 74;
    const chartW = w - leftMargin - rightMargin;
    const topMargin = 4;

    drawSubchartBackground(ctx, w, h);
    drawSubchartGrid(ctx, w, h, 3, leftMargin, rightMargin);

    if (!data || data.length < 2) return;

    const timeScale = pane.chart.timeScale();

    // Build visible points with pixel X coords from main chart's time scale
    let visiblePoints = [];
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        if (d.value === undefined) continue;
        const x = timeScale.timeToCoordinate(d.time);
        if (x === null) continue;
        visiblePoints.push({ x: x + xOffset, value: d.value });
    }

    // Fallback: if timeToCoordinate returns null for all (e.g. chart settling), use linear interpolation
    if (visiblePoints.length < 2) {
        const ts = data.map(d => d.time).filter(t => t !== undefined);
        if (ts.length < 2) return;
        const visMin = ts[0], visMax = ts[ts.length - 1];
        if (visMax <= visMin) return;
        const chartW_ = w - leftMargin - rightMargin;
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            if (d.value === undefined) continue;
            const x = leftMargin + ((d.time - visMin) / (visMax - visMin)) * chartW_;
            visiblePoints.push({ x, value: d.value });
        }
    }
    if (visiblePoints.length < 2) return;

    // Value range
    const values = visiblePoints.map(d => d.value);
    const minVal = 0, maxVal = 100;

    // Reference lines (20, 50, 80)
    const refLines = [
        { value: 80, color: 'rgba(0, 230, 118, 0.25)' },
        { value: 50, color: 'rgba(124, 139, 161, 0.25)' },
        { value: 20, color: 'rgba(255, 23, 68, 0.25)' }
    ];
    refLines.forEach(ref => {
        const y = getSubchartValueY(ref.value, 0, 100, h, topMargin);
        ctx.strokeStyle = ref.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(leftMargin + chartW, y);
        ctx.stroke();
        ctx.setLineDash([]);
    });

    // Draw line using pixel-perfect X coordinates
    ctx.strokeStyle = '#ff9f43';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    visiblePoints.forEach((point, i) => {
        const y = getSubchartValueY(point.value, minVal, maxVal, h, topMargin);
        if (i === 0) ctx.moveTo(point.x, y);
        else ctx.lineTo(point.x, y);
    });
    ctx.stroke();

    // Axis labels
    const axisLabels = [
        { y: getSubchartValueY(80, minVal, maxVal, h, topMargin), text: '80' },
        { y: getSubchartValueY(50, minVal, maxVal, h, topMargin), text: '50' },
        { y: getSubchartValueY(20, minVal, maxVal, h, topMargin), text: '20' }
    ];
    drawSubchartAxisRight(ctx, w, h, axisLabels, 'VW-RSI', rightMargin);
}

// ─── VW-MACD Subchart ───────────────────────────────────────────────────

function renderSubchartVWMACD(pane, ctx, w, h, data, settings, xOffset = 0) {
    const leftMargin = 0;
    const rightMargin = 74;
    const chartW = w - leftMargin - rightMargin;
    const topMargin = 4;

    drawSubchartBackground(ctx, w, h);
    drawSubchartGrid(ctx, w, h, 3, leftMargin, rightMargin);

    if (!data || !data.macd || data.macd.length < 2) return;

    const timeScale = pane.chart.timeScale();

    // Filter visible points for MACD line, signal, histogram
    function buildVisible(arr) {
        const result = [];
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i];
            if (d.value === undefined) continue;
            const x = timeScale.timeToCoordinate(d.time);
            if (x === null) continue;
            result.push({ x: x + xOffset, value: d.value, color: d.color });
        }
        // Fallback: linear interpolation if no timeToCoordinate results
        if (result.length < 2 && arr.length >= 2) {
            const ts = arr.map(a => a.time).filter(t => t !== undefined);
            if (ts.length >= 2 && ts[ts.length-1] > ts[0]) {
                const chartW_ = w - 0 - 74;
                const span = ts[ts.length-1] - ts[0];
                for (let j = 0; j < arr.length; j++) {
                    const a = arr[j];
                    if (a.value === undefined) continue;
                    const x = ((a.time - ts[0]) / span) * chartW_;
                    result.push({ x, value: a.value, color: a.color });
                }
            }
        }
        return result;
    }
    const visMacd = buildVisible(data.macd);
    const visSignal = buildVisible(data.signal || []);
    const visHist = Array.isArray(data.histogram) ? buildVisible(data.histogram) : [];
    if (visMacd.length < 2) return;

    // Find value range
    let minVal = 0, maxVal = 0;
    const allVals = [
        ...visMacd.map(d => d.value),
        ...visSignal.map(d => d.value),
        ...visHist.map(d => d.value)
    ].filter(v => Number.isFinite(v));
    if (allVals.length > 0) {
        const spread = Math.max(Math.abs(Math.min(...allVals)), Math.abs(Math.max(...allVals)));
        minVal = -spread * 1.15;
        maxVal = spread * 1.15;
        if (minVal === maxVal) { minVal -= 1; maxVal += 1; }
    }

    // Zero line
    const zeroY = getSubchartValueY(0, minVal, maxVal, h, topMargin);
    ctx.strokeStyle = 'rgba(124, 139, 161, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftMargin, zeroY);
    ctx.lineTo(leftMargin + chartW, zeroY);
    ctx.stroke();

    // Histogram
    visHist.forEach(point => {
        const y0 = zeroY;
        const y1 = getSubchartValueY(point.value, minVal, maxVal, h, topMargin);
        ctx.fillStyle = point.color || (point.value >= 0 ? '#00e676' : '#ff1744');
        ctx.fillRect(point.x - 1, Math.min(y0, y1), Math.max(2, chartW / visHist.length * 0.7), Math.max(1, Math.abs(y1 - y0)));
    });

    // MACD line
    ctx.strokeStyle = '#29b6f6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    visMacd.forEach((point, i) => {
        const y = getSubchartValueY(point.value, minVal, maxVal, h, topMargin);
        if (i === 0) ctx.moveTo(point.x, y);
        else ctx.lineTo(point.x, y);
    });
    ctx.stroke();

    // Signal line
    if (visSignal.length >= 2) {
        ctx.strokeStyle = '#ab47bc';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        visSignal.forEach((point, i) => {
            const y = getSubchartValueY(point.value, minVal, maxVal, h, topMargin);
            if (i === 0) ctx.moveTo(point.x, y);
            else ctx.lineTo(point.x, y);
        });
        ctx.stroke();
    }

    // Axis labels
    const axisLabels = [
        { y: getSubchartValueY(maxVal, minVal, maxVal, h, topMargin), text: maxVal.toFixed(2) },
        { y: zeroY, text: '0.00' },
        { y: getSubchartValueY(minVal, minVal, maxVal, h, topMargin), text: minVal.toFixed(2) }
    ];
    drawSubchartAxisRight(ctx, w, h, axisLabels, 'VW-MACD', rightMargin);
}

// ─── Bar Volume Delta Subchart ──────────────────────────────────────────

function calculateBarVolumeDelta(data) {
    if (!data || data.length === 0) return [];
    const delta = [];
    data.forEach(bar => {
        // Approximate delta: close-open direction weighted by volume
        // Positive: buyers aggressive, Negative: sellers aggressive
        const dir = (bar.close - bar.open);
        const vol = bar.volume || 0;
        const val = dir * vol * 0.01;
        delta.push({ time: bar.time, value: val });
    });
    return delta;
}

function renderSubchartBVD(pane, ctx, w, h, data, settings, xOffset = 0) {
    const leftMargin = 0;
    const rightMargin = 74;
    const chartW = w - leftMargin - rightMargin;
    const topMargin = 4;

    drawSubchartBackground(ctx, w, h);

    if (!data || data.length < 2) return;

    const timeScale = pane.chart.timeScale();

    // Build visible points
    const visiblePoints = [];
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        if (d.value === undefined) continue;
        const x = timeScale.timeToCoordinate(d.time);
        if (x === null) continue;
        visiblePoints.push({ x: x + xOffset, value: d.value });
    }
    // Fallback: linear interpolation
    if (visiblePoints.length < 2 && data.length >= 2) {
        const ts = data.map(d => d.time).filter(t => t !== undefined);
        if (ts.length >= 2 && ts[ts.length-1] > ts[0]) {
            const span = ts[ts.length-1] - ts[0];
            for (let i = 0; i < data.length; i++) {
                const d = data[i];
                if (d.value === undefined) continue;
                const x = leftMargin + ((d.time - ts[0]) / span) * chartW;
                visiblePoints.push({ x, value: d.value });
            }
        }
    }
    if (visiblePoints.length < 2) return;

    // Find max absolute value
    const vals = visiblePoints.map(d => d.value).filter(v => Number.isFinite(v));
    const maxAbs = vals.length > 0 ? Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals)), 1) : 1;
    const range = maxAbs * 1.15;

    // Zero line
    const zeroY = h / 2;
    ctx.strokeStyle = 'rgba(124, 139, 161, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftMargin, zeroY);
    ctx.lineTo(leftMargin + chartW, zeroY);
    ctx.stroke();

    // Grid
    drawSubchartGrid(ctx, w, h, 3, leftMargin, rightMargin);

    // Delta bars
    const barWidth = Math.max(1, chartW / visiblePoints.length * 0.7);
    visiblePoints.forEach(point => {
        const barH = Math.abs((point.value / range) * h * 0.42);
        const y = point.value >= 0 ? zeroY - barH : zeroY;
        ctx.fillStyle = point.value >= 0 ? 'rgba(0, 230, 118, 0.7)' : 'rgba(255, 23, 68, 0.7)';
        ctx.fillRect(point.x - barWidth / 2, y, barWidth, Math.max(1, barH));
    });

    // Axis labels
    const axisLabels = [
        { y: 4, text: '+' + formatCvd(maxAbs) },
        { y: zeroY, text: '0' },
        { y: h - 4, text: '-' + formatCvd(maxAbs) }
    ];
    drawSubchartAxisRight(ctx, w, h, axisLabels, 'DELTA', rightMargin);
}

// ─── Volatility Subchart ─────────────────────────────────────────────────

function renderSubchartVol(pane, ctx, w, h, data, settings, xOffset = 0) {
    const leftMargin = 0;
    const rightMargin = 74;
    const chartW = w - leftMargin - rightMargin;
    const topMargin = 4;

    drawSubchartBackground(ctx, w, h);
    drawSubchartGrid(ctx, w, h, 3, leftMargin, rightMargin);

    if (!data || !data.hvPct || data.hvPct.length < 2) return;

    const timeScale = pane.chart.timeScale();

    function buildVisible(arr) {
        const result = [];
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i];
            if (d.value === undefined || d.value === null) continue;
            const x = timeScale.timeToCoordinate(d.time);
            if (x === null) continue;
            result.push({ x: x + xOffset, value: d.value });
        }
        // Fallback: linear interpolation
        if (result.length < 2 && arr.length >= 2) {
            const ts = arr.map(a => a.time).filter(t => t !== undefined);
            if (ts.length >= 2 && ts[ts.length-1] > ts[0]) {
                const chartW_ = w - 0 - 74;
                const span = ts[ts.length-1] - ts[0];
                for (let j = 0; j < arr.length; j++) {
                    const a = arr[j];
                    if (a.value === undefined || a.value === null) continue;
                    const x = ((a.time - ts[0]) / span) * chartW_;
                    result.push({ x, value: a.value });
                }
            }
        }
        return result;
    }
    const visHv = buildVisible(data.hvPct);
    const visAtr = buildVisible(data.atrPct || []);
    if (visHv.length < 2) return;

    const minVal = 0, maxVal = 100;

    // Reference lines (25, 75, 90)
    const refLines = [
        { value: 90, color: 'rgba(255, 82, 82, 0.2)' },
        { value: 75, color: 'rgba(255, 152, 0, 0.2)' },
        { value: 25, color: 'rgba(76, 175, 80, 0.2)' }
    ];
    refLines.forEach(ref => {
        const y = getSubchartValueY(ref.value, minVal, maxVal, h, topMargin);
        ctx.strokeStyle = ref.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(leftMargin + chartW, y);
        ctx.stroke();
        ctx.setLineDash([]);
    });

    // HV%ile line
    ctx.strokeStyle = '#00bcd4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    visHv.forEach((point, i) => {
        const y = getSubchartValueY(point.value, minVal, maxVal, h, topMargin);
        if (i === 0) ctx.moveTo(point.x, y);
        else ctx.lineTo(point.x, y);
    });
    ctx.stroke();

    // ATR%ile line
    if (visAtr.length >= 2) {
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        visAtr.forEach((point, i) => {
            const y = getSubchartValueY(point.value, minVal, maxVal, h, topMargin);
            if (i === 0) ctx.moveTo(point.x, y);
            else ctx.lineTo(point.x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Axis labels
    const axisLabels = [
        { y: getSubchartValueY(90, minVal, maxVal, h, topMargin), text: 'Extr' },
        { y: getSubchartValueY(75, minVal, maxVal, h, topMargin), text: 'Hi' },
        { y: getSubchartValueY(25, minVal, maxVal, h, topMargin), text: 'Low' }
    ];
    drawSubchartAxisRight(ctx, w, h, axisLabels, 'VOLATILITY', rightMargin);
}

function drawVolumeProfile(pane) {
    const decorationOverlay = pane.decorationOverlay;
    if (!decorationOverlay) return;
    decorationOverlay.innerHTML = "";
    decorationOverlay.dataset.dayStarts = "0";
    decorationOverlay.dataset.profileBars = "0";
    decorationOverlay.dataset.sessionBars = "0";
    decorationOverlay.dataset.overlayChildren = "0";

    const profileData = (pane.volumeProfileData && pane.volumeProfileData.length > 0)
        ? pane.volumeProfileData
        : pane.historyData;

    const settings = pane.indicators.settings || {};

    // ── Day-start lines (always on main chart overlay) ──
    const dayStartTimes = getDayStartTimes(pane, pane.historyData || []);
    decorationOverlay.dataset.dayStarts = String(dayStartTimes.length);
    dayStartTimes.forEach(time => {
        const x = pane.chart.timeScale().timeToCoordinate(time);
        if (x === null || !Number.isFinite(x)) return;
        const line = document.createElement("div");
        line.className = "day-start-line";
        line.style.left = `${Math.round(x)}px`;
        decorationOverlay.appendChild(line);
    });
    decorationOverlay.dataset.overlayChildren = String(decorationOverlay.children.length);

    if (!pane.indicators.volumeProfile || !profileData || profileData.length === 0) return;
    decorationOverlay.dataset.profileBars = String(profileData.length);

    const sessionGroups = getDailySessionGroups(pane, profileData);
    decorationOverlay.dataset.sessionBars = String(sessionGroups.length);
    if (sessionGroups.length === 0) return;

    // Separate current vs previous sessions
    const currentGroup  = sessionGroups.find(g => g.isCurrent);
    const previousGroups = sessionGroups.filter(g => !g.isCurrent);

    // ── ALL previous session profiles → faded overlay on main chart ──
    previousGroups.forEach(prevGroup => {
        if (!prevGroup || prevGroup.bars.length === 0) return;
        const prevModel = buildVolumeProfileModelForBars(prevGroup.bars, settings);
        if (!prevModel || prevModel.maxVol <= 0) return;

        // Anchor at this session's first bar time
        const anchorTime = prevGroup.startTime || prevGroup.bars[0].time;
        const anchorX = pane.chart.timeScale().timeToCoordinate(anchorTime);
        if (anchorX === null || !Number.isFinite(anchorX)) return;

        // Calculate the width of this day's visible candle range
        const endTime = prevGroup.bars[prevGroup.bars.length - 1].time;
        const endX = pane.chart.timeScale().timeToCoordinate(endTime);
        let dayWidth;
        if (endX !== null && Number.isFinite(endX) && endX > anchorX) {
            dayWidth = endX - anchorX;
        } else {
            dayWidth = Math.max(16, Math.min(Math.round(pane.dom.container.clientWidth * 0.12), 70));
        }
        const prevBarMaxW = Math.max(12, Math.min(Math.round(dayWidth), 90));

        const block = document.createElement("div");
        block.className = "prev-session-block";
        block.style.left   = `${Math.round(anchorX)}px`;
        block.style.top    = "0";
        block.style.width  = `${prevBarMaxW}px`;
        block.style.height = `${pane.dom.container.clientHeight}px`;

        prevModel.bins.forEach((vol, idx) => {
            if (vol <= 0) return;
            const priceTop = prevModel.minPrice + (idx + 1) * prevModel.binSize;
            const priceBot = prevModel.minPrice + idx * prevModel.binSize;
            const yTop = pane.candleSeries.priceToCoordinate(priceTop);
            const yBot = pane.candleSeries.priceToCoordinate(priceBot);
            if (yTop === null || yBot === null) return;

            const barH   = Math.abs(yBot - yTop);
            const barLen = Math.max(2, (vol / prevModel.maxVol) * prevBarMaxW);
            const isPoc  = idx === prevModel.pocBinIndex;
            const isVA   = idx >= prevModel.valueAreaLow && idx <= prevModel.valueAreaHigh;

            const bar = document.createElement("div");
            bar.className = "prev-vp-bar" + (isPoc ? " poc" : (isVA ? " va" : ""));
            bar.style.top    = `${Math.min(yTop, yBot)}px`;
            bar.style.left   = "0";
            bar.style.width  = `${barLen}px`;
            bar.style.height = `${Math.max(1, barH - 1)}px`;
            block.appendChild(bar);
        });

        decorationOverlay.appendChild(block);

        // POC / VAH / VAL marker lines for the most recent previous session only
        if (prevGroup === previousGroups[previousGroups.length - 1]) {
            const prevPocPrice = prevModel.minPrice + (prevModel.pocBinIndex + 0.5) * prevModel.binSize;
            const prevVahPrice = prevModel.minPrice + (prevModel.valueAreaHigh + 0.5) * prevModel.binSize;
            const prevValPrice = prevModel.minPrice + (prevModel.valueAreaLow  + 0.5) * prevModel.binSize;

            [[prevPocPrice, 'Y POC', 'prev-marker-poc'],
             [prevVahPrice, 'Y VAH', 'prev-marker-vah'],
             [prevValPrice, 'Y VAL', 'prev-marker-val']].forEach(([price, label, cls]) => {
                const y = pane.candleSeries.priceToCoordinate(price);
                if (y === null) return;
                const line = document.createElement("div");
                line.className = `prev-marker-line ${cls}`;
                line.style.top = `${y}px`;
                decorationOverlay.appendChild(line);

                const txt = document.createElement("div");
                txt.className = `prev-marker-text ${cls}`;
                txt.style.top = `${y}px`;
                txt.textContent = `${label} ${formatPrice(price)}`;
                decorationOverlay.appendChild(txt);
            });
        }
    });

    // ── Current session VP → overlay on main chart (offset left of price scale) ──
    if (!currentGroup || currentGroup.bars.length === 0) return;

    const model = buildVolumeProfileModelForBars(currentGroup.bars, settings);
    if (!model || model.maxVol <= 0) return;

    // Offset from right edge to sit LEFT of the built-in price scale (~65px wide)
    const priceScaleOffset = 65;
    const barMaxW = 80;

    const block = document.createElement("div");
    block.className = "current-session-block";
    block.style.right  = `${priceScaleOffset}px`;
    block.style.top    = "0";
    block.style.width  = `${barMaxW}px`;
    block.style.height = `${pane.dom.container.clientHeight}px`;

    model.bins.forEach((vol, idx) => {
        if (vol <= 0) return;
        const priceTop = model.minPrice + (idx + 1) * model.binSize;
        const priceBot = model.minPrice + idx * model.binSize;
        const yTop = pane.candleSeries.priceToCoordinate(priceTop);
        const yBot = pane.candleSeries.priceToCoordinate(priceBot);
        if (yTop === null || yBot === null) return;

        const barH   = Math.abs(yBot - yTop);
        const barLen = Math.max(2, (vol / model.maxVol) * barMaxW);
        const isPoc  = idx === model.pocBinIndex;
        const isVA   = idx >= model.valueAreaLow && idx <= model.valueAreaHigh;

        const bar = document.createElement("div");
        bar.className = "curr-vp-bar" + (isPoc ? " poc" : (isVA ? " va" : ""));
        bar.style.top    = `${Math.min(yTop, yBot)}px`;
        bar.style.right  = "0px";
        bar.style.width  = `${barLen}px`;
        bar.style.height = `${Math.max(1, barH - 1)}px`;
        block.appendChild(bar);
    });

    decorationOverlay.appendChild(block);

    // POC / VAH / VAL marker lines for current session
    const pocPrice = model.minPrice + (model.pocBinIndex  + 0.5) * model.binSize;
    const vahPrice = model.minPrice + (model.valueAreaHigh + 0.5) * model.binSize;
    const valPrice = model.minPrice + (model.valueAreaLow  + 0.5) * model.binSize;

    [[pocPrice, 'POC', 'curr-marker-poc'],
     [vahPrice, 'VAH', 'curr-marker-vah'],
     [valPrice, 'VAL', 'curr-marker-val']].forEach(([price, label, cls]) => {
        const y = pane.candleSeries.priceToCoordinate(price);
        if (y === null) return;
        const line = document.createElement("div");
        line.className = `curr-marker-line ${cls}`;
        line.style.top = `${y}px`;
        decorationOverlay.appendChild(line);

        const txt = document.createElement("div");
        txt.className = `curr-marker-text ${cls}`;
        txt.style.top = `${y}px`;
        txt.textContent = `${label} ${formatPrice(price)}`;
        decorationOverlay.appendChild(txt);
    });
}

// ─── Delta Profile (left panel) ──────────────────────────────────────────

function drawDeltaProfile(pane) {
    const canvas = pane.dom.deltaCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!pane.indicators.deltaProfile || !pane.historyData || pane.historyData.length < 2) {
        return;
    }

    // Background
    ctx.fillStyle = 'rgba(10, 12, 20, 0.85)';
    ctx.fillRect(0, 0, w, h);

    // Title
    ctx.font = 'bold 9px "Space Grotesk", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(174, 186, 204, 0.7)';
    ctx.fillText('DELTA', w / 2, 2);

    // Get visible bars from the main chart
    const visibleRange = pane.chart ? pane.chart.timeScale().getVisibleRange() : null;
    if (!visibleRange || !visibleRange.from || !visibleRange.to) return;

    const visibleBars = pane.historyData.filter(d =>
        d.time >= visibleRange.from && d.time <= visibleRange.to
    );
    if (visibleBars.length < 2) return;

    // Compute per-bar delta
    let minPrice = Infinity, maxPrice = -Infinity;
    const priceDeltas = new Map();
    visibleBars.forEach(bar => {
        minPrice = Math.min(minPrice, bar.low);
        maxPrice = Math.max(maxPrice, bar.high);
        // Simple delta estimate
        const dir = bar.close - bar.open;
        const delta = dir * (bar.volume || 0) * 0.01;
        if (!priceDeltas.has(bar.low)) priceDeltas.set(bar.low, 0);
        if (!priceDeltas.has(bar.high)) priceDeltas.set(bar.high, 0);
        priceDeltas.set(bar.low, (priceDeltas.get(bar.low) || 0) + delta);
        priceDeltas.set(bar.high, (priceDeltas.get(bar.high) || 0) + delta);
    });

    if (minPrice === maxPrice) return;
    const priceRange = maxPrice - minPrice;

    // Find max absolute delta for scaling
    let maxAbsDelta = 1;
    priceDeltas.forEach(delta => { maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta)); });

    // Draw delta bars per price level
    const numBins = Math.min(40, Math.max(10, Math.floor(h / 4)));
    const binSize = priceRange / numBins;
    const binDeltas = new Float64Array(numBins);
    const binCounts = new Uint16Array(numBins);

    visibleBars.forEach(bar => {
        const delta = (bar.close - bar.open) * (bar.volume || 0) * 0.01;
        const barMid = (bar.high + bar.low) / 2;
        const binIdx = Math.max(0, Math.min(numBins - 1, Math.floor((barMid - minPrice) / binSize)));
        binDeltas[binIdx] += delta;
        binCounts[binIdx]++;
    });

    const barW = w - 4;
    const maxBar = Math.max(1, ...binDeltas.map(d => Math.abs(d)));

    for (let i = 0; i < numBins; i++) {
        if (binCounts[i] === 0) continue;
        const price = minPrice + (i + 0.5) * binSize;
        const y = pane.candleSeries.priceToCoordinate(price);
        if (y === null) continue;

        const deltaVal = binDeltas[i];
        const barLen = Math.max(1, Math.abs(deltaVal) / maxBar * barW);
        const xStart = deltaVal >= 0 ? w - 2 - barLen : w - 2;
        ctx.fillStyle = deltaVal >= 0 ? 'rgba(0, 230, 118, 0.6)' : 'rgba(255, 23, 68, 0.6)';
        ctx.fillRect(xStart, y - 1, barLen, Math.max(2, h / numBins));
    }
}

// ─── Time Axis (bottom of pane) ─────────────────────────────────────────

function renderTimeAxis(pane) {
    const canvas = pane.dom.timeCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!pane.chart) return;

    const timeScale = pane.chart.timeScale();
    const rightMargin = 74;

    // Compute X offset for alignment with candle chart
    const contRect = pane.dom.container.getBoundingClientRect();
    const canRect = canvas.getBoundingClientRect();
    const xOffset = contRect.left - canRect.left;

    // Background
    ctx.fillStyle = '#151a24';
    ctx.fillRect(0, 0, w, h);

    // Separator on right to match subchart axis
    ctx.fillStyle = 'rgba(11, 14, 20, 0.95)';
    ctx.fillRect(w - rightMargin, 0, rightMargin, h);

    // Get visible range from main chart's time scale
    const vr = timeScale.getVisibleRange();
    if (!vr || !vr.from || !vr.to) return;
    const span = vr.to - vr.from;
    if (span <= 0) return;

    // Determine tick interval based on visible span
    let tickInterval, labelFormat;
    if (span < 1800) {
        tickInterval = 300;
        labelFormat = 'time';
    } else if (span < 7200) {
        tickInterval = 900;
        labelFormat = 'time';
    } else if (span < 21600) {
        tickInterval = 1800;
        labelFormat = 'time';
    } else if (span < 86400) {
        tickInterval = 3600;
        labelFormat = 'time';
    } else if (span < 604800) {
        tickInterval = 14400;
        labelFormat = 'daytime';
    } else if (span < 2592000) {
        tickInterval = 86400;
        labelFormat = 'date';
    } else {
        tickInterval = 604800;
        labelFormat = 'date';
    }

    const firstTick = Math.ceil(vr.from / tickInterval) * tickInterval;
    ctx.font = '10px "Space Grotesk", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let t = firstTick; t <= vr.to; t += tickInterval) {
        const x = timeScale.timeToCoordinate(t);
        if (x === null) continue;
        const drawX = x + xOffset;
        if (drawX < 0 || drawX > w - rightMargin) continue;

        ctx.strokeStyle = 'rgba(42, 51, 71, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(drawX, 0);
        ctx.lineTo(drawX, h);
        ctx.stroke();

        const d = new Date(t * 1000);
        let label;
        if (labelFormat === 'time') {
            label = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        } else if (labelFormat === 'daytime') {
            label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
                    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        } else {
            label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        ctx.fillStyle = '#8e9aaf';
        ctx.fillText(label, drawX, h / 2);
    }

    ctx.strokeStyle = 'rgba(42, 51, 71, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w - rightMargin, 0);
    ctx.lineTo(w - rightMargin, h);
    ctx.stroke();
}

// --- INDICATOR UI AND DATA BINDINGS ---

function applyIndicators(pane) {
    if (!pane.historyData || pane.historyData.length === 0) return;
    
    const inds = pane.indicators;
    const settings = inds.settings || {};

    applyChartSettings(pane);
    
    // 1. Overlay Visibility options
    pane.vwapSeries.applyOptions({ visible: inds.vwap });
    pane.ema10Series.applyOptions({ visible: inds.ema10 });
    pane.ema20Series.applyOptions({ visible: inds.ema20 });
    pane.ema50Series.applyOptions({ visible: inds.ema50 });
    pane.ema100Series.applyOptions({ visible: inds.ema100 });
    pane.ema200Series.applyOptions({ visible: inds.ema200 });
    pane.bbUpperSeries.applyOptions({ visible: inds.bbands });
    pane.bbMiddleSeries.applyOptions({ visible: inds.bbands });
    pane.bbLowerSeries.applyOptions({ visible: inds.bbands });
    
    // 2. Set series data for overlays
    if (inds.ema10) {
        pane.ema10Series.setData(calculateEMA(pane.historyData, settings.ema10Period || 10));
    }
    if (inds.ema20) {
        pane.ema20Series.setData(calculateEMA(pane.historyData, settings.ema20Period || 20));
    }
    if (inds.ema50) {
        pane.ema50Series.setData(calculateEMA(pane.historyData, settings.ema50Period || 50));
    }
    if (inds.ema100) {
        pane.ema100Series.setData(calculateEMA(pane.historyData, settings.ema100Period || 100));
    }
    if (inds.ema200) {
        pane.ema200Series.setData(calculateEMA(pane.historyData, settings.ema200Period || 200));
    }
    if (inds.bbands) {
        const bb = calculateBollingerBands(pane.historyData, settings.bbPeriod || 20, settings.bbStdDev || 2);
        pane.bbUpperSeries.setData(bb.upper);
        pane.bbMiddleSeries.setData(bb.middle);
        pane.bbLowerSeries.setData(bb.lower);
    }
    
    // 3. Toggle Volume Profile right panel
    if (pane.dom.vpRight) {
        pane.dom.vpRight.classList.toggle('active', !!inds.volumeProfile);
    }
    // Toggle Delta Profile left panel
    if (pane.dom.ofPanel) {
        pane.dom.ofPanel.classList.toggle('active', !!inds.deltaProfile);
    }
    
    // Recalculate margins (simple — no oscillators in main chart)
    updatePriceScaleMargins(pane);

    // 4. Render subchart oscillator panels (creates/removes canvas panels)
    renderAllSubcharts(pane);
    
    // 5. Volatility last values for toolbar (cache)
    if (inds.vol) {
        const hvWindow  = settings.hvWindow  || 20;
        const rankWindow = settings.volRankWindow || 252;
        const hv        = calculateHV(pane.historyData, hvWindow);
        const atrPct    = calculateAtrPct(pane.historyData, settings.atrPeriod || 14);
        const hvPct     = calculateRollingPercentile(hv, rankWindow);
        const lastHv  = hv.filter(d => d.value !== null).slice(-1)[0];
        const lastPct = hvPct.filter(d => d.value !== null).slice(-1)[0];
        pane._volLastHv  = lastHv  ? lastHv.value  : null;
        pane._volLastPct = lastPct ? lastPct.value : null;
    }
    
    // 6. Divergence detection (run after indicators are computed)
    if (inds.divergence && (inds.vwrsi || inds.vwmacd)) {
        const allMarkers = [];

        if (inds.vwrsi) {
            const vwrsiData = calculateVWRSI(pane.historyData, settings.vwrsiPeriod || 14);
            allMarkers.push(...detectDivergences(pane.historyData, vwrsiData, 5).map(marker => ({
                ...marker,
                source: "VW-RSI",
            })));
        }

        if (inds.vwmacd) {
            const vwmacdResult = calculateVWMACD(
                pane.historyData,
                settings.vwmacdFast || 12,
                settings.vwmacdSlow || 26,
                settings.vwmacdSignal || 9
            );
            const vwmacdIndicator = vwmacdResult.histogram.map(h => ({ time: h.time, value: h.value }));
            allMarkers.push(...detectDivergences(pane.historyData, vwmacdIndicator, 5).map(marker => ({
                ...marker,
                source: "VW-MACD",
            })));
        }

        drawDivergenceMarkers(pane, allMarkers);
    } else {
        clearDivergenceMarkers(pane);
    }
    
    // Update metric label displaying in the top bar
    updateMetricLabels(pane);
    
    // Trigger Volume Profile drawing on right panel
    requestVolumeProfileDraw(pane);
    renderTimeAxis(pane);

    // 7. Regime Detector —
    if (inds.regime) {
        initRegimeForPane(pane);
    } else {
        disableRegimeForPane(pane);
    }
}

function updateIndicatorsRealtime(pane, forceFullRecalc = false) {
    if (!pane.historyData || pane.historyData.length === 0) return;
    const inds = pane.indicators;
    const settings = inds.settings || {};

    const lastBarTime = pane.lastBar ? pane.lastBar.time : null;
    const currentTickSec = Math.floor(Date.now() / 1000);
    const shouldRecalculate =
        forceFullRecalc ||
        (lastBarTime !== null && pane.lastIndicatorUpdateTime !== lastBarTime) ||
        !pane.lastIndicatorRealtimeAt ||
        currentTickSec - pane.lastIndicatorRealtimeAt >= 2;

    if (shouldRecalculate) {
        if (inds.ema10) {
            const ema10 = calculateEMA(pane.historyData, settings.ema10Period || 10);
            if (ema10.length > 0) safeSeriesUpdate(pane, pane.ema10Series, ema10[ema10.length - 1], "ema10Series");
        }
        if (inds.ema20) {
            const ema20 = calculateEMA(pane.historyData, settings.ema20Period || 20);
            if (ema20.length > 0) safeSeriesUpdate(pane, pane.ema20Series, ema20[ema20.length - 1], "ema20Series");
        }
        if (inds.ema50) {
            const ema50 = calculateEMA(pane.historyData, settings.ema50Period || 50);
            if (ema50.length > 0) safeSeriesUpdate(pane, pane.ema50Series, ema50[ema50.length - 1], "ema50Series");
        }
        if (inds.ema100) {
            const ema100 = calculateEMA(pane.historyData, settings.ema100Period || 100);
            if (ema100.length > 0) safeSeriesUpdate(pane, pane.ema100Series, ema100[ema100.length - 1], "ema100Series");
        }
        if (inds.ema200) {
            const ema200 = calculateEMA(pane.historyData, settings.ema200Period || 200);
            if (ema200.length > 0) safeSeriesUpdate(pane, pane.ema200Series, ema200[ema200.length - 1], "ema200Series");
        }
        if (inds.bbands) {
            const bb = calculateBollingerBands(pane.historyData, settings.bbPeriod || 20, settings.bbStdDev || 2);
            if (bb.upper.length > 0) {
                safeSeriesUpdate(pane, pane.bbUpperSeries, bb.upper[bb.upper.length - 1], "bbUpperSeries");
                safeSeriesUpdate(pane, pane.bbMiddleSeries, bb.middle[bb.middle.length - 1], "bbMiddleSeries");
                safeSeriesUpdate(pane, pane.bbLowerSeries, bb.lower[bb.lower.length - 1], "bbLowerSeries");
            }
        }
    }
    
    if (shouldRecalculate) {
        // Subcharts are re-rendered from full data — just trigger redraw
        renderAllSubcharts(pane);
        pane.lastIndicatorRealtimeAt = currentTickSec;
        pane.lastIndicatorUpdateTime = lastBarTime;
    }

    updateMetricLabels(pane);

    requestVolumeProfileDraw(pane);
}

function updateIndicatorBtnState(pane) {
    const inds = pane.indicators;
    const isCustomActive = inds.ema10 || inds.ema20 || inds.ema50 || inds.ema100 || inds.ema200 ||
                          inds.bbands || inds.volumeProfile || inds.vwrsi || inds.vwmacd || inds.bvd ||
                          inds.atr || inds.divergence || inds.regime || inds.vwap || inds.vol || inds.deltaProfile;
    const btn = document.getElementById(`${pane.id}-ind-btn`);
    if (btn) {
        if (isCustomActive) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    }
}

// ─── REGIME DETECTOR ─────────────────────────────────────────────────────────

const SUPPORTED_REGIME_TFS = new Set(["15m", "30m", "1h", "4h", "1d"]);

function initRegimeForPane(pane) {
    if (!pane.indicators.regime) return;
    if (!SUPPORTED_REGIME_TFS.has(pane.timeframe)) {
        setRegimeDisplay(pane, "unavailable", "Unknown", 0, false, null, 0, []);
        return;
    }

    if (pane.regimeInitialized) return;
    pane.regimeInitialized = true;

    setRegimeDisplay(pane, "warming_up", "Unknown", 0, false, null, 0, []);

    const bars = (pane.historyData || []).map(b => ({
        time: b.time, open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume || 0
    }));

    fetch("/api/regime/init", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({paneId: pane.id, symbol: pane.symbol,
                             timeframe: pane.timeframe, bars: bars})
    }).then(r => {
        if (!r.ok) {
            // Server error (500, 400, etc.) — reset so next bar close can retry
            pane.regimeInitialized = false;
            setRegimeDisplay(pane, "warming_up", "Unknown", 0, false, null, 0, []);
            return null;
        }
        return r.json();
    }).then(data => {
        if (!data) return;
        if (data.state) {
            updateRegimeUI(pane, data.state);
        } else {
            // Init succeeded but returned no state — allow retry
            pane.regimeInitialized = false;
        }
    }).catch(() => {
        pane.regimeInitialized = false;
        setRegimeDisplay(pane, "warming_up", "Unknown", 0, false, null, 0, []);
    });
}

function disableRegimeForPane(pane) {
    pane.regimeInitialized = false;
    pane._regimeState = null;
    fetch("/api/regime/destroy", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({paneId: pane.id})
    }).catch(() => {});
    setRegimeDisplay(pane, "unavailable", "Unknown", 0, false, null, 0, []);
}

function syncRegimeDisplay(pane) {
    // Refresh regime UI from cached state — no network call, no tick dependency.
    // Used as a sync point after indicator toggles that don't change bars.
    if (!pane.indicators.regime || !pane.regimeInitialized) return;
    if (!SUPPORTED_REGIME_TFS.has(pane.timeframe)) {
        setRegimeDisplay(pane, "unavailable", "Unknown", 0, false, null, 0, []);
        return;
    }
    if (pane._regimeState) {
        updateRegimeUI(pane, pane._regimeState);
    }
}

function updateRegimeUI(pane, state) {
    if (!pane.indicators.regime) return;
    pane._regimeState = state;  // cache for syncRegimeDisplay
    setRegimeDisplay(pane, state.status || "warming_up", state.label || "Unknown",
        state.confidence || 0, state.is_pending || false, state.pending_label || null,
        state.bars_in_current || 0, state.prev_regimes || []);
}

function setRegimeDisplay(pane, status, label, confidence, isPending, pendingLabel, barsInCurrent, prevRegimes) {
    const labelEl  = document.getElementById(`${pane.id}-regime-label`);
    const confEl   = document.getElementById(`${pane.id}-regime-confidence`);
    const statEl   = document.getElementById(`${pane.id}-regime-status`);
    const ageEl    = document.getElementById(`${pane.id}-regime-age`);
    const moduleEl = document.getElementById(`${pane.id}-regime-module`);
    if (!labelEl || !moduleEl) return;

    moduleEl.className = "regime-module";
    if (!pane.indicators.regime || status === "unavailable") {
        moduleEl.classList.add("regime-hidden");
        moduleEl.setAttribute("data-regime", "");
        labelEl.textContent = "";
        if (confEl) confEl.textContent = "";
        if (statEl) statEl.textContent = "";
        if (ageEl) ageEl.textContent = "";
        return;
    }

    moduleEl.setAttribute("data-regime", status === "ready" ? label : "");
    if (status === "unavailable" || status === "warming_up") {
        moduleEl.classList.add("regime-unavailable");
    }

    labelEl.textContent = status === "unavailable" ? "--" : label;
    if (confEl)  confEl.textContent  = status === "ready" ? `${confidence}%` : "";
    if (statEl) {
        if (status === "unavailable")  statEl.textContent = "Unavailable";
        else if (status === "warming_up") statEl.textContent = "Warming up";
        else if (isPending && pendingLabel) statEl.textContent = `Pending → ${pendingLabel}`;
        else statEl.textContent = "Stable";
    }
    if (ageEl) ageEl.textContent = status === "ready" && barsInCurrent > 0 ? `${barsInCurrent} bars` : "";
}

function handleBarCloseForRegime(pane, closedBar) {
    if (!pane.indicators.regime || !pane.regimeInitialized) return;
    if (!SUPPORTED_REGIME_TFS.has(pane.timeframe)) return;

    fetch("/api/regime/bar_close", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({paneId: pane.id, bar: {
            time: closedBar.time, open: closedBar.open, high: closedBar.high,
            low: closedBar.low, close: closedBar.close, volume: closedBar.volume || 0
        }})
    }).then(r => {
        if (r.status === 404 || r.status === 409) {
            // Server restarted — engine lost. Re-init immediately.
            pane.regimeInitialized = false;
            initRegimeForPane(pane);
            return null;
        }
        return r.json();
    }).then(data => {
        if (data && data.state) updateRegimeUI(pane, data.state);
    }).catch(() => {});
}

function resetRegimeForPane(pane, symbol, timeframe, bars) {
    if (!pane.indicators.regime) return;
    pane.regimeInitialized = false;

    const tf = timeframe || pane.timeframe;
    if (!SUPPORTED_REGIME_TFS.has(tf)) {
        setRegimeDisplay(pane, "unavailable", "Unknown", 0, false, null, 0, []);
        return;
    }

    const barPayload = (bars || []).map(b => ({
        time: b.time, open: b.open, high: b.high, low: b.low,
        close: b.close, volume: b.volume || 0
    }));

    fetch("/api/regime/reset", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({paneId: pane.id, symbol: symbol || pane.symbol,
                             timeframe: tf, bars: barPayload})
    }).then(r => r.json()).then(data => {
        if (data.state) {
            pane.regimeInitialized = data.initialized;
            updateRegimeUI(pane, data.state);
        }
    }).catch(() => {
        setRegimeDisplay(pane, "unavailable", "Unknown", 0, false, null, 0, []);
    });
}
