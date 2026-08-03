"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useProfile } from "@/lib/store/profile.ts";
import { levelOf } from "@/lib/engine/scoring.ts";

const LINKS = [
  { href: "/", label: "儀表板" },
  { href: "/train", label: "訓練" },
  { href: "/learn", label: "案例教材" },
  { href: "/exam", label: "考試模擬" },
  { href: "/journal", label: "紀錄與診斷" },
];

export default function TopNav() {
  const pathname = usePathname();
  const { profile, ready } = useProfile();
  const level = levelOf(profile.xp);

  return (
    <nav className="topnav">
      <Link href="/" className="brand">
        <span className="brand-mark">↗</span>
        <span>ORBITAL</span>
        <em>PROP TRAINER</em>
      </Link>
      <div className="navlinks">
        {LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link key={link.href} href={link.href} className={active ? "active" : undefined}>
              {link.label}
            </Link>
          );
        })}
      </div>
      {/* Rendered only after hydration: the level comes from localStorage and
          would otherwise mismatch the server-rendered markup. */}
      <div className="nav-meta">
        {ready ? (
          <>
            <span>
              L{level.level} · <span className="dim">{level.rank}</span>
            </span>
            <span>
              <b>{profile.xp.toLocaleString()}</b> XP
            </span>
            {profile.streakDays > 0 && <span className="pill pill-lime">連續 {profile.streakDays} 天</span>}
          </>
        ) : (
          <span className="dim">載入中…</span>
        )}
      </div>
    </nav>
  );
}
