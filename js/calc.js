// 金额算式求值：支持 + - * / × ÷ x 与括号，递归下降解析，纯函数、无 eval
// evalAmountInput('12+3.5') → { kind: 'expr', value: 15.5, expr: '12+3.5' }
// evalAmountInput('12.5')   → { kind: 'plain', value: 12.5 }
// evalAmountInput('-5')     → { kind: 'incomplete' }（正在输入，不报错，由保存时校验）
// evalAmountInput('12++')   → { kind: 'error', error: '…' }

// 全角/手机友好符号归一化
const OP_MAP = {
  '×': '*', 'x': '*', 'X': '*', '·': '*',
  '÷': '/', '／': '/',
  '＋': '+', '－': '-',
  '（': '(', '）': ')',
};

export function normalizeExpr(s) {
  let out = '';
  for (const ch of String(s ?? '').trim()) out += OP_MAP[ch] ?? ch;
  return out.replace(/^=/, '').trim(); // 容忍 Excel 习惯开头先打 =
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ') { i++; continue; }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      const num = src.slice(i, j);
      if (!/^\d+(\.\d+)?$|^\.\d+$/.test(num)) return { error: `数字格式不正确：${num}` };
      tokens.push({ t: 'num', v: parseFloat(num) });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(ch)) { tokens.push({ t: ch }); i++; continue; }
    return { error: `不能识别的字符：${ch}` };
  }
  return { tokens };
}

// expr  := term (('+'|'-') term)*
// term  := unary (('*'|'/') unary)*
// unary := ('-'|'+') unary | primary
// primary := 数字 | '(' expr ')'
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const parseExpr = () => {
    let v = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = next().t;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = next().t;
      const r = parseUnary();
      if (op === '/') {
        if (r === 0) throw new Error('除数不能为 0');
        v /= r;
      } else v *= r;
    }
    return v;
  };
  const parseUnary = () => {
    if (peek() && peek().t === '-') { next(); return -parseUnary(); }
    if (peek() && peek().t === '+') { next(); return parseUnary(); }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const tk = next();
    if (!tk) throw new Error('算式不完整');
    if (tk.t === 'num') return tk.v;
    if (tk.t === '(') {
      const v = parseExpr();
      const close = next();
      if (!close || close.t !== ')') throw new Error('缺少右括号');
      return v;
    }
    throw new Error('算式格式不正确');
  };
  const v = parseExpr();
  if (pos < tokens.length) throw new Error('算式格式不正确');
  return v;
}

export function evalExpr(raw) {
  const src = normalizeExpr(raw);
  if (!src) return { ok: false, error: '算式为空' };
  const t = tokenize(src);
  if (t.error) return { ok: false, error: t.error };
  if (!t.tokens.length) return { ok: false, error: '算式为空' };
  try {
    const value = parse(t.tokens);
    if (!isFinite(value)) return { ok: false, error: '结果不是有限数' };
    return { ok: true, value, expr: src };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 金额框输入分类：纯数字 / 算式 / 还在输入 / 非法
export function evalAmountInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'empty' };
  const norm = normalizeExpr(s);
  const isExpr = /[+\-*/]/.test(norm.slice(1)); // 首字符负号不算运算符
  if (!isExpr) {
    if (/^\d*\.?\d*$/.test(norm) && /\d/.test(norm)) {
      return { kind: 'plain', value: parseFloat(norm) };
    }
    if (/^[-+]?[\d.]*$/.test(norm)) return { kind: 'incomplete' };
    return { kind: 'error', error: '金额格式不正确' };
  }
  const r = evalExpr(norm);
  if (!r.ok) return { kind: 'error', error: r.error };
  return { kind: 'expr', value: r.value, expr: r.expr };
}
