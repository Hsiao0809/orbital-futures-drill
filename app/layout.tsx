import type { Metadata } from "next";
import "./globals.css";
import TopNav from "./components/TopNav";

export const metadata: Metadata = {
  title: "ORBITAL · Prop 考試訓練系統",
  description:
    "以真實歷史 K 線與精確的 prop firm 規則引擎，訓練通過考試所需的風險控制與決策紀律。純模擬，不連接交易所、不下單。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>
        <div className="shell">
          <TopNav />
          {children}
          <footer className="footnote">
            ORBITAL 是純模擬的訓練工具。它不連接任何交易所、不執行真實下單、不提供交易訊號，
            也不對任何考試結果或獲利做出保證。所有帳戶、部位與損益皆為模擬值；
            手續費、滑價與資金費率為建模估算，與真實交易環境會有差異。
            歷史行情資料來自 Binance USDⓈ-M 永續合約公開 API。
          </footer>
        </div>
      </body>
    </html>
  );
}
