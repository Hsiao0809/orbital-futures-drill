"use client";

import { useEffect, useMemo, useState } from "react";

type Side = "LONG" | "SHORT" | "WAIT" | null;
type Candle = { open: number; close: number; high: number; low: number };

const contracts = [
  { symbol: "BTCUSDT", name: "Bitcoin", price: 68420, tone: "#ff9f43" },
  { symbol: "ETHUSDT", name: "Ethereum", price: 3584, tone: "#9a8cff" },
  { symbol: "SOLUSDT", name: "Solana", price: 164.8, tone: "#48e0b8" },
  { symbol: "XRPUSDT", name: "XRP", price: 0.592, tone: "#56b5ff" },
  { symbol: "DOGEUSDT", name: "Dogecoin", price: 0.132, tone: "#ffcf5a" },
  { symbol: "BNBUSDT", name: "BNB", price: 604.2, tone: "#f3ba2f" },
  { symbol: "ADAUSDT", name: "Cardano", price: 0.431, tone: "#5ba8f5" },
  { symbol: "AVAXUSDT", name: "Avalanche", price: 32.4, tone: "#ef6d73" },
  { symbol: "LINKUSDT", name: "Chainlink", price: 14.76, tone: "#4b8fff" },
  { symbol: "DOTUSDT", name: "Polkadot", price: 5.91, tone: "#eb68a8" },
  { symbol: "LTCUSDT", name: "Litecoin", price: 84.2, tone: "#b9c4d0" },
  { symbol: "TRXUSDT", name: "TRON", price: 0.116, tone: "#ff5a5f" },
  { symbol: "SUIUSDT", name: "Sui", price: 0.822, tone: "#65d8ff" },
  { symbol: "HYPEUSDT", name: "Hyperliquid", price: 25.48, tone: "#f56aa0" },
  { symbol: "ENAUSDT", name: "Ethena", price: 0.364, tone: "#a9a6ff" },
  { symbol: "WIFUSDT", name: "dogwifhat", price: 1.64, tone: "#b1d6e7" },
  { symbol: "PEPEUSDT", name: "Pepe", price: 0.000011, tone: "#74d66e" },
  { symbol: "FARTCOINUSDT", name: "Fartcoin", price: 0.78, tone: "#e6ca78" },
  { symbol: "PENGUUSDT", name: "Pudgy Penguins", price: 0.012, tone: "#8be0ed" },
  { symbol: "BONKUSDT", name: "Bonk", price: 0.000018, tone: "#f2a848" },
  { symbol: "WLDUSDT", name: "Worldcoin", price: 2.16, tone: "#e9ecef" },
  { symbol: "ARBUSDT", name: "Arbitrum", price: 0.73, tone: "#66aef2" },
  { symbol: "OPUSDT", name: "Optimism", price: 1.87, tone: "#ff6871" },
  { symbol: "APTUSDT", name: "Aptos", price: 7.1, tone: "#ececf0" },
  { symbol: "INJUSDT", name: "Injective", price: 24.6, tone: "#7ac6f8" },
  { symbol: "TIAUSDT", name: "Celestia", price: 7.4, tone: "#dca8f3" },
  { symbol: "NEARUSDT", name: "NEAR Protocol", price: 5.2, tone: "#e7e8e9" },
  { symbol: "SEIUSDT", name: "Sei", price: 0.49, tone: "#ff6575" },
  { symbol: "TONUSDT", name: "Toncoin", price: 6.45, tone: "#57bde9" },
  { symbol: "ATOMUSDT", name: "Cosmos", price: 9.2, tone: "#6979dd" },
  { symbol: "FILUSDT", name: "Filecoin", price: 5.55, tone: "#1bb7ed" },
  { symbol: "AAVEUSDT", name: "Aave", price: 96.8, tone: "#a38ee6" },
  { symbol: "1000SHIBUSDT", name: "Shiba Inu", price: 17.4, tone: "#f19542" },
];

function seededSeries(base: number, seed: number): Candle[] {
  let value = base;
  const output: Candle[] = [];
  for (let i = 0; i < 76; i++) {
    const wave = Math.sin((i + seed) * 0.57) * 0.0105 + Math.cos((i + seed) * 0.21) * 0.006;
    const shock = (((i * 19 + seed * 11) % 17) - 8) * 0.0012;
    const open = value;
    const close = open * (1 + wave + shock);
    const wick = Math.abs(close - open) * (0.55 + ((i + seed) % 5) / 6) + open * 0.002;
    output.push({ open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick });
    value = close;
  }
  return output;
}

