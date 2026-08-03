'use client';
import React, { useState } from 'react';

export default function Topbar({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  const [out, setOut] = useState(false);
  const logout = async () => {
    setOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } finally { setOut(false); }
  };

  return (
    <header className="topbar">
      <h2>{title}</h2>
      {sub && <span className="crumb">{sub}</span>}
      <div className="spacer" />
      {right}
      <button className="btn sm ghost" onClick={logout} disabled={out} title="退出登录">
        {out ? '退出中…' : '退出'}
      </button>
    </header>
  );
}
