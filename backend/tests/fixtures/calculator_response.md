```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Calculator</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: radial-gradient(1200px 600px at 20% 10%, #1f2937, #0b1120);
    font-family: "Segoe UI", system-ui, sans-serif;
  }
  .calc {
    width: 320px;
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 20px;
    padding: 18px;
    box-shadow: 0 20px 50px rgba(0,0,0,.5);
  }
  .display {
    background: #0b1120;
    color: #e5e7eb;
    border-radius: 12px;
    padding: 18px 16px;
    margin-bottom: 14px;
    text-align: right;
    overflow: hidden;
  }
  .history {
    display: block;
    min-height: 1.2em;
    color: #6b7280;
    font-size: 0.95rem;
    font-variant-numeric: tabular-nums;
  }
  .result {
    display: block;
    font-size: 2.2rem;
    font-weight: 600;
    line-height: 1.1;
    word-break: break-all;
    font-variant-numeric: tabular-nums;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  button {
    height: 58px;
    border: none;
    border-radius: 12px;
    font-size: 1.2rem;
    font-weight: 600;
    cursor: pointer;
    color: #f9fafb;
    background: #1f2937;
    transition: transform .08s ease, filter .15s ease;
  }
  button:hover { filter: brightness(1.25); }
  button:active { transform: scale(.96); }
  button:focus-visible {
    outline: 3px solid #60a5fa;
    outline-offset: 2px;
  }
  .op { background: #374151; }
  .fn { background: #4b5563; }
  .eq { background: #2563eb; }
  .zero { grid-column: span 2; }
</style>
</head>
<body>
  <main class="calc" aria-label="Calculator">
    <div class="display">
      <span class="history" id="history" aria-hidden="true"></span>
      <span class="result" id="result" role="status" aria-live="polite">0</span>
    </div>
    <div class="grid">
      <button class="fn" data-action="clear" aria-label="Clear">AC</button>
      <button class="fn" data-action="delete" aria-label="Delete last digit">DEL</button>
      <button class="op" data-action="percent" aria-label="Percent">%</button>
      <button class="op" data-action="op" data-value="/" aria-label="Divide">/</button>

      <button data-value="7">7</button>
      <button data-value="8">8</button>
      <button data-value="9">9</button>
      <button class="op" data-action="op" data-value="*" aria-label="Multiply">x</button>

      <button data-value="4">4</button>
      <button data-value="5">5</button>
      <button data-value="6">6</button>
      <button class="op" data-action="op" data-value="-" aria-label="Subtract">-</button>

      <button data-value="1">1</button>
      <button data-value="2">2</button>
      <button data-value="3">3</button>
      <button class="op" data-action="op" data-value="+" aria-label="Add">+</button>

      <button class="zero" data-value="0">0</button>
      <button data-value=".">.</button>
      <button class="eq" data-action="equals" aria-label="Equals">=</button>
    </div>
  </main>

<script>
(function () {
  const resultEl = document.getElementById("result");
  const historyEl = document.getElementById("history");
  const buttons = Array.from(document.querySelectorAll("button"));

  let current = "0";
  let previous = null;
  let operator = null;
  let overwrite = true;
  let lastExpr = null;

  function formatDisplay(value) {
    if (value === "Error") return "Error";
    if (!isFinite(value)) return "Error";
    const num = Number(value);
    if (Math.abs(num) >= 1e15 || (num !== 0 && Math.abs(num) < 1e-9)) {
      return num.toExponential(8).replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
    }
    return String(num);
  }

  function render() {
    resultEl.textContent = overwrite ? formatDisplay(previous !== null && operator ? current : current) : current;
    historyEl.textContent = lastExpr || (previous !== null && operator ? formatDisplay(previous) + " " + label(operator) : "");
  }

  function label(op) {
    return { "+": "+", "-": "-", "*": "x", "/": "/" }[op] || op;
  }

  function compute(a, b, op) {
    a = Number(a); b = Number(b);
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? NaN : a / b;
      default: return b;
    }
  }

  function setError() {
    current = "Error";
    previous = null;
    operator = null;
    overwrite = true;
    lastExpr = null;
    render();
  }

  function inputDigit(d) {
    if (current === "Error") { current = "0"; overwrite = true; }
    if (overwrite) { current = d; overwrite = false; }
    else if (d === ".") { if (!current.includes(".")) current += d; }
    else {
      if (current === "0") current = d;
      else if (current.replace(/[-.]/g, "").length < 15) current += d;
    }
    render();
  }

  function inputOp(op) {
    if (current === "Error") return;
    if (operator && !overwrite) {
      const r = compute(previous, current, operator);
      if (isNaN(r)) return setError();
      previous = r;
      lastExpr = formatDisplay(r) + " " + label(op);
    } else {
      previous = Number(current);
      lastExpr = formatDisplay(previous) + " " + label(op);
    }
    operator = op;
    overwrite = true;
    render();
  }

  function equals() {
    if (current === "Error" || operator === null) return;
    const r = compute(previous, current, operator);
    lastExpr = formatDisplay(previous) + " " + label(operator) + " " + formatDisplay(current) + " =";
    current = formatDisplay(r);
    previous = r;
    operator = null;
    overwrite = true;
    render();
  }

  function clearAll() {
    current = "0"; previous = null; operator = null; overwrite = true; lastExpr = null;
    render();
  }

  function deleteLast() {
    if (current === "Error") return clearAll();
    if (overwrite) return;
    current = current.slice(0, -1) || "0";
    render();
  }

  function percent() {
    if (current === "Error") return;
    const v = Number(current) / 100;
    current = formatDisplay(v);
    overwrite = true;