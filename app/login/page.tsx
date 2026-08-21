'use client';
import { useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const sp = useSearchParams();
  const router = useRouter();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.error || '登录失败'); return; }
      // 用整页跳转，确保 middleware 能读到刚写入的 cookie
      window.location.href = sp.get('next') || '/';
    } catch (e: any) {
      setErr(e.message || '网络错误');
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24, background: 'var(--bg)',
    }}>
      <div className="card" style={{ width: 360, maxWidth: '100%' }}>
        <div className="card-b">
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 650 }}>勤进科技 · 物料库</div>
            <div className="muted small" style={{ marginTop: 3 }}>内部工具，请输入访问密码</div>
          </div>
          <form onSubmit={submit}>
            <div className="field">
              <label>访问密码</label>
              <input type="password" value={pw} autoFocus
                onChange={(e) => setPw(e.target.value)} placeholder="请输入密码" />
            </div>
            {err && <div className="note err" style={{ marginBottom: 12 }}>{err}</div>}
            <button className="btn primary" type="submit" disabled={busy || !pw}
              style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? <><span className="spin" /> 验证中…</> : '进入'}
            </button>
          </form>
          <div className="muted small" style={{ marginTop: 14, lineHeight: 1.6 }}>
            登录状态保持 14 天。密码在服务器上的 <span className="mono">.env</span> 文件里，改 <span className="mono">ACCESS_PASSWORD</span> 后重启服务生效。
          </div>
        </div>
      </div>
    </div>
  );
}
