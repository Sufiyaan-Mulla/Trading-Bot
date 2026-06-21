'use strict';
// ── trading-config.js ─────────────────────────────────────────────────────────
// Single source of truth for all TRADING_CONFIG settings.
// Import this instead of trading-engine.js when only config is needed.
const TRADING_CONFIG = {
  // Risk Management
  positionSize: 0.01,       // Fallback fixed size: 1% when Kelly has no data yet
  stopLoss: 0.02,
  takeProfit: 0.05,
  maxDailyLoss: 0.07,
  minConfidence: 60,

  // ── Nuclear Safety Protocols ─────────────────────────────────────────
  // 1. Consecutive Loss Halt: pause trading after N straight losses
  dailyLossLimit:    0.05,  // 5% daily loss triggers 24h lockout (SAFETY.MAX_DAILY_LOSS_PCT = 7% hard cap)
  consecutiveLossLimit: 3,         // halt after 3 losses in a row
  consecutiveLossCooldown: 900000, // 15-minute cooldown before resuming (ms)

  // 2. Global Account Drawdown Limit: kill switch if total account drops X%
  // (resets NEVER — unlike daily CB which resets each morning)
  globalDrawdownLimit: 0.20,       // halt permanently if account drops 20% from start

  // 3. Flash Crash / Volatility Spike Detector
  flashCrashThreshold: 0.008,      // 0.8% single-candle move triggers halt
  flashCrashCooldown:  300000,     // 5-minute pause after spike detected (ms)
  commission: 0.001,
  slippage: 0.0005,

  // ── Order Execution ─────────────────────────────────────────────────
  // 'market'  — fills immediately at current price + slippage (fast, may slip)
  // 'limit'   — fills only if realised slippage ≤ limitSlippageThreshold;
  //             otherwise the order is REJECTED. Protects margins in fast markets.
  orderType: 'limit',
  // Max acceptable slippage on a limit order. 0.001 = 0.1%.
  // Current CONFIG.slippage = 0.0005 (0.05%) so a threshold of 0.001 fills
  // normally and rejects only during extreme volatility spikes.
  limitSlippageThreshold: 0.001,

  // Kelly Criterion Position Sizing
  kellyEnabled: true,
  kellyFraction: 0.5,       // Half-Kelly — safer (1.0 = full Kelly, 0.25 = quarter-Kelly)
  kellyMinTrades: 10,       // Minimum trades before Kelly is trusted over fixed sizing
  kellyMaxSize: 0.02,       // Hard cap: never risk more than 2% per trade (professional standard)
  kellyMinSize: 0.005,      // Hard floor: never risk less than 0.5% per trade

  // Trailing Stop Loss
  trailingStopEnabled: true,
  trailingStopActivation: 0.01,      // activate at +1% profit
  trailingStopDistance: 0.005,        // trail 0.5% behind peak

  // ── Breakeven Stop ──────────────────────────────────────────────────
  // Once price moves breakevenTrigger% in profit, move stop to entry.
  // This makes the trade risk-free — if price reverses, we exit flat
  // (commission is covered by the buffer).
  breakevenEnabled: true,
  breakevenTrigger: 0.005,   // Activate at +0.5% profit
  breakevenBuffer:  0.0002,  // Stop sits 0.02% ABOVE entry to cover commission

  // ── Partial Profit Taking ──────────────────────────────────────────
  // At partialProfitTrigger × ATR in profit, close partialProfitFraction
  // of the position. The remainder runs to the main take profit —
  // locking in guaranteed profit while letting winners continue.
  partialProfitEnabled: true,
  partialProfitTrigger: 2.0,     // 2× ATR in profit
  partialProfitFraction: 0.5,    // Close 50% of position

  // Correlation Engine
  correlationEnabled: true,
  correlationPeriod: 50,           // Price bars used for each pairwise calc
  correlationHighThreshold: 0.80,  // Block new trade if corr with open position >= this
  correlationWarnThreshold: 0.60,  // Warn & reduce size if corr >= this
  correlationSizeReduction: 0.50,  // Scale Kelly size by this when correlation is high

  // Multi-Timeframe Analysis
  mtaEnabled: true,
  // Each timeframe collapses N raw ticks into one candle.
  // With tradingInterval = 30s, one raw tick ≈ 30 seconds.
  mtaTimeframes: {
    '1m':  { ticks: 2,    weight: 1 },   //   2 ticks → 1-minute candle
    '5m':  { ticks: 10,   weight: 2 },   //  10 ticks → 5-minute candle
    '15m': { ticks: 30,   weight: 2 },   //  30 ticks → 15-minute candle
    '30m': { ticks: 60,   weight: 3 },   //  60 ticks → 30-minute candle
    '1h':  { ticks: 120,  weight: 4 },   // 120 ticks → 1-hour candle
    '4h':  { ticks: 480,  weight: 4 },   // 480 ticks → 4-hour candle
    '1d':  { ticks: 2880, weight: 5 },   // 2880 ticks → 1-day candle
  },
  mtaMinAlignment: 0.55,  // Minimum weighted score (0-1) required to trade

  // Trading Loop
  tradingInterval: 30000,
  maxHistoryLength: 500,
  autoTrainFrequency: 10,

  // API Configuration
  proxyUrl: process.env.PROXY_URL || 'http://localhost:3000/api/claude',

  // Retry Configuration
  retryMaxAttempts: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 10000,
  retryMultiplier: 2,

  // ── Spread Awareness ────────────────────────────────────────────────
  // Block new entries when bid/ask spread exceeds this fraction of price.
  // Typical EURUSD: 0.0001 (1 pip). During news: 0.0010+ (10 pips).
  // maxSpreadFraction: block if spread > this × price  (e.g. 0.0005 = 5 pips on 1.1000)
  // spreadWarnFraction: log warning if spread > this × price
  spreadEnabled:        true,
  maxSpreadFraction:    0.0005,   // 5 pips — hard block above this
  spreadWarnFraction:   0.0003,   // 3 pips — warn above this
  spreadConfPenalty:    10,       // confidence pts deducted per pip above warn level

  // ── Partial Fill Simulation ─────────────────────────────────────────
  // In real brokers, large orders may fill in multiple tranches.
  // partialFillEnabled:   simulate partial fills (realistic execution)
  // partialFillMinRatio:  minimum fraction filled on first attempt (0.6 = 60%)
  // partialFillMaxRatio:  maximum fraction filled on first attempt (0.95 = 95%)
  // partialFillRetries:   how many additional fill attempts allowed
  // partialFillDelay:     ms between fill retry attempts
  partialFillEnabled:   true,
  partialFillMinRatio:  0.60,     // at least 60% fills immediately
  partialFillMaxRatio:  0.95,     // at most 95% fills immediately
  partialFillRetries:   3,        // up to 3 more fill attempts for remainder
  partialFillDelay:     500,      // 500ms between fill attempts

  // Market Data
  dataSource: 'simulation',
  refreshInterval: 5000,

  // ── Historical Warm-Up ───────────────────────────────────────────────
  // On startup the engine fetches this many synthetic historical candles
  // so all indicators are fully seeded before the first live tick.
  // Set warmupCandles to at least maxHistoryLength (500) to be safe.
  warmupCandles: 500,         // candles to pre-fill on boot
  warmupEnabled: true,        // set false to revert to blind startup

  // ── Active Position Persistence ──────────────────────────────────────
  // The open position is written to disk on every state change.
  // On restart the engine reloads it and continues monitoring the trade.
  positionFile: 'trade_logs/active_position.json',

  // ── Max Open Time ─────────────────────────────────────────────────────────
  // Force-close any position open longer than this (milliseconds).
  // Prevents capital being locked indefinitely when neither SL nor TP fires.
  // 48h = 2 trading days — reasonable for swing-style forex.
  maxOpenTimeMs: 48 * 60 * 60 * 1000,   // 48 hours

  // ── Max concurrent open positions ─────────────────────────────────────────
  // Hard cap on simultaneous open trades across all pairs.
  // Prevents over-leveraging when multiple signals fire at once.
  maxOpenPositions: 3,                   // block entry if 3 or more trades already open

  // ── Position correlation lock ──────────────────────────────────────────────
  // Block entry in the same direction when a correlated pair is already open.
  // e.g. EURUSD long + GBPUSD long = doubled USD short exposure.
  correlationLockEnabled: true,
  correlationLockThreshold: 0.70,        // correlation above this triggers lock
  correlationLockPairs: {                // currency clusters — same base/quote = high correlation
    USD: ['EURUSD','GBPUSD','AUDUSD','NZDUSD','USDCAD','USDCHF','USDJPY'],
    EUR: ['EURUSD','EURGBP','EURJPY','EURCHF','EURAUD','EURCAD','EURNZD'],
    GBP: ['GBPUSD','EURGBP','GBPJPY','GBPCHF','GBPAUD','GBPCAD','GBPNZD'],
  },

  // ── Slippage budget per trade ─────────────────────────────────────────────
  // Maximum tolerated slippage (in pips) before rejecting a fill.
  // Orders filled outside this range are flagged and logged.
  maxSlippagePips: 3.0,                  // reject fills > 3 pips from intended price
  slippageBudgetEnabled: true,

  // ── Anti-martingale enforcement ───────────────────────────────────────────
  // Hard block on position sizing that increases after a losing streak.
  // Prevents catastrophic compounding of losses.
  antiMartingaleEnabled: true,
  antiMartingaleMaxMultiplier: 1.0,      // never allow sizing > baseline after losses

  // ── Model confidence decay ────────────────────────────────────────────────
  // ML confidence score decays linearly when the model hasn't been retrained.
  // Prevents stale models from being overconfident in changed market conditions.
  modelDecayEnabled: true,
  modelDecayHalfLifeHours: 24,           // score halves every 24h without retraining
  modelDecayMinScore: 0.40,              // floor — never decay below 40% confidence

  // ── Overfitting guard ─────────────────────────────────────────────────────
  // Train/validation split monitoring. Warns when train accuracy >> val accuracy.
  overfitGuardEnabled: true,
  overfitMaxGap: 0.15,                   // if trainAcc - valAcc > 15%, flag overfitting

  // ── Session overlap confidence boost ──────────────────────────────────────
  // London/NY overlap (13:00–16:00 UTC) is the highest-liquidity window.
  // Boost ML confidence and allow slightly larger sizing in this window.
  sessionOverlapBoostEnabled: true,
  sessionOverlapConfBoost: 0.05,         // +5% confidence boost in overlap window
  sessionOverlapSizeBoost: 1.10,         // 10% larger position size in overlap

  // ── ADX trend gate for mean-reversion entries ─────────────────────────────
  // Block mean-reversion signals when trend is strong (ADX > threshold).
  // Strong trends invalidate the statistical mean-reversion edge.
  adxMeanRevGateEnabled: true,
  adxMeanRevGateThreshold: 30,           // block mean-rev entries when ADX > 30

  // ── Requote detection ─────────────────────────────────────────────────────
  requoteRetryEnabled: true,
  requoteMaxRetries: 3,
  requoteRetryDelayMs: 500,

  // ── API rate-limit exponential backoff ────────────────────────────────────
  rateLimitBackoffEnabled: true,
  rateLimitBaseDelayMs: 1000,
  rateLimitMaxDelayMs: 60000,
  rateLimitMaxRetries: 5,

  // ── Equity curve anomaly detection ────────────────────────────────────────
  // Alert when live equity curve diverges from backtest expectations.
  equityAnomalyEnabled: true,
  equityAnomalyZScoreThresh: 2.5,        // alert if equity z-score > 2.5 vs rolling mean

  // ── API latency monitoring ─────────────────────────────────────────────────
  latencyMonitorEnabled: true,
  latencyAlertMs: 3000,                  // alert if any API call takes > 3 seconds
  latencyWindowSize: 20,                 // rolling window for p95 latency calc

  // ── Feature importance logging ────────────────────────────────────────────
  featureImportanceEnabled: true,
  featureImportanceLogEvery: 50,         // log top features every 50 ML calls

  // ── Position alerts ──────────────────────────────────────────────────────────
  unrealizedPnlAlertPct:   0.50,         // alert when floating loss = 50% of SL distance
  positionAgeWarnFraction: 0.75,         // warn when position is 75% through maxOpenTimeMs
  swapCostAlertFraction:   0.20,         // alert when swap costs = 20% of expected TP profit

  // ── Time-of-day heatmap ───────────────────────────────────────────────────
  todHeatmapBlockEnabled:   false,        // set true to block entries in statistically bad hours
  todHeatmapBlockThreshold: 0.35,         // block hours with win rate < 35%

  // ── Ensemble disagreement halt ────────────────────────────────────────────
  ensembleDisagreementHaltEnabled: true,
  ensembleAgreementThreshold:      0.60,  // need 60% of ensemble members to agree

  // ── Weekly trade report ───────────────────────────────────────────────────
  weeklyReportEnabled: true,
  weeklyReportDay: 5,                    // 5 = Friday (0=Sun)
  weeklyReportHourUTC: 21,              // after NY close

  // ── Volume confirmation ───────────────────────────────────────────────────
  // Minimum volume multiplier vs 20-bar average required to enter a position.
  // 1.2 = current volume must be at least 20% above average. Set to 1.0 to disable.
  volumeMinMultiplier: 1.2,

  // ── SL re-entry cooldown ──────────────────────────────────────────────────
  // Minutes to block re-entry on the same asset after a stop-loss exit.
  // Prevents immediately re-entering the same losing setup.
  slCooldownMinutes: 20,

  // Maximum age of a computed indicator snapshot before it's considered stale.
  maxIndicatorAgeMs: 60_000,   // 60 seconds

  // ── Circuit breaker auto-expiry ───────────────────────────────────────────
  // 0 = never auto-expire (manual reset required). Set to e.g. 4h for auto-recovery.
  circuitBreakerExpireMs: 0,

  // ── P/L velocity exit ─────────────────────────────────────────────────────
  // Exit a position early if P/L is deteriorating faster than this rate.
  // pnlVelocityThreshold: pnl-change-per-bar below which to exit (negative = loss).
  // pnlVelocityWindow: number of bars to measure velocity over.
  // ── TWAP execution ─────────────────────────────────────────────────────────
  twapEnabled:    true,
  twapThreshold:  2000,    // activate TWAP for orders > $2000 (else single market order)
  twapSlices:     3,       // split into 3 tranches
  twapIntervalMs: 10000,   // 10 seconds between tranches

  // ── ATR stop multiplier (used by getDynamicLevels and shadow strategy) ───────
  slAtrMult: 1.5,    // stop = ATR × slAtrMult

  // ── Minimum trade value ───────────────────────────────────────────────────
  minTradeValue: 10,   // minimum $10 per trade — prevents ghost positions
  // NOTE: twapEnabled/twapThreshold/twapSlices/twapIntervalMs defined above (lines 170-173)

  // ── Smart order routing ───────────────────────────────────────────────────
  maxSpreadPct:      0.001,     // max spread as fraction of price before blocking entry

  // ── Cross-source price divergence ─────────────────────────────────────────
  priceDivergenceThreshold: 0.05,  // % divergence between sources to flag

  pnlVelocityWindow:    5,       // measure over last 5 bars
  pnlVelocityThreshold: -0.003,  // -0.3% per bar = exit early

  // ── Per-asset drawdown limits ─────────────────────────────────────────────
  // If a single asset loses more than this fraction from its peak, halt it.
  maxAssetDrawdown: 0.05,    // 5% per-asset max drawdown
  assetHaltMinutes: 120,     // 2 hours halt before allowing re-entry

  // ── Overnight swap costs (rollover) ──────────────────────────────────────
  // Forex positions held past 17:00 ET (22:00 UTC) incur a daily swap fee.
  // Values in pips per lot per night. Positive = you receive, negative = you pay.
  // Wednesday rollover = 3× (accounts for weekend). Defaults are conservative estimates.
  swapRolloverHourUTC: 22,   // time of daily rollover (17:00 ET)
  swapCosts: {               // annual rate approximation in fraction of position value per night
    EURUSD: { long: -0.000010, short:  0.000003 },   // pay to hold EUR long (USD rate > EUR rate)
    GBPUSD: { long: -0.000008, short:  0.000002 },
    USDJPY: { long:  0.000005, short: -0.000015 },   // receive to hold USD long (JPY rates near zero)
    AUDUSD: { long: -0.000006, short:  0.000001 },
  },

  // ── Multi-Asset Trading ───────────────────────────────────────────────
  // All assets the engine may trade. Each tick (when no position is open)
  // the engine scores every asset via leading indicators + MTA alignment
  // and selects the highest-scoring one. While a position is open the
  // engine stays locked to that asset until the trade closes.
  assets: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'],
};

// ===== KELLY CRITERION POSITION SIZER =====
/**
 * Kelly Criterion: f* = (bp - q) / b
 *
 *   p  = historical win rate (0-1)
 *   q  = 1 - p  (loss rate)
 *   b  = average win / average loss  (the payoff ratio)
 *
 * The result is the theoretically optimal fraction of capital to risk
 * per trade to maximise long-run geometric growth.
 *
 * In practice we apply two safety measures:
 *   1. Half-Kelly (kellyFraction = 0.5) cuts the raw result in half,
 *      dramatically reducing variance while keeping most of the growth.
 *   2. Confidence scaling blends the Kelly size with a conservative floor
 *      based on how certain the AI is about this particular signal.
 */
module.exports = { TRADING_CONFIG };
