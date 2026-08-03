'use client';
import React from 'react';

export default function Topbar({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <header className="topbar">
      <h2>{title}</h2>
      {sub && <span className="crumb">{sub}</span>}
      <div className="spacer" />
      {right}
    </header>
  );
}