function price(value: number) {
  if (value < 1) return value.toFixed(4);
  if (value < 100) return value.toFixed(2);
  if (value < 1000) return value.toFixed(1);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export default function Home() {
  const [contract, setContract] = useState(contracts[0]);
  const [contractQuery, setContractQuery] = useState(contracts[0].symbol);
  const [searchOpen, setSearchOpen] = useState(false);
  const [timeframe, setTimeframe] = useState("15m");
  const [visible, setVisible] = useState(38);
  const [side, setSide] = useState<Side>(null);
  const [leverage, setLeverage] = useState(5);
  const [score, setScore] = useState(72);
  const [note, setNote] = useState("先等待關鍵位確認，再決定是否進場。");
  const [log, setLog] = useState<string[]>(["行情已載入。未來 38 根 K 線已鎖定。"]);

  const candles = useMemo(() => seededSeries(contract.price, contracts.findIndex((item) => item.symbol === contract.symbol) + 3), [contract]);
  const shown = candles.slice(Math.max(0, visible - 28), visible);
  const matchedContracts = contracts.filter((item) => `${item.symbol} ${item.name}`.toLowerCase().includes(contractQuery.toLowerCase())).slice(0, 7);
  const current = candles[Math.max(0, visible - 1)];
  const movement = current ? ((current.close / current.open - 1) * 100).toFixed(2) : "0.00";
  const canReveal = visible < candles.length;

  useEffect(() => {
    setVisible(38);
    setContractQuery(contract.symbol);
    setSide(null);
    setLog([`${contract.symbol} 永續合約已載入。未來 38 根 K 線已鎖定。`]);
    setNote("先等待關鍵位確認，再決定是否進場。");
  }, [contract]);

  const choose = (choice: Side) => {
    setSide(choice);
    const label = choice === "LONG" ? "做多" : choice === "SHORT" ? "做空" : "觀望";
    setLog((items) => [`你選擇了${label}，槓桿 ${leverage}×。等待下一根 K 線驗證。`, ...items].slice(0, 4));
  };

  const reveal = () => {
    if (!canReveal) return;
    const next = candles[visible];
    const up = next.close >= next.open;
    let delta = 0;
    let feedback = "尚未提交方向：這根只作觀察，不計分。";
    if (side === "WAIT") {
      delta = Math.abs((next.close / next.open - 1) * 100) < 1.1 ? 6 : 1;
      feedback = delta > 1 ? "觀望有效：波動沒有形成明確優勢。" : "觀望安全，但這一段有可辨識的延續動能。";
    }
    if (side === "LONG") {
      delta = up ? 7 : -5;
      feedback = up ? "多方判讀正確；仍要確認停損是否可承受。" : "多方失誤：先保護本金，比加碼更重要。";
    }
    if (side === "SHORT") {
      delta = up ? -5 : 7;
      feedback = up ? "空方失誤：趨勢未轉弱，避免逆勢攤平。" : "空方判讀正確；不要因單次獲利放大槓桿。";
    }
    setScore((value) => Math.max(0, Math.min(100, value + delta)));
    setVisible((value) => value + 1);
    setLog((items) => [`第 ${visible - 37} 根揭露：${up ? "收漲" : "收跌"}。${feedback}`, ...items].slice(0, 4));
    setSide(null);
  };

  const reset = () => {
    setVisible(38);
    setSide(null);
    setScore(72);
    setLog(["新回合開始。未來走勢再次鎖定，從你的第一個判斷開始。"]);
  };

  const max = Math.max(...shown.map((candle) => candle.high));
  const min = Math.min(...shown.map((candle) => candle.low));
  const range = max - min || 1;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand"><span className="brand-mark">◈</span><span>ORBITAL</span><em>FUTURES DRILL</em></div>
        <div className="mode-pill"><span className="mode-dot" />模擬訓練中 · 不連接交易所</div>
        <button className="ghost-button" onClick={reset}>重新開局</button>
      </section>

      <section className="intro">
        <div>
          <p className="eyebrow">CRYPTO PERPETUAL TRAINING</p>
          <h1>USDT 永續合約盤感訓練</h1>
          <p className="intro-copy">選方向或觀望，鎖住未來，讓決策品質而非單次盈虧累積能力。</p>
        </div>
        <div className="streak-card">
          <span>今日訓練</span>
          <strong>03 <small>局</small></strong>
          <p>最長專注：18 分鐘</p>
          <div className="tiny-bars"><b /><b /><b className="active" /><b className="active" /><b className="active" /><b /><b /></div>
        </div>
      </section>

      <section className="training-grid">
        <aside className="control-panel">
          <div className="panel-heading"><span>01</span><div><h2>設定訓練</h2><p>只使用 USDT 永續合約</p></div></div>
          <div className="contract-search"><label>搜尋永續合約<input aria-label="搜尋永續合約" value={contractQuery} placeholder="例如 WIFUSDT" onFocus={() => setSearchOpen(true)} onChange={(event) => { setContractQuery(event.target.value.toUpperCase()); setSearchOpen(true); }} /></label>{searchOpen && <div className="contract-results">{matchedContracts.length ? matchedContracts.map((item) => <button type="button" key={item.symbol} onMouseDown={() => { setContract(item); setContractQuery(item.symbol); setSearchOpen(false); }}><b>{item.symbol}</b><span>{item.name}</span></button>) : <p>目前訓練清單沒有這個合約</p>}</div>}</div>
          <div className="single-select"><label>K 線週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}><option>5m</option><option>15m</option><option>1h</option><option>4h</option></select></label></div>
          <div className="divider" />
          <div className="panel-heading compact"><span>02</span><div><h2>風控邊界</h2><p>練習先限制風險，再追求報酬</p></div></div>
          <label>槓桿 <strong className="field-value">{leverage}×</strong><input aria-label="槓桿" type="range" min="1" max="20" value={leverage} onChange={(event) => setLeverage(Number(event.target.value))} /></label>
          <div className="risk-box"><div><span>單局風險</span><b>1.0%</b></div><div><span>預設 RR</span><b>1 : 2.0</b></div></div>
          <p className="micro-note">這是訓練假設，非真實報價、投資建議或下單介面。</p>
        </aside>

        <section className="chart-panel">
          <header className="chart-head"><div><p className="eyebrow">{contract.symbol} PERPETUAL · {timeframe}</p><h2>${price(current.close)} <small className={Number(movement) >= 0 ? "up" : "down"}>{Number(movement) >= 0 ? "+" : ""}{movement}%</small></h2></div><div className="locked"><span>◉</span> FUTURE LOCKED</div></header>
          <div className="chart-area" aria-label="K 線訓練圖表">
            <div className="price-label top">{price(max)}</div><div className="price-label bottom">{price(min)}</div>
            <div className="chart-gridlines" />
            <div className="candles">{shown.map((candle, index) => {
              const isUp = candle.close >= candle.open;
              const bodyTop = ((max - Math.max(candle.open, candle.close)) / range) * 100;
              const bodyHeight = Math.max(2, (Math.abs(candle.close - candle.open) / range) * 100);
              const wickTop = ((max - candle.high) / range) * 100;
              const wickHeight = Math.max(2, ((candle.high - candle.low) / range) * 100);
              return <div className={`candle ${isUp ? "positive" : "negative"}`} key={`${index}-${candle.close}`}><i style={{ top: `${wickTop}%`, height: `${wickHeight}%` }} /><b style={{ top: `${bodyTop}%`, height: `${bodyHeight}%` }} /></div>;
            })}</div>
            <div className="fog"><span>未揭露行情</span><strong>{candles.length - visible} 根 K 線</strong></div>
            <div className="axis"><span>過去</span><span>現在</span><span>未來</span></div>
          </div>
          <footer className="chart-footer"><span>回合進度 <b>{visible - 37} / 38</b></span><div className="progress"><i style={{ width: `${((visible - 37) / 38) * 100}%` }} /></div><span>圖表資料：訓練情境</span></footer>
        </section>

        <aside className="decision-panel">
          <div className="panel-heading"><span>03</span><div><h2>你的判斷</h2><p>觀望也是一種決策</p></div></div>
          <div className="decision-buttons"><button className={side === "LONG" ? "chosen long" : "long"} onClick={() => choose("LONG")}><small>看多</small><strong>LONG</strong><span>突破／延續</span></button><button className={side === "SHORT" ? "chosen short" : "short"} onClick={() => choose("SHORT")}><small>看空</small><strong>SHORT</strong><span>跌破／轉弱</span></button><button className={side === "WAIT" ? "chosen wait" : "wait"} onClick={() => choose("WAIT")}><small>不出手</small><strong>WAIT</strong><span>等待確認</span></button></div>
          <label className="note-label">判斷依據<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <button className="reveal-button" disabled={!canReveal} onClick={reveal}>揭露下一根 K 線 <span>→</span></button>
          <div className="score-card"><div><span>紀律分數</span><strong>{score}<small>/100</small></strong></div><div className="score-ring" style={{ "--score": `${score}%` } as React.CSSProperties}><b>{score}</b></div></div>
        </aside>
      </section>

      <section className="bottom-grid">
        <div className="lesson-card"><p className="eyebrow">TODAY'S FOCUS</p><h2>不交易，也要有理由。</h2><p>目前走勢仍在區間中段。若沒有明確的結構突破或風險報酬優勢，等待比猜方向更有價值。</p><div><span>訓練目標</span><b>避免中段追價</b></div></div>
        <div className="log-card"><div className="log-head"><p className="eyebrow">DECISION LOG</p><span>本局紀錄</span></div>{log.map((item, index) => <p key={`${item}-${index}`} className={index === 0 ? "latest" : ""}>{index + 1}. {item}</p>)}</div>
        <div className="metric-card"><p className="eyebrow">SESSION METRICS</p><div className="metrics"><div><span>守紀率</span><b>84%</b><i>+6%</i></div><div><span>觀望品質</span><b>78%</b><i>+11%</i></div><div><span>過度槓桿</span><b>0</b><i>穩定</i></div></div></div>
      </section>
    </main>
  );
}
