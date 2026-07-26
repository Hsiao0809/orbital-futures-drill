"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import TrainingChart from "./TrainingChart";

type Side = "LONG" | "SHORT" | "WAIT" | null;
type Candle = { time: number; open: number; high: number; low: number; close: number };
type Result = { pnl: number; score: number; correct: number; decisions: number; status: "PASSED" | "FAILED" | "COMPLETE"; reason: string };
type Position = { side: Exclude<Side, "WAIT" | null>; entry: number; mark: number; openedAt: number; margin: number };

const CONTEXT_BARS = 32;
const ROUND_BARS = 24;
const STARTING_BALANCE = 1_000;
const MARGIN_PER_POSITION = 50;
const PROFIT_TARGET = 80;
const SESSION_LOSS_LIMIT = 50;
const MAX_DRAWDOWN = 100;

const seedContracts = [
  ["BTCUSDT", "Bitcoin"], ["ETHUSDT", "Ethereum"], ["SOLUSDT", "Solana"], ["XRPUSDT", "XRP"], ["DOGEUSDT", "Dogecoin"],
  ["BNBUSDT", "BNB"], ["ADAUSDT", "Cardano"], ["AVAXUSDT", "Avalanche"], ["LINKUSDT", "Chainlink"], ["DOTUSDT", "Polkadot"],
  ["SUIUSDT", "Sui"], ["HYPEUSDT", "Hyperliquid"], ["ENAUSDT", "Ethena"], ["WIFUSDT", "dogwifhat"], ["1000PEPEUSDT", "Pepe"],
  ["FARTCOINUSDT", "Fartcoin"], ["PENGUUSDT", "Pudgy Penguins"], ["1000BONKUSDT", "Bonk"], ["WLDUSDT", "Worldcoin"], ["ARBUSDT", "Arbitrum"],
  ["OPUSDT", "Optimism"], ["APTUSDT", "Aptos"], ["INJUSDT", "Injective"], ["TIAUSDT", "Celestia"], ["NEARUSDT", "NEAR Protocol"],
  ["SEIUSDT", "Sei"], ["TRXUSDT", "TRON"], ["ATOMUSDT", "Cosmos"], ["FILUSDT", "Filecoin"], ["AAVEUSDT", "Aave"],
  ["1000SHIBUSDT", "Shiba Inu"],
].map(([symbol, name]) => ({ symbol, name }));

