#!/usr/bin/env node
/**
 * 快速结构检查：npm run check
 *
 * 这不是类型检查，也不能替代 `npm run build`。
 * 它只做几件 build 之前就能发现、而且犯过的错：
 *   1. JSX 标签是否配对
 *   2. import 的模块和导出名是否存在
 *   3. 有没有未使用的 import
 *   4. 有没有把「带参数的函数」直接传给 onClick 这类事件处理器
 *      （React 会把事件对象当成第一个参数传进去，tsc 会报错，
 *        v0.2.2 就是栽在这上面，连着两次部署失败）
 *
 * 权威检查始终是 `npm run build`，提交前务必单独跑一次。
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['app', 'lib'];
const files = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p); }
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  })(root);
}

let problems = 0;
const report = (msg) => { console.log('  ✗ ' + msg); problems++; };

/* ---------- 1. JSX 标签配对 ---------- */
const KW = new Set(['return', '=>', 'typeof', 'case', 'yield', 'await', 'of', 'in', 'do', 'else']);
function scanJsx(src) {
  const stack = [], errs = [];
  let i = 0; const n = src.length;
  const line = (p) => src.slice(0, p).split('\n').length;
  function jsxAllowed(p) {
    let k = p - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return true;
    const ch = src[k];
    if (/[A-Za-z0-9_$]/.test(ch)) {
      const e = k;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
      return KW.has(src.slice(k + 1, e + 1));   // 泛型 <T> 紧跟标识符，JSX 不会
    }
    return !(ch === ')' || ch === ']');
  }
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
      i++; continue;
    }
    if (c === '<') {
      const rest = src.slice(i);
      let m = /^<\/\s*([A-Za-z][\w.]*)?\s*>/.exec(rest);
      if (m) {
        const name = m[1] || '#fragment';
        const top = stack.pop();
        if (!top) errs.push(`第${line(i)}行 多余的 </${m[1] || ''}>`);
        else if (top.name !== name) errs.push(`第${line(i)}行 </${m[1] || ''}> 与第${line(top.pos)}行 <${top.name}> 不匹配`);
        i += m[0].length; continue;
      }
      const frag = /^<>/.test(rest);
      m = /^<([A-Za-z][\w.]*)(?=[\s/>])/.exec(rest);
      if ((frag || m) && jsxAllowed(i)) {
        const name = frag ? '#fragment' : m[1];
        let j = i + (frag ? 1 : m[0].length), depth = 0, selfClose = false;
        while (j < n) {
          const d = src[j];
          if (d === '{') { depth++; j++; continue; }
          if (d === '}') { depth--; j++; continue; }
          if (d === '"' || d === "'" || d === '`') {
            const q = d; j++;
            while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === q) break; j++; }
            j++; continue;
          }
          if (depth === 0 && d === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
          if (depth === 0 && d === '>') { j++; break; }
          j++;
        }
        if (!selfClose) stack.push({ name, pos: i });
        i = j; continue;
      }
    }
    i++;
  }
  for (const s of stack) errs.push(`第${line(s.pos)}行 <${s.name}> 未闭合`);
  return errs;
}

console.log('1) JSX 标签配对');
for (const f of files.filter((x) => x.endsWith('.tsx'))) {
  for (const e of scanJsx(fs.readFileSync(f, 'utf8'))) report(`${f} ${e}`);
}

/* ---------- 2. import 解析 + 3. 未使用 import ---------- */
const exportsOf = new Map();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const set = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) set.add(m[1]);
  for (const m of s.matchAll(/export\s+(?:const|let|var|type|interface|class)\s+(\w+)/g)) set.add(m[1]);
  if (/export\s+default/.test(s)) set.add('default');
  exportsOf.set(f, set);
}
const resolve = (spec, dir) => {
  const t = spec.startsWith('@/') ? spec.slice(2) : path.join(dir, spec);
  return [t + '.ts', t + '.tsx', t + '.js', path.join(t, 'index.ts'), path.join(t, 'index.tsx')]
    .find((c) => fs.existsSync(c));
};

console.log('2) import 路径与导出名');
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const dir = path.dirname(f);
  for (const m of s.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(\.[^']+|@\/[^']+)'/g)) {
    const hit = resolve(m[2], dir);
    if (!hit) { report(`${f} 找不到模块 ${m[2]}`); continue; }
    if (hit.endsWith('.js')) continue;
    for (let name of m[1].split(',')) {
      name = name.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
      if (name && !exportsOf.get(hit)?.has(name)) report(`${f} 从 ${m[2]} 导入了不存在的 ${name}`);
    }
  }
  for (const m of s.matchAll(/import\s+(\w+)\s+from\s+'(\.[^']+|@\/[^']+)'/g)) {
    const hit = resolve(m[2], dir);
    if (!hit) report(`${f} 找不到模块 ${m[2]}`);
  }
}

console.log('3) 未使用的 import');
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const body = s.replace(/^import[\s\S]*?from\s+'[^']+';?$/gm, '');
  for (const m of s.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from/g)) {
    for (let x of m[1].split(',')) {
      x = x.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, '').trim();
      if (!x) continue;
      const re = new RegExp('(?<![\\w$.])' + x.replace(/\$/g, '\\$') + '(?![\\w$])');
      if (!re.test(body)) report(`${f} 未使用的 import: ${x}`);
    }
  }
}

/* ---------- 4. 事件处理器直接传带参函数 ---------- */
console.log('4) 事件处理器参数');
// 记录形参个数，以及第一个形参「看起来是不是事件对象」。
// 因为 onSubmit={submit} 这种、handler 本来就要收 event 的写法是正确的，
// 只有第一个形参不是 event（比如我曾经写的 doPreview(kind)）才是 bug。
const arity = new Map();
const looksLikeEvent = (p) => {
  const first = (p.split(',')[0] || '').trim();
  if (!first) return false;
  const name = first.split(':')[0].trim().replace(/[?=].*$/, '');
  return /^(e|ev|evt|event)$/i.test(name) || /Event\b/.test(first);
};
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const add = (name, params) => arity.set(f + '::' + name, {
    n: params.trim() ? params.split(',').length : 0,
    evt: looksLikeEvent(params),
  });
  for (const m of s.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) add(m[1], m[2]);
  for (const m of s.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) add(m[1], m[2]);
}
for (const f of files.filter((x) => x.endsWith('.tsx'))) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bon([A-Z]\w+)=\{([A-Za-z_$][\w$]*)\}/g)) {
    let info = arity.get(f + '::' + m[2]);
    if (!info) for (const [k, v] of arity) if (k.endsWith('::' + m[2])) { info = v; break; }
    if (info && info.n > 0 && !info.evt) {
      const line = s.slice(0, m.index).split('\n').length;
      report(`${f}:${line} on${m[1]}={${m[2]}} —— ${m[2]} 的第一个形参不是事件对象，会被 React 传进事件对象`);
    }
  }
}

console.log();
if (problems) {
  console.log(`发现 ${problems} 个问题`);
  process.exit(1);
}
console.log(`检查通过（${files.length} 个文件）。注意：这不能替代 npm run build，提交前请务必单独跑一次 build。`);
