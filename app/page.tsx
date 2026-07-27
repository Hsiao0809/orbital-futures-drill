"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import TrainingChart from "./TrainingChart";

type Side = "LONG" | "SHORT" | "WAIT" | null;
type Candle = { time: number; open: number; high: number; low: number; close: number };
type Result = { pnl: number; discipline: number; correct: number; decisions: number; xp: number; status: "PASSED" | "FAILED" | "COMPLETE"; reason: string };
type Position = { id: string; side: "LONG" | "SHORT"; entry: number; mark: number; margin: number; leverage: number; stop: number; disciplineNote?: string };
type TradePlan = { side: "LONG" | "SHORT"; stopPct: number; leverage: number; margin: number };
type Insight = { label: string; pattern: string; explanation: string; nextFocus: string };
type TurnFeedback = { decision: Exclude<Side, null>; correct: boolean; candleReturn: number; pnlDelta: number; exposure: string; disciplineNote?: string; insight: Insight; xpEarned: number; streak: number; finalResult?: Result };

const CONTEXT_BARS = 32;
const PLAN_BARS = 24;
const QUICK_BARS = 10;
const STARTING_BALANCE = 1_000;
const MARGIN_PER_POSITION = 50;
const PROFIT_TARGET = 80;
const SESSION_LOSS_LIMIT = 50;
const TAKER_FEE_RATE = 0.0004;
const SLIPPAGE_RATE = 0.0002;

const seedContracts = [
  ["BTCUSDT", "Bitcoin"], ["ETHUSDT", "Ethereum"], ["SOLUSDT", "Solana"], ["XRPUSDT", "XRP"], ["DOGEUSDT", "Dogecoin"],
  ["BNBUSDT", "BNB"], ["ADAUSDT", "Cardano"], ["AVAXUSDT", "Avalanche"], ["LINKUSDT", "Chainlink"], ["DOTUSDT", "Polkadot"],
  ["SUIUSDT", "Sui"], ["HYPEUSDT", "Hyperliquid"], ["ENAUSDT", "Ethena"], ["WIFUSDT", "dogwifhat"], ["1000PEPEUSDT", "Pepe"],
  ["FARTCOINUSDT", "Fartcoin"], ["PENGUUSDT", "Pudgy Penguins"], ["1000BONKUSDT", "Bonk"], ["WLDUSDT", "Worldcoin"], ["ARBUSDT", "Arbitrum"],
  ["OPUSDT", "Optimism"], ["APTUSDT", "Aptos"], ["INJUSDT", "Injective"], ["TIAUSDT", "Celestia"], ["NEARUSDT", "NEAR Protocol"],
  ["SEIUSDT", "Sei"], ["TRXUSDT", "TRON"], ["ATOMUSDT", "Cosmos"], ["FILUSDT", "Filecoin"], ["AAVEUSDT", "Aave"], ["1000SHIBUSDT", "Shiba Inu"],
].map(([symbol, name]) => ({ symbol, name }));