function formatPrice(value?: number) {
  if (!value) return "—";
  if (value < 0.01) return value.toFixed(6);
  if (value < 1) return value.toFixed(4);
  if (value < 100) return value.toFixed(2);
  if (value < 1000) return value.toFixed(1);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function roundDate(time?: number) {
  return time ? new Intl.DateTimeFormat("zh-TW", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(time) + " UTC" : "";
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
  const [score, setScore] = useState(72);
  const [pnl, setPnl] = useState(0);
  const [stats, setStats] = useState({ decisions: 0, correct: 0 });
  const [status, setStatus] = useState("正在載入 Binance 真實歷史 K 線…");
  const [error, setError] = useState("");
  const [roundKey, setRoundKey] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [log, setLog] = useState<string[]>(["準備從真實歷史行情中建立回合。"]);
  const [position, setPosition] = useState<Position | null>(null);
  const [lastChange, setLastChange] = useState<{ side: string; entry: number; exit: number; pnl: number } | null>(null);

  const choices = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized ? availableContracts.filter((item) => `${item.symbol} ${item.name}`.toLowerCase().includes(normalized)) : availableContracts;
    return matches.some((item) => item.symbol === contract.symbol) ? matches : [contract, ...matches];
  }, [query, contract, availableContracts]);

  useEffect(() => {
    fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`無法取得 Binance 合約清單（HTTP ${response.status}）`);
        return response.json() as Promise<{ symbols?: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string }> }>;
      })
      .then((payload) => {
        const contracts = (payload.symbols || [])
          .filter((item) => item.contractType === "PERPETUAL" && item.quoteAsset === "USDT" && item.status === "TRADING")
          .map((item) => ({ symbol: item.symbol, name: item.baseAsset }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol));
        if (!contracts.length) throw new Error("Binance 沒有回傳可交易的 USDT 永續合約");
        setAvailableContracts(contracts);
        setContract((selected) => contracts.find((item) => item.symbol === selected.symbol) || contracts[0]);
      })
      .catch(() => undefined);
  }, []);

  const loadRound = useCallback(async () => {
    setStatus("正在載入 Binance 真實歷史 K 線…");
    setError("");
    setResult(null);
    setSide(null);
    setScore(72);
    setPnl(0);
    setStats({ decisions: 0, correct: 0 });
    setPosition(null);
    setLastChange(null);
    try {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${contract.symbol}&interval=${timeframe}&limit=260`, { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const upstreamMessage = typeof payload === "object" && payload && "msg" in payload ? String(payload.msg) : "";
        throw new Error(`無法取得 Binance K 線資料（HTTP ${response.status}）${upstreamMessage ? `：${upstreamMessage}` : ""}`);
      }
      if (!Array.isArray(payload)) throw new Error("Binance K 線 API 回傳格式異常");
      const history = payload.slice(0, -1).map((row): Candle => {
        const item = row as [number, string, string, string, string];
        return { time: Number(item[0]), open: Number(item[1]), high: Number(item[2]), low: Number(item[3]), close: Number(item[4]) };
      });
      const first = CONTEXT_BARS;
      const last = history.length - ROUND_BARS;
      if (last <= first) throw new Error("可用的已收線資料不足，請再試一次");
      const anchor = first + Math.floor(Math.random() * (last - first));
      const round = history.slice(anchor - CONTEXT_BARS, anchor + ROUND_BARS);
      setCandles(round);
      setVisible(CONTEXT_BARS);
      setStatus(`真實歷史資料 · 回合起點 ${roundDate(round[CONTEXT_BARS - 1]?.time)}`);
      setLog([`${contract.symbol} ${timeframe} 真實歷史 K 線已載入；後續 ${ROUND_BARS} 根 K 線已鎖定。`]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "資料載入失敗";
      setCandles([]);
      setError(message);
      setStatus("尚未建立回合");
      setLog([`未載入資料：${message}`]);
    }
  }, [contract.symbol, timeframe, roundKey]);

  useEffect(() => { void loadRound(); }, [loadRound]);

  const current = candles[visible - 1];
  const movement = current ? ((current.close / current.open - 1) * 100).toFixed(2) : "0.00";
  const canReveal = Boolean(candles.length) && visible < candles.length && !result;
  const turnsComplete = Math.min(ROUND_BARS, Math.max(0, visible - CONTEXT_BARS));
  const equity = STARTING_BALANCE + pnl;
  const accountStatus = pnl >= PROFIT_TARGET ? "PASSED" : pnl <= -SESSION_LOSS_LIMIT ? "FAILED" : "ACTIVE";

  const choose = (choice: Exclude<Side, null>) => {
    if (accountStatus !== "ACTIVE") return;
    setSide(choice);
    if ((choice === "LONG" || choice === "SHORT") && current && position?.side !== choice) {
      setPosition({ side: choice, entry: current.close, mark: current.close, openedAt: current.time, margin: MARGIN_PER_POSITION });
      setLastChange(null);
      setLog((items) => [`建立 ${choice} 模擬倉 · 進場 $${formatPrice(current.close)} · 保證金 ${MARGIN_PER_POSITION.toLocaleString()} USDT`, ...items].slice(0, 4));
      return;
    }
    setLog((items) => [`已選擇 ${choice}；等待下一根真實 K 線揭露。`, ...items].slice(0, 4));
  };

  const closePosition = () => {
    if (!position || !current) return;
    const change = ((current.close / position.mark) - 1) * (position.side === "LONG" ? 1 : -1) * position.margin * leverage;
    setPnl((value) => value + change);
    setLastChange({ side: position.side, entry: position.entry, exit: current.close, pnl: change });
    setPosition(null);
    setLog((items) => [`平倉 ${position.side} · $${formatPrice(position.mark)} → $${formatPrice(current.close)} · 變化 ${change >= 0 ? "+" : ""}${change.toFixed(2)} USDT`, ...items].slice(0, 4));
  };

  const reveal = () => {
    if (!canReveal || !side) {
      setLog((items) => ["請先選擇 LONG、SHORT 或 WAIT，再揭露下一根 K 線。", ...items].slice(0, 4));
      return;
    }
    const next = candles[visible];
    const candleReturn = ((next.close / next.open) - 1) * 100;
    const isUp = candleReturn >= 0;
    const isCorrect = side === "WAIT" ? Math.abs(candleReturn) < 0.35 : (side === "LONG" ? isUp : !isUp);
    const scoreDelta = side === "WAIT" ? (isCorrect ? 5 : 1) : (isCorrect ? 6 : -5);
    const pnlDelta = position ? ((next.close / position.mark) - 1) * (position.side === "LONG" ? 1 : -1) * position.margin * leverage : 0;
    const nextScore = Math.max(0, Math.min(100, score + scoreDelta));
    const nextPnl = pnl + pnlDelta;
    const nextStats = { decisions: stats.decisions + 1, correct: stats.correct + (isCorrect ? 1 : 0) };
    const hitTarget = nextPnl >= PROFIT_TARGET;
    const hitLossLimit = nextPnl <= -SESSION_LOSS_LIMIT;
    const finalBar = visible + 1 === candles.length;
    const explanation = isCorrect ? "判讀與下一根收線方向一致。" : "判讀與下一根收線方向不一致。";

    setScore(nextScore);
    setPnl(nextPnl);
    setStats(nextStats);
    setVisible((value) => value + 1);
    setSide(null);
    if (position) {
      setPosition({ ...position, mark: next.close });
      setLastChange({ side: position.side, entry: position.mark, exit: next.close, pnl: pnlDelta });
    }
    setLog((items) => [position ? `${position.side} 持倉 · $${formatPrice(position.mark)} → $${formatPrice(next.close)} · 帳戶變化 ${pnlDelta >= 0 ? "+" : ""}${pnlDelta.toFixed(2)} USDT` : `${isUp ? "收漲" : "收跌"} ${candleReturn.toFixed(2)}% · ${explanation}`, ...items].slice(0, 4));
    if (finalBar || hitTarget || hitLossLimit) {
      setPosition(null);
      setResult({ pnl: nextPnl, score: nextScore, correct: nextStats.correct, decisions: nextStats.decisions, status: hitTarget ? "PASSED" : hitLossLimit ? "FAILED" : "COMPLETE", reason: hitTarget ? "已達 8% 獲利目標。" : hitLossLimit ? "觸及本局 5% 損失上限。" : "已完成所有真實 K 線回放。" });
    }
  };

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand"><span className="brand-mark">◈</span><span>ORBITAL</span><em>FUTURES DRILL</em></div>
        <div className="mode-pill"><span className="mode-dot" />PROP CHALLENGE · 真實歷史資料</div>
        <button className="ghost-button" onClick={() => setRoundKey((value) => value + 1)}>換一局</button>
      </section>

      <section className="intro compact-intro">
        <div><p className="eyebrow">CRYPTO PERPETUAL TRAINING</p><h1>USDT 永續合約盤感訓練</h1><p className="intro-copy">真實已收線 K 線、未來鎖定、逐根揭露。每局完成後才看完整結果。</p></div>
        <div className="streak-card"><span>Prop 挑戰進度</span><strong>{turnsComplete}<small> / {ROUND_BARS}</small></strong><p>目標 +8% · 上限 −5%</p><div className="tiny-bars"><b className="active" /><b className="active" /><b className="active" /><b /><b /><b /><b /></div></div>
      </section>

      <section className="training-grid">
        <aside className="control-panel">
          <div className="panel-heading"><span>01</span><div><h2>選擇合約</h2><p>Binance USDT 永續合約</p></div></div>
          <label>搜尋代號或名稱<input className="symbol-input" value={query} placeholder="例如 WIF 或 Solana" onChange={(event) => setQuery(event.target.value)} /></label>
          <label>從結果選擇<select value={contract.symbol} onChange={(event) => setContract(availableContracts.find((item) => item.symbol === event.target.value) || seedContracts[0])}>{choices.map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol} · {item.name}</option>)}</select></label>
          <label>K 線週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}><option>5m</option><option>15m</option><option>1h</option><option>4h</option></select></label>
          <div className="divider" />
          <div className="panel-heading compact"><span>02</span><div><h2>練習風控</h2><p>只影響模擬 P&L，不會下單</p></div></div>
          <label>槓桿 <strong className="field-value">{leverage}×</strong><input aria-label="槓桿" type="range" min="1" max="20" value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} /></label>
          <div className="risk-box"><div><span>挑戰目標</span><b>+8%</b></div><div><span>本局上限</span><b>−5%</b></div></div>
          <p className="micro-note">起始 {STARTING_BALANCE.toLocaleString()} U；最大回撤 {MAX_DRAWDOWN} U。使用已收線公開資料，不連真實帳戶。</p>
        </aside>

        <section className="chart-panel">
          <header className="chart-head"><div><p className="eyebrow">{contract.symbol} PERPETUAL · {timeframe}</p><h2>${formatPrice(current?.close)} <small className={Number(movement) >= 0 ? "up" : "down"}>{current ? `${Number(movement) >= 0 ? "+" : ""}${movement}%` : ""}</small></h2></div><div className="locked"><span>◉</span> FUTURE LOCKED</div></header>
          <div className="chart-area real-chart-area" aria-label="真實歷史 K 線訓練圖表"><TrainingChart candles={candles} visible={visible} loading={!candles.length && !error} /><div className="fog real-fog"><span>未揭露行情</span><strong>{Math.max(0, candles.length - visible)} 根 K 線</strong></div>{error && <div className="chart-error">{error}<button onClick={() => setRoundKey((value) => value + 1)}>重試</button></div>}</div>
          <footer className="chart-footer"><span>{status}</span><div className="progress"><i style={{ width: `${(turnsComplete / ROUND_BARS) * 100}%` }} /></div><span>Chart by TradingView™</span></footer>
          {result && <div className="result-overlay"><div className="result-card"><p className="eyebrow">PROP CHALLENGE · {result.status}</p><h2>{result.status === "PASSED" ? "挑戰通過" : result.status === "FAILED" ? "挑戰停止" : "本局完成"}</h2><div className="result-metrics"><div><span>帳戶 P&amp;L</span><b className={result.pnl >= 0 ? "up" : "down"}>{result.pnl >= 0 ? "+" : ""}{result.pnl.toFixed(2)} U</b></div><div><span>判讀正確</span><b>{result.correct} / {result.decisions}</b></div><div><span>紀律分數</span><b>{result.score}</b></div></div><p>{result.reason} {result.score >= 80 ? "決策紀律穩定。" : "下局請優先檢查逆勢、追價與過度交易。"}</p><button className="reveal-button" onClick={() => setRoundKey((value) => value + 1)}>開始下一局 <span>→</span></button></div></div>}
        </section>

        <aside className="decision-panel">
          <div className="panel-heading"><span>03</span><div><h2>你的判斷</h2><p>每根 K 線只能選一次</p></div></div>
          <div className="decision-buttons"><button className={side === "LONG" ? "chosen long" : "long"} onClick={() => choose("LONG")}><small>看多</small><strong>LONG</strong><span>突破／延續</span></button><button className={side === "SHORT" ? "chosen short" : "short"} onClick={() => choose("SHORT")}><small>看空</small><strong>SHORT</strong><span>跌破／轉弱</span></button><button className={side === "WAIT" ? "chosen wait" : "wait"} onClick={() => choose("WAIT")}><small>觀望</small><strong>WAIT</strong><span>等待確認</span></button></div>
          <div className="position-card"><div className="position-head"><span>Prop 帳戶 · 權益 {equity.toLocaleString(undefined, { maximumFractionDigits: 0 })} U</span><b className={accountStatus === "ACTIVE" ? "open" : accountStatus === "PASSED" ? "open" : "flat"}>{accountStatus}</b></div>{position ? <div className="position-values"><strong className={position.side === "LONG" ? "up" : "down"}>{position.side}</strong><span>進場 ${formatPrice(position.entry)} · 標記 ${formatPrice(position.mark)}</span><small>保證金 {position.margin.toLocaleString()} U · {leverage}×</small><button className="close-position" onClick={closePosition}>平倉</button></div> : lastChange ? <div className="position-values"><strong>上一筆已平倉</strong><span>${formatPrice(lastChange.entry)} → ${formatPrice(lastChange.exit)}</span><small className={lastChange.pnl >= 0 ? "up" : "down"}>最近變化 {lastChange.pnl >= 0 ? "+" : ""}{lastChange.pnl.toFixed(2)} U</small></div> : <div className="position-values"><strong>FLAT</strong><span>起始 Prop 模擬帳戶 {STARTING_BALANCE.toLocaleString()} U</span><small>選擇 LONG 或 SHORT 建立持倉；WAIT 不會平倉。</small></div>}</div>
          <button className="reveal-button" disabled={!canReveal} onClick={reveal}>{canReveal ? "揭露下一根真實 K 線" : "本局已完成"}<span>→</span></button>
          <div className="score-card"><div><span>紀律分數</span><strong>{score}<small>/100</small></strong></div><div className="score-ring" style={{ "--score": `${score}%` } as React.CSSProperties}><b>{score}</b></div></div>
          <div className="pnl-strip"><span>帳戶模擬 P&amp;L</span><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} U</b></div>
        </aside>
      </section>

      <section className="bottom-grid">
        <div className="lesson-card"><p className="eyebrow">ROUND RULE</p><h2>先決策，再看結果。</h2><p>本局資料來自已發生的 Binance 永續合約行情，系統只在你選擇後揭露下一根收線 K 棒。</p><div><span>當前回合</span><b>{roundDate(current?.time)}</b></div></div>
        <div className="log-card"><div className="log-head"><p className="eyebrow">DECISION LOG</p><span>本局紀錄</span></div>{log.map((item, index) => <p key={`${item}-${index}`} className={index === 0 ? "latest" : ""}>{index + 1}. {item}</p>)}</div>
        <div className="metric-card"><p className="eyebrow">PROP ACCOUNT</p><div className="metrics"><div><span>帳戶權益</span><b>{equity.toFixed(0)} U</b><i>{accountStatus}</i></div><div><span>本局變化</span><b className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(1)} U</b><i>上限 −{SESSION_LOSS_LIMIT} U</i></div><div><span>最大回撤</span><b>−{MAX_DRAWDOWN} U</b><i>模擬規則</i></div></div></div>
      </section>
    </main>
  );
}
