"use client";

// Answer panels, one per drill kind. Each owns its input state and reports a
// finished answer upward; grading itself lives in the engine.

import { useMemo, useState } from "react";
import Chart, { type PriceLine } from "@/app/components/Chart";
import { evaluate } from "@/lib/engine/propRules.ts";
import { sizePosition } from "@/lib/engine/sizing.ts";
import RiskHud from "@/app/components/RiskHud";
import type {
  AnyAnswer,
  BiasScenario,
  ChoiceScenario,
  ExitScenario,
  SizingScenario,
  StopScenario,
} from "@/lib/engine/drills.ts";
import type { Side } from "@/lib/engine/types.ts";

const COLOURS = { entry: "#c8f466", stop: "#f26c7c", target: "#6ee7b7" };

function fmt(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(digits);
}

// ---------------------------------------------------------------------------

export function BiasPanel({
  scenario,
  onAnswer,
}: {
  scenario: BiasScenario;
  onAnswer: (answer: AnyAnswer) => void;
}) {
  const [choice, setChoice] = useState<Side | "SKIP" | null>(null);
  const [confidence, setConfidence] = useState<1 | 2 | 3>(2);

  return (
    <div className="split">
      <Chart candles={scenario.candles} visible={scenario.visibleCount} height={460} />
      <aside className="stack">
        <div className="card stack">
          <p className="eyebrow">
            {scenario.symbol} · {scenario.interval}
          </p>
          <p className="note">
            接下來 {scenario.horizon} 根 K 線內，價格會先走到哪一邊的 1 ATR？
            同一根同時觸及兩邊時，一律判定為不利方向——這跟真實停損被掃到的邏輯一致。
          </p>
          <div className="grid-2">
            <div className="stat stat-sm">
              <span>ATR</span>
              <b className="num">{fmt(scenario.atr)}</b>
              <i>{(scenario.structure.atrPct * 100).toFixed(2)}% 波動</i>
            </div>
            <div className="stat stat-sm">
              <span>結構強度</span>
              <b className="num">{(scenario.structure.strength * 100).toFixed(0)}%</b>
              <i>系統讀數僅供參考</i>
            </div>
          </div>
        </div>

        <div className="card stack">
          <p className="eyebrow">你的判斷</p>
          <div className="side-buttons">
            <button
              className={`side-btn ${choice === "LONG" ? "sel-long" : ""}`}
              onClick={() => setChoice("LONG")}
            >
              <strong>LONG</strong>
              <span>先上 1 ATR</span>
            </button>
            <button
              className={`side-btn ${choice === "SHORT" ? "sel-short" : ""}`}
              onClick={() => setChoice("SHORT")}
            >
              <strong>SHORT</strong>
              <span>先下 1 ATR</span>
            </button>
            <button
              className={`side-btn ${choice === "SKIP" ? "sel-skip" : ""}`}
              onClick={() => setChoice("SKIP")}
            >
              <strong>不參與</strong>
              <span>兩邊都不到</span>
            </button>
          </div>

          <div className="field">
            <span>信心程度（答對加分、答錯扣分）</span>
            <div className="conf-buttons">
              {([1, 2, 3] as const).map((level) => (
                <button
                  key={level}
                  className={`conf-btn ${confidence === level ? "on" : ""}`}
                  onClick={() => setConfidence(level)}
                >
                  {level === 1 ? "低" : level === 2 ? "中" : "高"}
                </button>
              ))}
            </div>
          </div>
          <p className="tiny">
            信心校準本身就是技能。你敢下大部位的那些判斷，錯的時候代價最高，所以高信心答錯扣分最重。
          </p>

          <button
            className="btn btn-primary btn-lg"
            disabled={!choice}
            onClick={() => choice && onAnswer({ kind: "BIAS", value: { choice, confidence } })}
          >
            揭露結果 →
          </button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StopPanel({
  scenario,
  onAnswer,
}: {
  scenario: StopScenario;
  onAnswer: (answer: AnyAnswer) => void;
}) {
  const [atrUnits, setAtrUnits] = useState(1.5);
  const direction = scenario.side === "LONG" ? -1 : 1;
  const stop = scenario.entry + direction * scenario.atr * atrUnits;

  const lines: PriceLine[] = [
    { price: scenario.entry, label: "進場", color: COLOURS.entry },
    { price: stop, label: "停損", color: COLOURS.stop, dashed: true },
  ];

  return (
    <div className="split">
      <Chart candles={scenario.candles} visible={scenario.visibleCount} lines={lines} height={460} />
      <aside className="stack">
        <div className="card stack">
          <p className="eyebrow">
            {scenario.symbol} · {scenario.interval}
          </p>
          <div className="row">
            <span className={`pill ${scenario.side === "LONG" ? "pill-green" : "pill-red"}`}>
              {scenario.side}
            </span>
            <span className="note">
              進場價 <b className="num">{fmt(scenario.entry)}</b>
            </span>
          </div>
          <p className="note">
            這筆交易在哪個價位算是看錯了？把停損放在那裡。太近會被雜訊掃掉，太遠會讓部位小到沒有意義。
          </p>
        </div>

        <div className="card stack">
          <p className="eyebrow">停損位置</p>
          <div className="row-between">
            <span className="note">距離進場</span>
            <b className="num" style={{ fontSize: 18 }}>
              {atrUnits.toFixed(2)} ATR
            </b>
          </div>
          <input
            type="range"
            min="0.2"
            max="5"
            step="0.05"
            value={atrUnits}
            aria-label="停損距離（ATR 倍數）"
            onChange={(event) => setAtrUnits(Number(event.target.value))}
          />
          <div className="grid-2">
            <div className="stat stat-sm">
              <span>停損價</span>
              <b className="num">{fmt(stop)}</b>
            </div>
            <div className="stat stat-sm">
              <span>停損幅度</span>
              <b className="num">{((Math.abs(scenario.entry - stop) / scenario.entry) * 100).toFixed(2)}%</b>
            </div>
          </div>
          <p className="tiny">ATR = {fmt(scenario.atr)}。這是近期單根 K 線的平均真實波幅。</p>

          <button
            className="btn btn-primary btn-lg"
            onClick={() => onAnswer({ kind: "STOP", value: { stop } })}
          >
            確認停損位置 →
          </button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SizingPanel({
  scenario,
  onAnswer,
}: {
  scenario: SizingScenario;
  onAnswer: (answer: AnyAnswer) => void;
}) {
  const [qty, setQty] = useState("");
  const metrics = useMemo(
    () => evaluate(scenario.account, scenario.account.balance),
    [scenario.account],
  );

  const parsed = Number(qty);
  const valid = qty.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const stopDistance = Math.abs(scenario.entry - scenario.stop);
  const impliedRisk = valid
    ? parsed * stopDistance + parsed * (scenario.entry + scenario.stop) * scenario.rules.takerFee
    : 0;

  // A worked reference so the learner sees the shape of the calculation
  // without being handed the answer: the room cap is deliberately not applied.
  const naive = sizePosition({
    equity: metrics.equity,
    riskPct: scenario.riskPct,
    entry: scenario.entry,
    stop: scenario.stop,
    side: scenario.side,
    rules: scenario.rules,
  });

  return (
    <div className="split">
      <div className="stack">
        <div className="card stack">
          <p className="eyebrow">情境</p>
          <p className="lede">{scenario.situation}</p>
          <div className="divider" />
          <div className="grid-4">
            <div className="stat stat-sm">
              <span>合約</span>
              <b style={{ fontSize: 13 }}>{scenario.symbol}</b>
            </div>
            <div className="stat stat-sm">
              <span>方向</span>
              <b className={scenario.side === "LONG" ? "up" : "down"} style={{ fontSize: 13 }}>
                {scenario.side}
              </b>
            </div>
            <div className="stat stat-sm">
              <span>進場價</span>
              <b className="num">{fmt(scenario.entry)}</b>
            </div>
            <div className="stat stat-sm">
              <span>停損價</span>
              <b className="num">{fmt(scenario.stop)}</b>
            </div>
          </div>
        </div>

        <div className="card stack">
          <p className="eyebrow">你的答案</p>
          <div className="field">
            <span>應該下多少口（基礎資產數量）？</span>
            <input
              type="text"
              inputMode="decimal"
              className="input-num"
              placeholder="例如 0.1234"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
            />
          </div>

          {valid && parsed > 0 && (
            <div className="grid-2">
              <div className="stat stat-sm">
                <span>這個口數的名目價值</span>
                <b className="num">{fmt(parsed * scenario.entry, 2)} U</b>
              </div>
              <div className="stat stat-sm">
                <span>停損觸發時虧損</span>
                <b className="num warn">{fmt(impliedRisk, 2)} U</b>
                <i>佔帳戶 {((impliedRisk / metrics.equity) * 100).toFixed(2)}%</i>
              </div>
            </div>
          )}
          {valid && parsed === 0 && (
            <p className="note">你的答案是「不交易」。在剩餘空間不足時，這確實可能是正解。</p>
          )}

          <button
            className="btn btn-primary btn-lg"
            disabled={!valid}
            onClick={() => onAnswer({ kind: "SIZING", value: { qty: parsed } })}
          >
            提交答案 →
          </button>
        </div>
      </div>

      <aside className="stack">
        <div className="card stack">
          <p className="eyebrow">帳戶風險狀態</p>
          <RiskHud metrics={metrics} rules={scenario.rules} pendingRisk={impliedRisk} />
        </div>
        <div className="card stack">
          <p className="eyebrow">提示</p>
          <p className="note">
            計畫風險為帳戶的 <b className="accent">{(scenario.riskPct * 100).toFixed(2)}%</b>，
            也就是 <b className="num">{fmt(metrics.equity * scenario.riskPct, 2)} U</b>。
          </p>
          <p className="note">
            停損距離 <b className="num">{fmt(stopDistance)}</b>，
            單邊手續費 {(scenario.rules.takerFee * 100).toFixed(3)}%（進出各一次）。
          </p>
          <p className="tiny">
            只用計畫風險算出來會是 {naive.qty.toFixed(4)} 口。但那不一定是正解——
            如果剩餘限額空間撐不住這個風險，正確答案要更小，甚至是零。
          </p>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ExitPanel({
  scenario,
  onAnswer,
}: {
  scenario: ExitScenario;
  onAnswer: (answer: AnyAnswer) => void;
}) {
  const anchor = scenario.visibleCount - 1;
  const risk = Math.abs(scenario.entry - scenario.stop);
  const direction = scenario.side === "LONG" ? 1 : -1;
  const lastIndex = Math.min(scenario.candles.length - 1, anchor + scenario.horizon);

  const [cursor, setCursor] = useState(anchor);
  const [stop, setStop] = useState(scenario.stop);
  const [movedToBreakeven, setMovedToBreakeven] = useState(false);

  const price = scenario.candles[cursor].close;
  const openR = ((price - scenario.entry) * direction) / risk;
  const barsLeft = lastIndex - cursor;

  const finish = (exitPrice: number, stoppedOut: boolean, closedIndex: number) => {
    onAnswer({
      kind: "EXIT",
      value: {
        closedIndex,
        realisedR: ((exitPrice - scenario.entry) * direction) / risk,
        stoppedOut,
      },
    });
  };

  const revealNext = () => {
    const next = cursor + 1;
    if (next > lastIndex) return;
    const candle = scenario.candles[next];
    const hit = scenario.side === "LONG" ? candle.low <= stop : candle.high >= stop;
    if (hit) {
      // Gap through the stop fills at the open, same rule as the simulator.
      const gapped = scenario.side === "LONG" ? candle.open <= stop : candle.open >= stop;
      setCursor(next);
      finish(gapped ? candle.open : stop, true, next);
      return;
    }
    setCursor(next);
    if (next === lastIndex) finish(candle.close, false, next);
  };

  const lines: PriceLine[] = [
    { price: scenario.entry, label: "進場", color: COLOURS.entry },
    { price: stop, label: movedToBreakeven ? "停損（成本）" : "停損", color: COLOURS.stop, dashed: true },
  ];

  return (
    <div className="split">
      <Chart candles={scenario.candles} visible={cursor + 1} lines={lines} height={460} />
      <aside className="stack">
        <div className="card stack">
          <p className="eyebrow">
            {scenario.symbol} · {scenario.interval}
          </p>
          <div className="row">
            <span className={`pill ${scenario.side === "LONG" ? "pill-green" : "pill-red"}`}>
              {scenario.side}
            </span>
            <span className="note">
              進場 <b className="num">{fmt(scenario.entry)}</b> · 停損{" "}
              <b className="num">{fmt(scenario.stop)}</b>
            </span>
          </div>
          <div className="grid-2">
            <div className="stat">
              <span>目前浮動損益</span>
              <b className={`num ${openR >= 0 ? "up" : "down"}`}>
                {openR >= 0 ? "+" : ""}
                {openR.toFixed(2)}R
              </b>
              <i>現價 {fmt(price)}</i>
            </div>
            <div className="stat">
              <span>剩餘 K 線</span>
              <b className="num">{barsLeft}</b>
              <i>到期會自動平倉</i>
            </div>
          </div>
        </div>

        <div className="card stack">
          <p className="eyebrow">操作</p>
          <button className="btn btn-lg" onClick={revealNext} disabled={barsLeft <= 0}>
            持有，揭露下一根 →
          </button>
          <button
            className="btn"
            disabled={movedToBreakeven || openR <= 0.2}
            onClick={() => {
              setStop(scenario.entry);
              setMovedToBreakeven(true);
            }}
          >
            停損移到成本價
          </button>
          <button
            className="btn btn-primary"
            onClick={() => finish(price, false, cursor)}
          >
            立即平倉（{openR >= 0 ? "+" : ""}
            {openR.toFixed(2)}R）
          </button>
          <p className="tiny">
            停損只能往獲利方向移動，往外移在真實帳戶上是最貴的一種操作，這裡不提供這個選項。
            浮盈超過 0.2R 之後才能移到成本價。
          </p>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ChoicePanel({
  scenario,
  onAnswer,
  chosenId,
}: {
  scenario: ChoiceScenario;
  onAnswer: (answer: AnyAnswer) => void;
  /** Set once answered, so the panel can mark right and wrong. */
  chosenId: string | null;
}) {
  const metrics = useMemo(
    () => evaluate(scenario.account, scenario.account.balance),
    [scenario.account],
  );
  const answered = chosenId !== null;

  return (
    <div className="split">
      <div className="stack">
        <div className="card stack">
          <p className="eyebrow">情境 · {scenario.rules.label}</p>
          <p className="lede">{scenario.situation}</p>
          <div className="divider" />
          <h2>{scenario.question}</h2>
        </div>

        <div className="choice-list">
          {scenario.options.map((option, index) => {
            const isCorrect = option.id === scenario.correctId;
            const isChosen = option.id === chosenId;
            const className = !answered
              ? "choice"
              : isCorrect
                ? "choice correct"
                : isChosen
                  ? "choice wrong"
                  : "choice";
            return (
              <button
                key={option.id}
                className={className}
                disabled={answered}
                onClick={() => onAnswer({ kind: scenario.kind, value: { choiceId: option.id } })}
              >
                <span className="choice-key">{String.fromCharCode(65 + index)}</span>
                <span>
                  <strong>{option.label}</strong>
                  <span>{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <aside className="card stack">
        <p className="eyebrow">帳戶風險狀態</p>
        <RiskHud metrics={metrics} rules={scenario.rules} />
        <div className="divider" />
        <p className="tiny">{scenario.rules.note}</p>
      </aside>
    </div>
  );
}