function formatPrice(value?: number) {
  if (value === undefined || Number.isNaN(value)) return "--";
  if (value < 0.01) return value.toFixed(6);
  if (value < 1) return value.toFixed(4);
  if (value < 100) return value.toFixed(2);
  if (value < 1000) return value.toFixed(1);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function roundDate(time?: number) {
  return time ? `${new Intl.DateTimeFormat("zh-TW", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(time)} UTC` : "";
}

function readCandle(candle: Candle): Insight {
  const range = Math.max(candle.high - candle.low, Number.EPSILON);
  const body = Math.abs(candle.close - candle.open) / range;
  const upperWick = (candle.high - Math.max(candle.open, candle.close)) / range;
  const lowerWick = (Math.min(candle.open, candle.close) - candle.low) / range;
  const up = candle.close >= candle.open;
  if (body < 0.28) return { label: "結構辨識", pattern: "猶豫／壓縮 K 線", explanation: "實體很小，買賣雙方尚未取得主導；單根方向的可信度低。", nextFocus: "下一根是否以實體突破這段區間，再決定跟隨。" };
  if (upperWick > 0.45 && !up) return { label: "結構辨識", pattern: "上方流動性掃回", explanation: "價格曾往上試探，卻被賣方收回；追多的風險較高。", nextFocus: "觀察低點是否失守，才確認轉弱是否延續。" };
  if (lowerWick > 0.45 && up) return { label: "結構辨識", pattern: "下方承接掃回", explanation: "價格下探後被買方收回，顯示低檔有承接。", nextFocus: "觀察後續是否突破本根高點，避免只憑一根反轉。" };
  if (body > 0.7) return { label: "結構辨識", pattern: up ? "多方動能擴張" : "空方動能擴張", explanation: "實體佔本根區間的比例高，這一段由單方主導。", nextFocus: "不要追在末端；用下一根是否守住實體中線判斷延續。" };
  return { label: "結構辨識", pattern: up ? "多方推進，但有拉回" : "空方推進，但有拉回", explanation: "方向存在，但影線代表途中有反向壓力，並非無風險延續。", nextFocus: "將本根高低點當成下一步的確認區，而不是立即追價。" };
}

export default function Home() {
  const [availableContracts, setAvailableContracts] = useState(seedContracts);
  const [contract, setContract] = useState(seedContracts[0]);
  const [query, setQuery] = useState("");
  const [timeframe, setTimeframe] = useState("15m");
  const [leverage, setLeverage] = useState(5);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [visible, setVisible] = useState(CONTEXT_BARS);
  const [side, setSide] = useState<Side>(null);
  const [discipline, setDiscipline] = useState(100);
  const [pnl, setPnl] = useState(0);
  const [stats, setStats] = useState({ decisions: 0, correct: 0 });
  const [status, setStatus] = useState("正在載入 Binance 真實歷史 K 線…");
  const [error, setError] = useState("");
  const [roundKey, setRoundKey] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [log, setLog] = useState<string[]>(["選擇 LONG、SHORT 或 WAIT，開始本局。"]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [lastChange, setLastChange] = useState<{ side: string; entry: number; exit: number; pnl: number } | null>(null);
  const [tradePlan, setTradePlan] = useState<TradePlan | null>(null);
  const [feedback, setFeedback] = useState<TurnFeedback | null>(null);
  const [lastInsight, setLastInsight] = useState<Insight | null>(null);
  const [roundMode, setRoundMode] = useState<"PLAN" | "QUICK">("PLAN");
  const [timeLeft, setTimeLeft] = useState(12);
  const [tradesTaken, setTradesTaken] = useState(0);
  const [roundXp, setRoundXp] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [careerXp, setCareerXp] = useState<number | null>(null);

  const roundBars = roundMode === "QUICK" ? QUICK_BARS : PLAN_BARS;
  const choices = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized ? availableContracts.filter((item) => `${item.symbol} ${item.name}`.toLowerCase().includes(normalized)) : availableContracts;
    return matches.some((item) => item.symbol === contract.symbol) ? matches : [contract, ...matches];
  }, [query, contract, availableContracts]);

  useEffect(() => {
    fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ symbols?: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }> }>;
      })
      .then((payload) => {
        const contracts = (payload.symbols || [])
          .filter((item) => item.contractType === "PERPETUAL" && item.quoteAsset === "USDT" && item.status === "TRADING")
          .map((item) => ({ symbol: item.symbol, name: item.baseAsset }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol));
        if (!contracts.length) return;
        setAvailableContracts(contracts);
        setContract((selected) => contracts.find((item) => item.symbol === selected.symbol) || contracts[0]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem("orbital-futures-drill-career-xp"));
    setCareerXp(Number.isFinite(saved) && saved > 0 ? saved : 0);
  }, []);

  useEffect(() => {
    if (careerXp !== null) window.localStorage.setItem("orbital-futures-drill-career-xp", String(careerXp));
  }, [careerXp]);

  const loadRound = useCallback(async () => {
    setStatus("正在載入 Binance 真實歷史 K 線…");
    setError("");
    setResult(null);
    setSide(null);
    setDiscipline(100);
    setPnl(0);
    setStats({ decisions: 0, correct: 0 });
    setPositions([]);
    setLastChange(null);
    setTradePlan(null);
    setFeedback(null);
    setLastInsight(null);
    setTradesTaken(0);
    setTimeLeft(12);
    setRoundXp(0);
    setStreak(0);
    setBestStreak(0);
    try {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${contract.symbol}&interval=${timeframe}&limit=260`, { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const upstreamMessage = typeof payload === "object" && payload && "msg" in payload ? String(payload.msg) : "";
        throw new Error(`Binance K 線資料請求失敗（HTTP ${response.status}${upstreamMessage ? `：${upstreamMessage}` : ""}）`);
      }
      if (!Array.isArray(payload)) throw new Error("Binance K 線 API 回傳格式異常。");
      const history = payload.slice(0, -1).map((row): Candle => {
        const item = row as [number, string, string, string, string];
        return { time: Number(item[0]), open: Number(item[1]), high: Number(item[2]), low: Number(item[3]), close: Number(item[4]) };
      });
      const last = history.length - roundBars;
      if (last <= CONTEXT_BARS) throw new Error("可用歷史資料不足，請換一個週期或稍後重試。");
      const anchor = CONTEXT_BARS + Math.floor(Math.random() * (last - CONTEXT_BARS));
      const round = history.slice(anchor - CONTEXT_BARS, anchor + roundBars);
      setCandles(round);
      setVisible(CONTEXT_BARS);
      setStatus(`真實歷史資料 · 回合起點 ${roundDate(round[CONTEXT_BARS - 1]?.time)}`);
      setLog([`${contract.symbol} ${timeframe} 真實歷史 K 線已鎖定；後方 ${roundBars} 根 K 線尚未揭露。`]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "歷史資料載入失敗。";
      setCandles([]);
      setError(message);
      setStatus("資料暫時不可用");
      setLog([`錯誤：${message}`]);
    }
  }, [contract.symbol, timeframe, roundBars, roundKey]);

  useEffect(() => { void loadRound(); }, [loadRound]);

  const current = candles[visible - 1];
  const movement = current ? ((current.close / current.open - 1) * 100).toFixed(2) : "0.00";
  const canReveal = Boolean(candles.length) && visible < candles.length && !result && !feedback && !tradePlan;
  const turnsComplete = Math.min(roundBars, Math.max(0, visible - CONTEXT_BARS));
  const equity = STARTING_BALANCE + pnl;
  const accountStatus = pnl >= PROFIT_TARGET ? "PASSED" : pnl <= -SESSION_LOSS_LIMIT ? "FAILED" : "ACTIVE";
  const learnerLevel = Math.floor((careerXp || 0) / 500) + 1;

  const choose = (choice: Exclude<Side, null>) => {
    if (accountStatus !== "ACTIVE") return;
    if (choice === "LONG" || choice === "SHORT") {
      if (positions.some((item) => item.side === choice)) {
        setSide(choice);
        setLog((items) => [`續抱 ${choice}；可同時保留另一方向的避險部位。`, ...items].slice(0, 4));
        return;
      }
      setTradePlan({ side: choice, stopPct: 0.8, leverage, margin: MARGIN_PER_POSITION });
      setSide(null);
      setLog((items) => [`設定 ${choice} 進場計畫：可與既有 ${positions.length ? "反向" : ""}部位同時持有。`, ...items].slice(0, 4));
      return;
    }
    setSide(choice);
    if (choice === "WAIT") {
      setLastChange(null);
      setLog((items) => [positions.length ? "選擇 WAIT：不新增部位，既有部位會隨下一根 K 線標記。" : "選擇 WAIT：本根僅觀察，帳戶權益不會因這個選擇而變動。", ...items].slice(0, 4));
    }
  };

  const confirmTradePlan = () => {
    if (!tradePlan || !current) return;
    const entry = current.close * (tradePlan.side === "LONG" ? 1 + SLIPPAGE_RATE : 1 - SLIPPAGE_RATE);
    const stop = entry * (tradePlan.side === "LONG" ? 1 - tradePlan.stopPct / 100 : 1 + tradePlan.stopPct / 100);
    const estimatedRisk = tradePlan.margin * tradePlan.leverage * (tradePlan.stopPct / 100);
    const currentMove = Math.abs((current.close / current.open - 1) * 100);
    const infractions = [
      tradePlan.leverage > 10 ? { text: "槓桿超過 10×（−8）", points: 8 } : null,
      estimatedRisk > equity * 0.01 ? { text: "預估風險超過帳戶 1%（−6）", points: 6 } : null,
      currentMove > 0.8 ? { text: "追價於已擴張的 K 線（−4）", points: 4 } : null,
      tradesTaken >= 4 ? { text: "本局交易過於頻繁（−4）", points: 4 } : null,
    ].filter((item): item is { text: string; points: number } => Boolean(item));
    const penalty = infractions.reduce((total, item) => total + item.points, 0);
    const entryFee = tradePlan.margin * tradePlan.leverage * TAKER_FEE_RATE;
    const note = infractions.map((item) => item.text).join(" · ");
    setDiscipline((value) => Math.max(0, value - penalty));
    setPnl((value) => value - entryFee);
    setPositions((items) => [...items, { id: `${tradePlan.side}-${current.time}`, side: tradePlan.side, entry, mark: entry, margin: tradePlan.margin, leverage: tradePlan.leverage, stop, disciplineNote: note || undefined }]);
    setTradesTaken((value) => value + 1);
    setTradePlan(null);
    setSide(tradePlan.side);
    setLastChange(null);
    setLog((items) => [`建立 ${tradePlan.side}：進場 $${formatPrice(entry)} · 停損 $${formatPrice(stop)} · ${tradePlan.leverage}× · 手續費 −${entryFee.toFixed(2)} U`, ...items].slice(0, 4));
  };

  const closePosition = (position: Position) => {
    if (!current) return;
    const exit = current.close * (position.side === "LONG" ? 1 - SLIPPAGE_RATE : 1 + SLIPPAGE_RATE);
    const exitFee = position.margin * position.leverage * TAKER_FEE_RATE;
    const change = ((exit / position.mark) - 1) * (position.side === "LONG" ? 1 : -1) * position.margin * position.leverage - exitFee;
    setPnl((value) => value + change);
    setLastChange({ side: position.side, entry: position.mark, exit, pnl: change });
    setPositions((items) => items.filter((item) => item.id !== position.id));
    setLog((items) => [`平倉 ${position.side}：$${formatPrice(position.mark)} → $${formatPrice(exit)} · 本次 ${change >= 0 ? "+" : ""}${change.toFixed(2)} U`, ...items].slice(0, 4));
  };

  const reveal = (forcedChoice?: Exclude<Side, null>, timedOut = false) => {
    const decision = forcedChoice || side;
    if (!canReveal || !decision) {
      setLog((items) => ["請先選擇 LONG、SHORT 或 WAIT，再揭露下一根 K 線。", ...items].slice(0, 4));
      return;
    }
    const next = candles[visible];
    if (!next) return;
    const candleReturn = ((next.close / next.open) - 1) * 100;
    const isUp = candleReturn >= 0;
    const recentRanges = candles.slice(Math.max(0, visible - 14), visible).map((candle) => (candle.high - candle.low) / candle.open);
    const typicalRange = recentRanges.reduce((total, value) => total + value, 0) / Math.max(1, recentRanges.length);
    const isCorrect = decision === "WAIT" ? Math.abs(candleReturn) / 100 < typicalRange * 0.45 : (decision === "LONG" ? isUp : !isUp);
    const insight = readCandle(next);
    const xpEarned = isCorrect ? decision === "WAIT" ? 70 : 100 : 0;
    const nextStreak = isCorrect ? streak + 1 : 0;
    let pnlDelta = 0;
    const positionNotes: string[] = [];
    const closedChanges: Array<{ side: string; entry: number; exit: number; pnl: number }> = [];
    const nextPositions = positions.flatMap((position) => {
      const stopped = position.side === "LONG" ? next.low <= position.stop : next.high >= position.stop;
      const exit = stopped ? position.stop * (position.side === "LONG" ? 1 - SLIPPAGE_RATE : 1 + SLIPPAGE_RATE) : next.close;
      const exitFee = stopped ? position.margin * position.leverage * TAKER_FEE_RATE : 0;
      const change = ((exit / position.mark) - 1) * (position.side === "LONG" ? 1 : -1) * position.margin * position.leverage - exitFee;
      pnlDelta += change;
      if (stopped) {
        positionNotes.push(`${position.side} 停損觸發。`);
        closedChanges.push({ side: position.side, entry: position.mark, exit, pnl: change });
        return [];
      }
      positionNotes.push(`${position.side} 續留並重新標記。`);
      return [{ ...position, mark: next.close }];
    });
    const exposure = positions.length ? positionNotes.join(" ") : "空手觀察；帳戶 P&L 維持不變。";
    const nextPnl = pnl + pnlDelta;
    const nextStats = { decisions: stats.decisions + 1, correct: stats.correct + (isCorrect ? 1 : 0) };
    const hitTarget = nextPnl >= PROFIT_TARGET;
    const hitLossLimit = nextPnl <= -SESSION_LOSS_LIMIT;
    const finalBar = visible + 1 === candles.length;
    const finalResult: Result | undefined = finalBar || hitTarget || hitLossLimit ? {
      pnl: nextPnl,
      discipline,
      correct: nextStats.correct,
      decisions: nextStats.decisions,
      xp: roundXp + xpEarned,
      status: (hitTarget ? "PASSED" : hitLossLimit ? "FAILED" : "COMPLETE"),
      reason: hitTarget ? "已達本局 +8% 獲利目標。" : hitLossLimit ? "已達本局 −5% 最大虧損限制。" : "所有鎖定 K 線均已揭露；若有未平倉，P&L 為最後一根的標記價估值。",
    } : undefined;
    setPnl(nextPnl);
    setStats(nextStats);
    setRoundXp((value) => value + xpEarned);
    setCareerXp((value) => (value || 0) + xpEarned);
    setStreak(nextStreak);
    setBestStreak((value) => Math.max(value, nextStreak));
    setLastInsight(insight);
    setVisible((value) => value + 1);
    setSide(null);
    setPositions(nextPositions);
    if (closedChanges[0]) setLastChange(closedChanges[0]);
    setFeedback({ decision, correct: isCorrect, candleReturn, pnlDelta, exposure: timedOut ? `時間到，自動以 ${decision} 揭露。${exposure}` : exposure, disciplineNote: positions.map((item) => item.disciplineNote).filter(Boolean).join(" · ") || undefined, insight, xpEarned, streak: nextStreak, finalResult });
    setLog((items) => [`${decision} · 下一根 ${isUp ? "上漲" : "下跌"} ${candleReturn.toFixed(2)}% · ${exposure}`, ...items].slice(0, 4));
  };

  const continueAfterFeedback = () => {
    if (!feedback) return;
    const finalResult = feedback.finalResult;
    setFeedback(null);
    setTimeLeft(12);
    if (finalResult) setResult(finalResult);
  };

  useEffect(() => {
    if (roundMode !== "QUICK" || !canReveal || feedback || tradePlan || result) return;
    setTimeLeft(12);
    const timer = window.setInterval(() => setTimeLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [roundMode, visible, canReveal, feedback, tradePlan, result]);

  useEffect(() => {
    if (roundMode === "QUICK" && timeLeft === 0 && canReveal && !feedback && !tradePlan) reveal(side || "WAIT", true);
  }, [roundMode, timeLeft, canReveal, feedback, tradePlan, side]);

  const planEntry = current ? current.close * (tradePlan?.side === "LONG" ? 1 + SLIPPAGE_RATE : 1 - SLIPPAGE_RATE) : 0;
  const planRisk = tradePlan ? tradePlan.margin * tradePlan.leverage * (tradePlan.stopPct / 100) : 0;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand"><span className="brand-mark">↗</span><span>ORBITAL</span><em>FUTURES DRILL</em><span className="brand-training">USDT 永續合約盤感訓練</span></div>
        <select className="round-mode" aria-label="回合模式" value={roundMode} onChange={(event) => setRoundMode(event.target.value as "PLAN" | "QUICK")}>
          <option value="PLAN">TRADE PLAN · 24 根</option>
          <option value="QUICK">QUICK DRILL · 10 根 / 12 秒</option>
        </select>
        <div className="mode-pill"><span className="mode-dot" />{roundMode === "QUICK" ? `QUICK · ${timeLeft}s` : "TRADE PLAN · 真實歷史資料"}<b> · L{learnerLevel} · {careerXp || 0} XP</b></div>
        <button className="ghost-button" onClick={() => setRoundKey((value) => value + 1)}>換一局</button>
      </section>

      <section className="training-grid">
        <aside className="control-panel">
          <div className="panel-heading"><span>01</span><div><h2>選擇合約</h2><p>Binance USDT 永續合約</p></div></div>
          <label>搜尋代號或名稱<input className="symbol-input" value={query} placeholder="例如 WIF 或 Solana" onChange={(event) => setQuery(event.target.value)} /></label>
          <label>從結果選擇<select value={contract.symbol} onChange={(event) => setContract(availableContracts.find((item) => item.symbol === event.target.value) || seedContracts[0])}>{choices.map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol} · {item.name}</option>)}</select></label>
          <label>K 線週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}><option>5m</option><option>15m</option><option>1h</option><option>4h</option></select></label>
          <div className="divider" />
          <div className="panel-heading compact"><span>02</span><div><h2>練習風控</h2><p>只影響模擬 P&amp;L，不會下單</p></div></div>
          <label>槓桿 <strong className="field-value">{leverage}×</strong><input aria-label="槓桿" type="range" min="1" max="20" value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} /></label>
          <div className="risk-box"><div><span>挑戰目標</span><b>+8%</b></div><div><span>本局上限</span><b>−5%</b></div></div>
          <p className="micro-note">起始 1,000 U。進場計畫會納入滑價與 0.04% taker 手續費；紀律從 100 分開始，只在過度風險或追價時扣分。</p>
        </aside>

        <section className="chart-panel">
          <header className="chart-head"><div><p className="eyebrow">{contract.symbol} PERPETUAL · {timeframe}</p><h2>${formatPrice(current?.close)} <small className={Number(movement) >= 0 ? "up" : "down"}>{current ? `${Number(movement) >= 0 ? "+" : ""}${movement}%` : ""}</small></h2></div><div className="locked"><span>⊙</span> FUTURE LOCKED</div></header>
          <div className="chart-area real-chart-area" aria-label="真實歷史 K 線圖表">
            <TrainingChart candles={candles} visible={visible} loading={!candles.length && !error} />
            <div className="fog real-fog"><span>未揭露行情</span><strong>{Math.max(0, candles.length - visible)} 根 K 線</strong></div>
            {error && <div className="chart-error">{error}<button onClick={() => setRoundKey((value) => value + 1)}>重試</button></div>}
            {feedback && <div className="result-overlay"><div className="result-card feedback-card"><p className="eyebrow">{feedback.finalResult ? "FINAL DECISION" : "DECISION RESULT"} · {feedback.xpEarned > 0 ? `+${feedback.xpEarned} XP` : "REVIEW"}</p><h2>你選擇 {feedback.decision}</h2><p className={feedback.correct ? "up" : "down"}>{feedback.correct ? `讀對了。連勝 ${feedback.streak} 根。` : "這根沒讀對，但它正是下一次的教材。"}</p><div className="result-metrics"><div><span>下一根變化</span><b className={feedback.candleReturn >= 0 ? "up" : "down"}>{feedback.candleReturn >= 0 ? "+" : ""}{feedback.candleReturn.toFixed(2)}%</b></div><div><span>帳戶變化</span><b className={feedback.pnlDelta >= 0 ? "up" : "down"}>{feedback.pnlDelta >= 0 ? "+" : ""}{feedback.pnlDelta.toFixed(2)} U</b></div><div><span>紀律分數</span><b>{discipline}</b></div></div><div className="coach-callout"><span>{feedback.insight.label} · {feedback.insight.pattern}</span><p>{feedback.insight.explanation}</p><small>下一次：{feedback.insight.nextFocus}</small></div><p>{feedback.exposure}{feedback.disciplineNote ? ` 紀律提醒：${feedback.disciplineNote}` : ""}</p><button className="reveal-button" onClick={continueAfterFeedback}>{feedback.finalResult ? "查看本局結算" : "繼續下一根 K 線"}<span>→</span></button></div></div>}
          </div>
          <footer className="chart-footer"><span>{status}</span><div className="progress"><i style={{ width: `${(turnsComplete / roundBars) * 100}%` }} /></div><span>Chart by TradingView™</span></footer>
          {result && <div className="result-overlay"><div className="result-card"><p className="eyebrow">PROP CHALLENGE · {result.status} · {result.xp} XP</p><h2>{result.status === "PASSED" ? "挑戰通過" : result.status === "FAILED" ? "挑戰停止" : "本局完成"}</h2><div className="result-metrics"><div><span>帳戶 P&amp;L</span><b className={result.pnl >= 0 ? "up" : "down"}>{result.pnl >= 0 ? "+" : ""}{result.pnl.toFixed(2)} U</b></div><div><span>判讀正確</span><b>{result.correct} / {result.decisions}</b></div><div><span>紀律分數</span><b>{result.discipline}</b></div></div><p>{result.reason} {result.discipline >= 80 ? "決策紀律穩定。" : "下局請優先檢查逆勢、追價與過度交易。"}</p><button className="reveal-button" onClick={() => setRoundKey((value) => value + 1)}>開始下一局 <span>→</span></button></div></div>}
        </section>

        <aside className="decision-panel">
          <div className="panel-heading"><span>03</span><div><h2>你的判斷</h2><p>{roundMode === "QUICK" ? `剩餘 ${timeLeft} 秒；逾時自動揭露` : "每根 K 線只能選一次"}</p></div></div>
          <div className="decision-buttons"><button className={side === "LONG" || tradePlan?.side === "LONG" ? "chosen long" : "long"} onClick={() => choose("LONG")}><small>看多</small><strong>LONG</strong><span>突破／延續</span></button><button className={side === "SHORT" || tradePlan?.side === "SHORT" ? "chosen short" : "short"} onClick={() => choose("SHORT")}><small>看空</small><strong>SHORT</strong><span>跌破／轉弱</span></button><button className={side === "WAIT" ? "chosen wait" : "wait"} onClick={() => choose("WAIT")}><small>觀望</small><strong>WAIT</strong><span>等待確認</span></button></div>
          <div className="position-card"><div className="position-head"><span>Prop 帳戶 · 權益 {equity.toLocaleString(undefined, { maximumFractionDigits: 0 })} U</span><b className={accountStatus === "ACTIVE" || accountStatus === "PASSED" ? "open" : "flat"}>{accountStatus}</b></div>{positions.length ? <div className="position-stack">{positions.map((position) => <div className="position-values" key={position.id}><strong className={position.side === "LONG" ? "up" : "down"}>{position.side}</strong><span>進場 ${formatPrice(position.entry)} · 標記 ${formatPrice(position.mark)}</span><small>停損 ${formatPrice(position.stop)} · {position.leverage}× · 可與反向部位同持</small><button className="close-position" onClick={() => closePosition(position)}>平倉</button></div>)}</div> : lastChange ? <div className="position-values"><strong>上一筆已平倉</strong><span>${formatPrice(lastChange.entry)} → ${formatPrice(lastChange.exit)}</span><small className={lastChange.pnl >= 0 ? "up" : "down"}>最近變化 {lastChange.pnl >= 0 ? "+" : ""}{lastChange.pnl.toFixed(2)} U</small></div> : <div className="position-values"><strong>FLAT</strong><span>起始 Prop 模擬帳戶 {STARTING_BALANCE.toLocaleString()} U</span><small>可同時持有 LONG 與 SHORT；WAIT 也能繼續。</small></div>}</div>
          <button className="reveal-button" disabled={!canReveal} onClick={() => reveal()}>{canReveal ? "揭露下一根真實 K 線" : feedback ? "先查看決策結果" : tradePlan ? "先完成進場計畫" : "本局結算中"}<span>→</span></button>
          <div className="score-card"><div><span>紀律分數（起始 100）</span><strong>{discipline}<small>/100</small></strong></div><div className="xp-score"><span>回合 XP</span><b>{roundXp}</b><small>連勝 {streak} · 最佳 {bestStreak}</small></div><div className="score-ring" style={{ "--score": `${discipline}%` } as React.CSSProperties}><b>{discipline}</b></div></div>
          <div className="pnl-strip"><span>帳戶模擬 P&amp;L</span><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} U</b></div>
          {feedback && <div className="side-sheet feedback-side"><div className="result-card feedback-card"><p className="eyebrow">{feedback.finalResult ? "FINAL DECISION" : "DECISION RESULT"} · {feedback.xpEarned > 0 ? `+${feedback.xpEarned} XP` : "REVIEW"}</p><h2>你選擇 {feedback.decision}</h2><p className={feedback.correct ? "up" : "down"}>{feedback.correct ? `讀對了。連勝 ${feedback.streak} 根。` : "這根沒讀對，但它正是下一次的教材。"}</p><div className="result-metrics"><div><span>下一根變化</span><b className={feedback.candleReturn >= 0 ? "up" : "down"}>{feedback.candleReturn >= 0 ? "+" : ""}{feedback.candleReturn.toFixed(2)}%</b></div><div><span>帳戶變化</span><b className={feedback.pnlDelta >= 0 ? "up" : "down"}>{feedback.pnlDelta >= 0 ? "+" : ""}{feedback.pnlDelta.toFixed(2)} U</b></div><div><span>紀律分數</span><b>{discipline}</b></div></div><div className="coach-callout"><span>{feedback.insight.label} · {feedback.insight.pattern}</span><p>{feedback.insight.explanation}</p><small>下一次：{feedback.insight.nextFocus}</small></div><p>{feedback.exposure}{feedback.disciplineNote ? ` 紀律提醒：${feedback.disciplineNote}` : ""}</p><button className="reveal-button" onClick={continueAfterFeedback}>{feedback.finalResult ? "查看本局結算" : "繼續下一根 K 線"}<span>→</span></button></div></div>}
          {result && <div className="side-sheet result-side"><div className="result-card"><p className="eyebrow">PROP CHALLENGE · {result.status} · {result.xp} XP</p><h2>{result.status === "PASSED" ? "挑戰通過" : result.status === "FAILED" ? "挑戰停止" : "本局完成"}</h2><div className="result-metrics"><div><span>帳戶 P&amp;L</span><b className={result.pnl >= 0 ? "up" : "down"}>{result.pnl >= 0 ? "+" : ""}{result.pnl.toFixed(2)} U</b></div><div><span>判讀正確</span><b>{result.correct} / {result.decisions}</b></div><div><span>紀律分數</span><b>{result.discipline}</b></div></div><p>{result.reason} {result.discipline >= 80 ? "決策紀律穩定。" : "下局請優先檢查逆勢、追價與過度交易。"}</p><button className="reveal-button" onClick={() => setRoundKey((value) => value + 1)}>開始下一局 <span>→</span></button></div></div>}
          {tradePlan && <div className="trade-plan-side"><div className="trade-plan-card"><p className="eyebrow">TRADE PLAN · {tradePlan.side}</p><h2>保留圖表，設定風險。</h2><label>停損距離 <b>{tradePlan.stopPct.toFixed(1)}%</b><input aria-label="停損距離" type="range" min="0.3" max="3" step="0.1" value={tradePlan.stopPct} onChange={(event) => setTradePlan((plan) => plan ? { ...plan, stopPct: Number(event.target.value) } : plan)} /></label><label>槓桿倍數 <b>{tradePlan.leverage}×</b><input aria-label="交易計畫槓桿" type="range" min="1" max="20" value={tradePlan.leverage} onChange={(event) => setTradePlan((plan) => plan ? { ...plan, leverage: Number(event.target.value) } : plan)} /></label><div className="plan-preview"><span>預估進場 <b>${formatPrice(planEntry)}</b></span><span>預估停損風險 <b>{planRisk.toFixed(2)} U</b></span></div><button className="reveal-button" onClick={confirmTradePlan}>確認 {tradePlan.side} 進場 <span>→</span></button><button className="plan-cancel" onClick={() => setTradePlan(null)}>取消</button></div></div>}
        </aside>
      </section>

      <section className="bottom-grid">
        <div className="lesson-card"><p className="eyebrow">LEARNING LOOP · 任務 {Math.min(3, stats.correct)} / 3</p><h2>{lastInsight?.pattern || "先寫交易計畫，再承擔風險。"}</h2><p>{lastInsight?.explanation || "本局目標：讀對 3 次行情結構。每一次揭露都會說明 K 線留下的證據，而不只告訴你對錯。"}</p><div><span>{lastInsight ? "下一次" : "目前 K 線"}</span><b>{lastInsight?.nextFocus || roundDate(current?.time)}</b></div></div>
        <div className="log-card"><div className="log-head"><p className="eyebrow">DECISION LOG</p><span>最近事件</span></div>{log.map((item, index) => <p key={`${item}-${index}`} className={index === 0 ? "latest" : ""}>{index + 1}. {item}</p>)}</div>
        <div className="metric-card"><p className="eyebrow">PROP ACCOUNT</p><div className="metrics"><div><span>帳戶權益</span><b>{equity.toFixed(0)} U</b><i>{accountStatus}</i></div><div><span>本局 P&amp;L</span><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(1)} U</b><i>限制 −{SESSION_LOSS_LIMIT} U</i></div><div><span>目標</span><b>+{PROFIT_TARGET} U</b><i>模擬挑戰</i></div></div></div>
      </section>
    </main>
  );
}
