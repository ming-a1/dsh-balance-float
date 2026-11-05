/**
 * Client half of the balance-float bundle.
 *
 * Registers one entry in the frame-wide `shell.overlay` slot: a small floating
 * pill that reads `/balance-float/snapshot` (the Host's view of the local usage
 * ledger) and expands into a card with today's spend, the peak/valley window
 * and the official per-million-token prices.
 *
 * The pill is draggable; its position is remembered per browser profile. Text
 * goes through the Client locale service so it follows the active language.
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-float',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    const NS = 'balance-float';
    const ROUTE = '/balance-float/snapshot';
    const POS_KEY = 'dsh.balance-float.position';
    // Official top-up page; the balance endpoint has no recharge API, so the
    // panel only links out to the console.
    const TOPUP_URL = 'https://platform.deepseek.com/top_up';
    const APPEARANCE_KEY = 'dsh.balance-float.appearance';
    // `bg` is transparency in percent (0 = solid token background), the other
    // two are strength in percent.
    const DEFAULT_APPEARANCE = { bg: 0, border: 100, shadow: 100 };
    // A 4s cadence keeps the balance and today's spend close to the ledger; the
    // route only reads a cached local file, so this stays cheap.
    const POLL_MS = 4000;
    const DEFAULT_CORNER = { right: 18, bottom: 84 };
    const CARD_WIDTH = 316;
    // The composer occupies the bottom band of the Web UI; a bubble needs this
    // much clear space underneath before it is allowed to open downward.
    const BUBBLE_MIN_ROOM = 120;

    const ZH = {
      title: 'API 余额',
      'pill.balance': '余额',
      'pill.today': '今日',
      balance: '余额',
      topup: '充值 ↗',
      'topup.title': '打开 DeepSeek 官方充值页',
      'balance.note': '今日 0 点 {start}，已用 {used}',
      'balance.noStart': '今日已用 {used}',
      today: '今日已用',
      turn: '本轮消耗',
      'turn.label': '本轮',
      'turn.meta': '{time} · {tokens} tokens',
      'turn.empty': '本轮暂无记录',
      'today.calls': '{count} 次调用 · {tokens} tokens',
      'today.split': '峰段 {peak} · 谷段 {valley}',
      peak: '峰谷',
      'peak.label': '峰价',
      valley: '谷价',
      'rule.peak': '峰',
      'rule.valley': '谷',
      'schedule.peak': '周一至周五 09:00–12:00、14:00–18:00',
      'schedule.valley': '工作日 12:00–14:00、18:00–次日 09:00，及周末与法定节假日全天',
      'peak.now': '当前按{label}计费',
      'peak.next': '距切到{label} {time}',
      'peak.noNext': '12 天内无切换',
      prices: '单价 元/百万 tokens',
      'prices.off': '谷',
      'prices.peak': '峰',
      'price.hit': '命中',
      'price.miss': '未命中',
      'price.out': '输出',
      history: '近 7 天',
      'history.total': '合计 {total}',
      source: '本地账本',
      updated: '更新于 {time}',
      refresh: '刷新',
      loading: '读取中…',
      retry: '重试',
      collapse: '收起',
      expand: '展开',
      'error.noLedger': '未找到本地用量账本',
      'error.fetch': '读取失败',
      'error.stale': '账本不是今天的数据',
      settings: '外观设置',
      'settings.open': '外观设置',
      'settings.bg': '背景透明度',
      'settings.border': '边框',
      'settings.shadow': '阴影',
      'settings.reset': '恢复默认',
      'settings.hint': '只保存在本机浏览器，刷新后仍然生效。',
      'settings.done': '完成',
      close: '关闭',
      'unit.h': '小时',
      'unit.m': '分',
      'unit.d': '天',
      'unit.s': '秒',
    };

    const EN = {
      title: 'API balance',
      'pill.balance': 'Balance',
      'pill.today': 'Today',
      balance: 'Balance',
      topup: 'Top up ↗',
      'topup.title': 'Open the official DeepSeek top-up page',
      'balance.note': 'Started today at {start}, used {used}',
      'balance.noStart': 'Used today {used}',
      today: 'Used today',
      turn: 'Last turn',
      'turn.label': 'Turn',
      'turn.meta': '{time} · {tokens} tokens',
      'turn.empty': 'No turn recorded yet',
      'today.calls': '{count} calls · {tokens} tokens',
      'today.split': 'Peak {peak} · Off-peak {valley}',
      peak: 'Pricing',
      'peak.label': 'Peak',
      valley: 'Off-peak',
      'rule.peak': 'Peak',
      'rule.valley': 'Off-peak',
      'schedule.peak': 'Mon–Fri 09:00–12:00, 14:00–18:00',
      'schedule.valley': 'Weekdays 12:00–14:00 and 18:00–09:00 next day, plus weekends and public holidays',
      'peak.now': 'Billed at {label} price now',
      'peak.next': 'Switches to {label} in {time}',
      'peak.noNext': 'No switch within 12 days',
      prices: 'CNY per million tokens',
      'prices.off': 'off-peak',
      'prices.peak': 'peak',
      'price.hit': 'Hit',
      'price.miss': 'Miss',
      'price.out': 'Out',
      history: 'Last 7 days',
      'history.total': 'Total {total}',
      source: 'Local ledger',
      updated: 'Updated {time}',
      refresh: 'Refresh',
      loading: 'Reading…',
      retry: 'Retry',
      collapse: 'Collapse',
      expand: 'Expand',
      'error.noLedger': 'No local usage ledger found',
      'error.fetch': 'Could not load the snapshot',
      'error.stale': 'The ledger is not from today',
      settings: 'Appearance',
      'settings.open': 'Appearance',
      'settings.bg': 'Background transparency',
      'settings.border': 'Border',
      'settings.shadow': 'Shadow',
      'settings.reset': 'Reset',
      'settings.hint': 'Saved in this browser only; it survives reloads.',
      'settings.done': 'Done',
      close: 'Close',
      'unit.h': 'h',
      'unit.m': 'm',
      'unit.d': 'd',
      'unit.s': 's',
    };

    const STYLE = [
      '.dbf-root{position:fixed;z-index:50;pointer-events:auto;font-family:inherit;color:var(--dsw-alias-label-primary)}',
      '.dbf-surface{position:relative;isolation:isolate}',
      '.dbf-surface::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--dsw-alias-bg-overlay);opacity:var(--dbf-bg,1);z-index:-1;pointer-events:none}',
      '.dbf-surface::after{content:"";position:absolute;inset:0;border-radius:inherit;border:.5px solid var(--dsw-alias-border-l1);opacity:var(--dbf-border,1);pointer-events:none}',
      '@keyframes dbf-open-down{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes dbf-open-up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes dbf-collapse-down{to{opacity:0;transform:translateY(-14px)}}',
      '@keyframes dbf-collapse-up{to{opacity:0;transform:translateY(14px)}}',
      '@keyframes dbf-fade{from{opacity:0}to{opacity:1}}',
      '.dbf-card.dbf-leaving,.dbf-pill.dbf-leaving{animation:dbf-collapse-down .18s cubic-bezier(.4,0,.7,.6) forwards !important;pointer-events:none;will-change:transform,opacity}',
      '.dbf-dir-up .dbf-card.dbf-leaving,.dbf-dir-up .dbf-pill.dbf-leaving{animation-name:dbf-collapse-up !important}',
      '.dbf-pill{display:flex;align-items:center;gap:9px;padding:6px 12px;border-radius:999px;background:transparent;box-shadow:0 6px 22px rgba(0,0,0,calc(.16 * var(--dbf-shadow,1)));font-size:12px;line-height:20px;white-space:nowrap;cursor:grab;user-select:none;touch-action:none;animation:dbf-fade .16s ease-out both}',
      '.dbf-dir-up .dbf-pill{animation-name:dbf-fade}',
      '.dbf-pill:active{cursor:grabbing}',
      '.dbf-pill-sep{width:.5px;height:12px;background:var(--dsw-alias-border-l2)}',
      '.dbf-label{color:var(--dsw-alias-label-secondary)}',
      '.dbf-num{font-variant-numeric:tabular-nums;font-weight:600}',
      '.dbf-note{color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.dbf-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
      '.dbf-dot.is-peak{background:var(--dsw-alias-state-error-primary)}',
      '.dbf-dot.is-valley{background:var(--dsw-alias-state-success-primary)}',
      '.dbf-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dbf-card{width:316px;border-radius:14px;background:transparent;box-shadow:0 12px 36px rgba(0,0,0,calc(.22 * var(--dbf-shadow,1)));overflow:hidden;font-size:12px;line-height:18px;animation:dbf-open-down .24s cubic-bezier(.22,.61,.36,1) both;display:flex;flex-direction:column;will-change:transform,opacity}',
      '.dbf-dir-up .dbf-card{animation-name:dbf-open-up}',
      '.dbf-head{display:flex;align-items:center;gap:8px;padding:9px 11px;background:transparent;border-bottom:.5px solid var(--dsw-alias-border-l1);cursor:grab;user-select:none;touch-action:none}',
      '.dbf-head.is-static{cursor:default}',
      '.dbf-head:active{cursor:grabbing}',
      '.dbf-head-title{flex:1;min-width:0;font-weight:600}',
      '.dbf-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1;transition:background .12s ease,color .12s ease}',
      '.dbf-icon svg{display:block}',
      '.dbf-icon:disabled{cursor:default;opacity:.6}',
      '.dbf-spinning svg{animation:dbf-spin .9s linear infinite}',
      '@keyframes dbf-spin{to{transform:rotate(360deg)}}',
      '.dbf-icon:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dbf-body{display:flex;flex-direction:column;gap:0;flex:1 1 auto;min-height:0;max-height:62vh;overflow:auto;scrollbar-width:none;-ms-overflow-style:none;touch-action:pan-y;overscroll-behavior:contain}',
      '.dbf-body::-webkit-scrollbar{width:0;height:0;display:none}',
      '.dbf-balance-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dbf-topup{flex:none;padding:2px 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:18px;cursor:pointer}',
      '.dbf-topup:hover{background:var(--dsw-alias-bg-overlay)}',
      '.dbf-countdown{margin-top:8px;margin-bottom:4px;font-size:15px;line-height:22px;letter-spacing:.01em}',
      '.dbf-rules{margin-top:4px;display:flex;flex-direction:column;gap:2px}',
      '.dbf-rule{display:flex;align-items:flex-start;gap:6px}',
      '.dbf-rule-tag{flex:none;font-weight:600;font-size:11px;line-height:16px;min-width:2.2em}',
      '.dbf-rule-text{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dbf-block{padding:11px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dbf-block:last-child{border-bottom:0}',
      '.dbf-balance{font-size:26px;line-height:32px;font-variant-numeric:tabular-nums;font-weight:650;letter-spacing:-.01em}',
      '.dbf-sub{margin-top:3px;color:var(--dsw-alias-label-secondary)}',
      '.dbf-row{display:flex;align-items:center;gap:8px;justify-content:space-between}',
      '.dbf-row-title{display:flex;align-items:center;gap:7px;font-weight:600}',
      '.dbf-grid{display:grid;grid-template-columns:64px 1fr;gap:4px 8px;margin-top:7px;color:var(--dsw-alias-label-secondary)}',
      '.dbf-grid b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}',
      '.dbf-table{width:100%;margin-top:7px;border-collapse:collapse;font-size:11px;line-height:16px}',
      '.dbf-table th{font-weight:400;color:var(--dsw-alias-label-secondary);text-align:right;padding:0 0 3px}',
      '.dbf-table th:first-child{text-align:left}',
      '.dbf-table td{padding:3px 0;text-align:right;font-variant-numeric:tabular-nums;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dbf-table td:first-child{text-align:left;color:var(--dsw-alias-label-secondary)}',
      '.dbf-now{font-weight:600}',
      '.dbf-peak{color:var(--dsw-alias-state-error-primary)}',
      '.dbf-valley{color:var(--dsw-alias-state-success-primary)}',
      '.dbf-badge.dbf-peak{border-color:currentColor}',
      '.dbf-badge.dbf-valley{border-color:currentColor}',
      '.dbf-bars{display:flex;align-items:flex-end;gap:5px;height:46px;margin-top:9px}',
      '.dbf-bar{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px}',
      '.dbf-bar-fill{width:100%;min-height:2px;border-radius:3px 3px 0 0;background:var(--dsw-alias-border-l2)}',
      '.dbf-bar.is-today .dbf-bar-fill{background:var(--dsw-alias-brand-primary)}',
      '.dbf-bar-day{color:var(--dsw-alias-label-secondary);font-size:9.5px;line-height:12px;font-variant-numeric:tabular-nums}',
      '.dbf-foot{display:flex;align-items:center;gap:6px;padding:7px 11px;background:transparent;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}',
      '.dbf-foot-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dbf-bubble{position:absolute;top:calc(100% + 8px);left:4px;display:flex;align-items:baseline;gap:6px;padding:5px 12px;border-radius:10px;box-shadow:0 8px 22px rgba(0,0,0,calc(.18 * var(--dbf-shadow,1)));font-size:13px;line-height:19px;white-space:nowrap;pointer-events:none;animation:dbf-flash 3s ease forwards}',
      '.dbf-bubble-label{color:var(--dsw-alias-label-secondary)}',
      '.dbf-bubble-amount{font-weight:600;font-variant-numeric:tabular-nums}',
      '.dbf-bubble.is-up{top:auto;bottom:calc(100% + 8px);animation-name:dbf-flash-up}',
      '.dbf-bubble-caret{position:absolute;top:-4px;left:14px;width:8px;height:8px;transform:rotate(45deg);background:var(--dsw-alias-bg-overlay);opacity:var(--dbf-bg,1);border-left:.5px solid var(--dsw-alias-border-l1);border-top:.5px solid var(--dsw-alias-border-l1);pointer-events:none}',
      '.dbf-bubble.is-up .dbf-bubble-caret{top:auto;bottom:-4px;border-left:0;border-top:0;border-right:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '@keyframes dbf-flash{0%{opacity:0;transform:translateY(-4px)}12%{opacity:1;transform:translateY(0)}84%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-2px)}}',
      '@keyframes dbf-flash-up{0%{opacity:0;transform:translateY(4px)}12%{opacity:1;transform:translateY(0)}84%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(2px)}}',
      '.dbf-setting{padding:8px 11px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dbf-setting:last-child{border-bottom:0}',
      '.dbf-range{display:block;width:100%;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dbf-setting-val{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.dbf-textbtn{padding:1px 9px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;line-height:18px}',
      '.dbf-textbtn:hover{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dbf-error{color:var(--dsw-alias-state-error-primary)}',
      '.dbf-skel{color:var(--dsw-alias-label-secondary)}',
    ].join('');

    /** Tabular money text without a currency glyph. */
    function money(value, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return value.toFixed(digits === undefined ? 2 : digits);
    }

    /** Unit price: keep small values readable and drop trailing zeros. */
    function price(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value === 0) return '0';
      const fixed = value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3);
      return fixed.replace(/\.?0+$/, '');
    }

    /** Compact token count. */
    function tokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
      if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
      return String(Math.round(value));
    }

    /** Beijing wall-clock HH:mm for an epoch millisecond value. */
    function clock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      const date = new Date(ms + 8 * 3600 * 1000);
      const hh = String(date.getUTCHours()).padStart(2, '0');
      const mm = String(date.getUTCMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    }

    /** Countdown text localized through the dictionary; seconds are always shown. */
    function duration(t, ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      // Two-digit minutes/seconds: single-digit values made the pill change
      // width every few seconds, which read as the widget jumping around.
      const pad = (value) => (value < 10 ? '0' + value : String(value));
      const parts = [];
      if (days > 0) parts.push(days + t('unit.d'));
      if (days > 0 || hours > 0) parts.push(hours + t('unit.h'));
      if (days > 0 || hours > 0 || minutes > 0) parts.push(pad(minutes) + t('unit.m'));
      parts.push(pad(seconds) + t('unit.s'));
      return parts.join('');
    }

    /** One `off-peak / peak` price cell with the active side emphasized. */
    function pair(values, peakActive) {
      const off = Array.isArray(values) ? values[0] : undefined;
      const peak = Array.isArray(values) ? values[1] : undefined;
      return h(
        'span',
        null,
        h('span', { className: peakActive ? '' : 'dbf-now dbf-valley' }, price(off)),
        ' / ',
        h('span', { className: peakActive ? 'dbf-now dbf-peak' : '' }, price(peak)),
      );
    }

    /** Circular-arrow refresh glyph; the arc spins while a fetch is in flight. */
    function RefreshIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
          stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, focusable: 'false',
        },
        h('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
        h('path', { d: 'M21 3v5h-5' }),
      );
    }

    /** Two-slider glyph: opens the appearance panel. */
    function SettingsIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
          stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, focusable: 'false',
        },
        h('path', { d: 'M4 7h9' }),
        h('path', { d: 'M17 7h3' }),
        h('circle', { cx: 15, cy: 7, r: 2 }),
        h('path', { d: 'M4 17h3' }),
        h('path', { d: 'M11 17h9' }),
        h('circle', { cx: 9, cy: 17, r: 2 }),
      );
    }

    /** Short model name for the price table. */
    function modelLabel(model) {
      const key = String(model || '').toLowerCase();
      if (key.indexOf('pro') !== -1) return 'Pro';
      if (key.indexOf('flash') !== -1) return 'Flash';
      return String(model || '—');
    }

    /** Persisted appearance, clamped to the sliders' own ranges. */
    function readAppearance() {
      try {
        const raw = window.localStorage.getItem(APPEARANCE_KEY);
        if (!raw) return { ...DEFAULT_APPEARANCE };
        const parsed = JSON.parse(raw);
        const pick = (value, min, max, fallback) => {
          const n = Number(value);
          if (!Number.isFinite(n)) return fallback;
          return Math.min(max, Math.max(min, Math.round(n / 5) * 5));
        };
        return {
          bg: pick(parsed?.bg, 0, 90, DEFAULT_APPEARANCE.bg),
          border: pick(parsed?.border, 0, 100, DEFAULT_APPEARANCE.border),
          shadow: pick(parsed?.shadow, 0, 100, DEFAULT_APPEARANCE.shadow),
        };
      } catch {
        return { ...DEFAULT_APPEARANCE };
      }
    }

    /** Persisted drag position, if it is still inside the viewport. */
    function readPosition() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;
        if (parsed.left < -40 || parsed.top < -40) return null;
        if (parsed.left > window.innerWidth - 40 || parsed.top > window.innerHeight - 40) return null;
        return { left: parsed.left, top: parsed.top };
      } catch {
        return null;
      }
    }

    /** Translate a frame ({left|right} + {top|bottom}) into CSS. */
    function frameStyle(frame) {
      const out = {};
      if (Number.isFinite(frame.right)) out.right = frame.right + 'px';
      else out.left = frame.left + 'px';
      if (Number.isFinite(frame.bottom)) out.bottom = frame.bottom + 'px';
      else out.top = frame.top + 'px';
      return out;
    }

    /** Clamp a number. */
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    // The shell can re-mount the overlay when a run starts or stops. Component
    // state is lost then, so the live position lives at module scope too: a
    // remount must not snap the widget back to the stored default.
    const shared = { frame: null, dir: 'up' };

    /** The floating pill and its expanded card. */
    function BalanceFloat(props) {
      const t = props.t;
      const [snapshot, setSnapshot] = useState(null);
      const [failure, setFailure] = useState('');
      const [busy, setBusy] = useState(false);
      const [open, setOpen] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [leaving, setLeaving] = useState(false);
      const [appearance, setAppearance] = useState(readAppearance);
      const [frame, setFrame] = useState(() => shared.frame ?? readPosition());
      const [dir, setDir] = useState(shared.dir);
      const rootRef = useRef(null);
      const dragRef = useRef(null);
      const positionRef = useRef(null);
      const aliveRef = useRef(true);
      // The per-turn bubble: one flash per settled turn, then it fades itself out.
      const [flash, setFlash] = useState(false);
      // The bubble sits under the pill; near the bottom edge it flips above.
      const [bubbleUp, setBubbleUp] = useState(false);
      const flashAtRef = useRef(null);
      const flashTimerRef = useRef(null);
      const leaveTimerRef = useRef(null);
      // Mirror the frame/direction out of React state for the next mount.
      useEffect(() => {
        shared.frame = frame;
      }, [frame]);
      useEffect(() => {
        shared.dir = dir;
      }, [dir]);

      // Forces a re-render so the countdown text follows the clock.
      const [, setTick] = useState(0);
      // Host/browser clock offset, so the switch countdown follows the Host.
      const [offset, setOffset] = useState(0);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
          if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
        };
      }, []);

      useEffect(() => {
        const id = window.setInterval(() => setTick((value) => value + 1), 1000);
        return () => window.clearInterval(id);
      }, []);

      // Flip the turn bubble above the pill when the space below is too small
      // (the composer sits there). Re-measure on view changes only: doing it on
      // every drag frame would force a layout read per pointer move.
      useEffect(() => {
        if (!flash || open || settingsOpen) return;
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        setBubbleUp(window.innerHeight - rect.bottom < BUBBLE_MIN_ROOM);
      }, [flash, open, settingsOpen]);

      // Appearance lives in this browser profile only.
      useEffect(() => {
        try {
          window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
        } catch {
          // Private mode: the panel still works for this page view.
        }
      }, [appearance]);

      const changeAppearance = useCallback((key, value) => {
        setAppearance((current) => ({ ...current, [key]: value }));
      }, []);

      /**
       * Show the card, cancelling any in-flight collapse.
       *
       * The panel prefers to unfold downward from the pill; when the pill sits
       * near the bottom edge the free space is above it, so it unfolds upward
       * and the widget keeps its bottom edge in place.
       */
      const openView = useCallback(() => {
        if (leaveTimerRef.current !== null) {
          window.clearTimeout(leaveTimerRef.current);
          leaveTimerRef.current = null;
        }
        const rect = rootRef.current?.getBoundingClientRect();
        if (rect) {
          const spaceBelow = window.innerHeight - rect.bottom - 12;
          const spaceAbove = rect.top - 12;
          const downward = spaceBelow >= 340 || (spaceBelow >= 220 && spaceBelow >= spaceAbove);
          // The card is wider than the pill: keep the same visual corner by
          // pinning the right edge when the pill sits near the right border.
          const rightGap = window.innerWidth - rect.right;
          const horizontal = rightGap <= CARD_WIDTH + 12 ? { right: rightGap } : { left: rect.left };
          setDir(downward ? 'down' : 'up');
          setFrame({
            ...horizontal,
            ...(downward ? { top: rect.top } : { bottom: window.innerHeight - rect.bottom }),
          });
        }
        setLeaving(false);
        setOpen(true);
      }, []);

      /** Play the collapse animation, then unmount the card. */
      const closeView = useCallback(() => {
        if (leaveTimerRef.current !== null) return;
        setLeaving(true);
        leaveTimerRef.current = window.setTimeout(() => {
          leaveTimerRef.current = null;
          setLeaving(false);
          setOpen(false);
          setSettingsOpen(false);
        }, 200);
      }, []);

      const load = useCallback(async (manual) => {
        if (manual) setBusy(true);
        try {
          const response = await fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' });
          const body = await response.json();
          if (!aliveRef.current) return;
          if (!response.ok) throw new Error(typeof body?.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + response.status);
          setSnapshot(body);
          setOffset(typeof body?.serverNow === 'number' ? body.serverNow - Date.now() : 0);
          setFailure('');
          // A new settled turn (new `turn.at`) gets one bubble; the same turn never re-flashes.
          const turnAt = typeof body?.turn?.at === 'number' ? body.turn.at : null;
          if (turnAt !== null && turnAt !== flashAtRef.current) {
            flashAtRef.current = turnAt;
            setFlash(true);
            if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
            flashTimerRef.current = window.setTimeout(() => {
              flashTimerRef.current = null;
              if (aliveRef.current) setFlash(false);
            }, 3100);
          }
        } catch (error) {
          if (!aliveRef.current) return;
          setFailure(error instanceof Error && error.message !== '' ? error.message : String(error));
        } finally {
          if (manual && aliveRef.current) setBusy(false);
        }
      }, []);

      useEffect(() => {
        load();
        const id = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') load();
        }, POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') load();
        };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        return () => {
          window.clearInterval(id);
          document.removeEventListener('visibilitychange', onVisible);
          window.removeEventListener('focus', onVisible);
        };
      }, [load]);

      // Expanding the card is also a request for the freshest numbers.
      useEffect(() => {
        if (open) load();
      }, [open, load]);

      const persist = useCallback((next) => {
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify(next));
        } catch {
          // Private mode: the position lasts for this page view only.
        }
      }, []);

      // localStorage writes are synchronous: during a drag keep them rare.
      const lastPersistRef = useRef(0);
      const persistThrottled = useCallback(
        (next) => {
          const now = Date.now();
          if (now - lastPersistRef.current < 250) return;
          lastPersistRef.current = now;
          persist(next);
        },
        [persist],
      );

      // A drag writes straight to the DOM instead of React state, and owns the
      // pointer at the window capture stage: the shell's drawer gesture listens
      // on document capture, which would otherwise see (and act on) the swipe.
      const liveRef = useRef(null);
      const detachRef = useRef(null);

      const commitDrag = useCallback(() => {
        const last = liveRef.current;
        if (last === null) return;
        shared.frame = { left: last.left, top: last.top };
        setFrame({ left: last.left, top: last.top });
        persist(last);
      }, [persist]);

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return;
        // The header also carries buttons: a click there is not a drag/collapse.
        if (event.target instanceof Element && event.target.closest('button') !== null) return;
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        if (detachRef.current !== null) detachRef.current();
        const drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          moved: false,
        };
        dragRef.current = drag;
        liveRef.current = { left: rect.left, top: rect.top };
        event.currentTarget.setPointerCapture?.(event.pointerId);

        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== drag.id) return;
          if (moveEvent.cancelable) moveEvent.preventDefault();
          moveEvent.stopImmediatePropagation();
          const dx = moveEvent.clientX - drag.x;
          const dy = moveEvent.clientY - drag.y;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
          drag.moved = true;
          const width = drag.width > 0 ? drag.width : 120;
          const height = drag.height > 0 ? drag.height : 40;
          const next = {
            left: clamp(drag.left + dx, 4, Math.max(4, window.innerWidth - width - 4)),
            top: clamp(drag.top + dy, 4, Math.max(4, window.innerHeight - height - 4)),
          };
          positionRef.current = next;
          liveRef.current = next;
          shared.frame = { left: next.left, top: next.top };
          const node = rootRef.current;
          if (node !== null) {
            node.style.left = next.left + 'px';
            node.style.top = next.top + 'px';
            node.style.right = 'auto';
            node.style.bottom = 'auto';
          }
          persistThrottled(next);
        };
        // Some WebViews still deliver TouchEvents first: cancel those too, or
        // the page pans and the shell treats the swipe as "open the drawer".
        const onTouch = (touchEvent) => {
          if (touchEvent.cancelable) touchEvent.preventDefault();
          touchEvent.stopImmediatePropagation();
        };
        const detach = () => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onEnd, true);
          window.removeEventListener('pointercancel', onEnd, true);
          window.removeEventListener('touchmove', onTouch, true);
          detachRef.current = null;
        };
        const onEnd = (endEvent) => {
          if (endEvent.pointerId !== drag.id) return;
          endEvent.stopImmediatePropagation();
          detach();
          dragRef.current = null;
          if (drag.moved) {
            commitDrag();
            return;
          }
          if (open) closeView();
          else openView();
        };
        detachRef.current = detach;
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onEnd, true);
        window.addEventListener('pointercancel', onEnd, true);
        window.addEventListener('touchmove', onTouch, { capture: true, passive: false });
      }, [persistThrottled, commitDrag, open, closeView, openView]);

      useEffect(() => () => {
        if (detachRef.current !== null) detachRef.current();
        dragRef.current = null;
      }, []);

      const now = Date.now() + offset;
      const peakActive = snapshot?.peak?.active === true;
      const periodLabel = peakActive ? t('peak.label') : t('valley');
      const periodClass = peakActive ? 'dbf-peak' : 'dbf-valley';
      const nextAt = snapshot?.peak?.nextChangeAt;
      const countdown = typeof nextAt === 'number' ? duration(t, nextAt - now) : '';
      const stale = typeof snapshot?.today === 'string' && snapshot.today !== new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const prices = Array.isArray(snapshot?.prices) ? snapshot.prices : [];
      const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
      const historyMax = typeof snapshot?.historyMax === 'number' && snapshot.historyMax > 0 ? snapshot.historyMax : 0;
      const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
      const turn = snapshot?.turn ?? null;

      const liveFrame = dragRef.current !== null && liveRef.current !== null ? liveRef.current : frame;
      const style = liveFrame ? frameStyle(liveFrame) : { right: DEFAULT_CORNER.right + 'px', bottom: DEFAULT_CORNER.bottom + 'px' };
      // Unfolding downward must not run off the viewport: cap the card and let
      // its body scroll.
      const cardStyle =
        dir === 'down' && frame !== null && Number.isFinite(frame.top)
          ? { maxHeight: Math.max(180, window.innerHeight - frame.top - 16) + 'px' }
          : undefined;
      const surfaceStyle = {
        ...style,
        '--dbf-origin': dir === 'down' ? '50% 0%' : '50% 100%',
        '--dbf-bg': String((100 - appearance.bg) / 100),
        '--dbf-border': String(appearance.border / 100),
        '--dbf-shadow': String(appearance.shadow / 100),
      };

      const dot = h('span', { className: 'dbf-dot ' + (peakActive ? 'is-peak' : 'is-valley'), 'aria-hidden': true });

      const pill = h(
        'div',
        {
          key: 'pill',
          className: 'dbf-pill dbf-surface',
          role: 'button',
          tabIndex: 0,
          'aria-label': t('title'),
          title: t('title'),
          onPointerDown,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (open) closeView();
              else openView();
            }
          },
        },
        dot,
        h('span', { className: 'dbf-label' }, t('pill.balance')),
        h('span', { className: 'dbf-num' }, '¥' + money(snapshot?.balance)),
        h('span', { className: 'dbf-pill-sep' }),
        h('span', { className: 'dbf-label' }, t('pill.today')),
        h('span', { className: 'dbf-num' }, '¥' + money(snapshot?.todayUsed)),
        h('span', { className: 'dbf-pill-sep' }),
        h('span', { className: 'dbf-label ' + periodClass }, periodLabel),
        countdown !== '' ? h('span', { className: 'dbf-num' }, countdown) : null,
      );

      // The card subtree is only built when it can be seen: rebuilding ~150
      // elements on every 1s tick / pointer move is avoidable work.
      let card = null;
      if (open || leaving) {
        const header = h(
          'div',
          {
            className: 'dbf-head',
            title: t('collapse'),
            onPointerDown,
          },
          dot,
          h('span', { className: 'dbf-head-title' }, t('title')),
          h(
            'button',
            {
              type: 'button',
              className: 'dbf-icon',
              title: t('settings.open'),
              'aria-label': t('settings.open'),
              onClick: () => setSettingsOpen(true),
            },
            h(SettingsIcon),
          ),
          h(
            'button',
            {
              type: 'button',
              className: busy ? 'dbf-icon dbf-spinning' : 'dbf-icon',
              title: t('refresh'),
              'aria-label': t('refresh'),
              onClick: () => load(true),
              disabled: busy,
            },
            h(RefreshIcon),
          ),
        );

        const balanceBlock = h(
          'div',
          { className: 'dbf-block' },
          h(
            'div',
            { className: 'dbf-balance-row' },
            h('div', { className: 'dbf-balance' }, '¥' + money(snapshot?.balance)),
            h(
              'button',
              {
                type: 'button',
                className: 'dbf-topup',
                title: t('topup.title'),
                onClick: () => window.open(TOPUP_URL, '_blank', 'noopener,noreferrer'),
              },
              t('topup'),
            ),
          ),
          h(
            'div',
            { className: 'dbf-sub' },
            typeof snapshot?.dayStart === 'number'
              ? t('balance.note', { start: '¥' + money(snapshot.dayStart), used: '¥' + money(snapshot.todayUsed) })
              : t('balance.noStart', { used: '¥' + money(snapshot?.todayUsed) }),
          ),
          h(
            'div',
            { className: 'dbf-row', style: { marginTop: '7px' } },
            h('span', { className: 'dbf-label' }, t('today')),
            h('span', { className: 'dbf-num' }, '¥' + money(snapshot?.todayUsed)),
          ),
          h(
            'div',
            { className: 'dbf-sub', style: { marginTop: '1px' } },
            t('today.calls', { count: snapshot?.todayCalls ?? 0, tokens: tokens(snapshot?.todayTokens ?? 0) }),
          ),
          h(
            'div',
            { className: 'dbf-sub', style: { marginTop: '1px' } },
            t('today.split', { peak: '¥' + money(snapshot?.todayPeakCost), valley: '¥' + money(snapshot?.todayValleyCost) }),
          ),
          h(
            'div',
            { className: 'dbf-row', style: { marginTop: '7px', paddingTop: '7px', borderTop: '.5px solid var(--dsw-alias-border-l1)' } },
            h('span', { className: 'dbf-label' }, t('turn')),
            h('span', { className: 'dbf-num' }, '¥' + money(turn?.cost)),
          ),
          h(
            'div',
            { className: 'dbf-sub', style: { marginTop: '1px' } },
            turn === null
              ? t('turn.empty')
              : t('turn.meta', { time: clock(turn.at), tokens: tokens(turn.tokens) }),
          ),
          stale ? h('div', { className: 'dbf-error', style: { marginTop: '4px' } }, t('error.stale')) : null,
        );

        const peakBlock = h(
          'div',
          { className: 'dbf-block' },
          h(
            'div',
            { className: 'dbf-row' },
            h('span', { className: 'dbf-row-title ' + periodClass }, dot, t('peak.now', { label: periodLabel })),
            h('span', { className: 'dbf-badge ' + periodClass }, periodLabel),
          ),
          h(
            'div',
            { className: 'dbf-sub dbf-countdown' },
            countdown !== ''
              ? t('peak.next', { label: peakActive ? t('valley') : t('peak.label'), time: countdown })
              : t('peak.noNext'),
          ),
          h(
            'div',
            { className: 'dbf-rules' },
            h(
              'div',
              { className: 'dbf-rule' },
              h('span', { className: 'dbf-rule-tag dbf-peak' }, t('rule.peak')),
              h('span', { className: 'dbf-rule-text' }, t('schedule.peak')),
            ),
            h(
              'div',
              { className: 'dbf-rule' },
              h('span', { className: 'dbf-rule-tag dbf-valley' }, t('rule.valley')),
              h('span', { className: 'dbf-rule-text' }, t('schedule.valley')),
            ),
          ),
        );

        const priceTable = h(
          'div',
          { className: 'dbf-block' },
          h(
            'div',
            { className: 'dbf-row-title' },
            t('prices'),
            h(
              'span',
              { className: 'dbf-sub', style: { marginLeft: '6px', fontWeight: 400 } },
              '(',
              h('span', { className: 'dbf-valley' }, t('prices.off')),
              ' / ',
              h('span', { className: 'dbf-peak' }, t('prices.peak')),
              ')',
            ),
          ),
          prices.length === 0
            ? null
            : h(
                'table',
                { className: 'dbf-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, ''),
                    h('th', null, t('price.hit')),
                    h('th', null, t('price.miss')),
                    h('th', null, t('price.out')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  prices.map((row) =>
                    h(
                      'tr',
                      { key: row.key },
                      h('td', null, modelLabel(row.model)),
                      h('td', null, pair(row.hit, peakActive)),
                      h('td', null, pair(row.miss, peakActive)),
                      h('td', null, pair(row.out, peakActive)),
                    ),
                  ),
                ),
              ),
          models.length > 0
            ? h(
                'div',
                { className: 'dbf-sub', style: { marginTop: '6px' } },
                models.map((row) => modelLabel(row.model) + ' ¥' + money(row.cost)).join(' · '),
              )
            : null,
        );

        const historyBlock = h(
          'div',
          { className: 'dbf-block' },
          h(
            'div',
            { className: 'dbf-row' },
            h('span', { className: 'dbf-row-title' }, t('history')),
            h('span', { className: 'dbf-sub' }, t('history.total', { total: '¥' + money(snapshot?.historyTotal) })),
          ),
          h(
            'div',
            { className: 'dbf-bars' },
            history.map((row) => {
              const value = typeof row.cost === 'number' ? row.cost : 0;
              const ratio = historyMax > 0 ? Math.max(2, Math.round((value / historyMax) * 38)) : 2;
              const isToday = typeof snapshot?.today === 'string' && row.day === snapshot.today;
              return h(
                'div',
                { key: row.day, className: 'dbf-bar' + (isToday ? ' is-today' : ''), title: row.day + ' ¥' + money(value) },
                h('div', { className: 'dbf-bar-fill', style: { height: ratio + 'px' } }),
                h('div', { className: 'dbf-bar-day' }, row.day.slice(5)),
              );
            }),
          ),
        );

        const footer = h(
          'div',
          { className: 'dbf-foot' },
          h('span', { className: 'dbf-foot-path', title: snapshot?.source?.path ?? '' }, t('source')),
          h('span', null, typeof snapshot?.source?.updatedAt === 'string' ? t('updated', { time: clock(Date.parse(snapshot.source.updatedAt)) }) : ''),
        );

        const body = [];
        if (failure !== '' && snapshot === null) {
          body.push(
            h(
              'div',
              { className: 'dbf-block' },
              h('div', { className: 'dbf-error' }, t('error.fetch') + ': ' + failure),
              h(
                'button',
                { type: 'button', className: 'dbf-icon', onClick: () => load(true), style: { width: 'auto', padding: '0 8px', marginTop: '6px' } },
                t('retry'),
              ),
            ),
          );
        } else if (snapshot !== null && snapshot.ok === false) {
          body.push(h('div', { className: 'dbf-block dbf-error' }, t('error.noLedger')));
        } else {
          body.push(balanceBlock, peakBlock, priceTable, historyBlock);
        }

        card = h(
          'div',
          { key: 'card', className: 'dbf-card dbf-surface' + (leaving ? ' dbf-leaving' : ''), style: cardStyle, role: 'dialog', 'aria-label': t('title') },
          header,
          h('div', { className: 'dbf-body' }, body),
          footer,
        );

      }

      let settingsPanel = null;
      if (settingsOpen || leaving) {
        const settingsRow = (key, label, value) =>
          h(
            'div',
            { className: 'dbf-setting' },
            h(
              'div',
              { className: 'dbf-row' },
              h('span', { className: 'dbf-label' }, label),
              h('span', { className: 'dbf-setting-val' }, value + '%'),
            ),
            h('input', {
              type: 'range',
              className: 'dbf-range',
              min: 0,
              max: key === 'bg' ? 90 : 100,
              step: 5,
              value,
              'aria-label': label,
              onChange: (event) => changeAppearance(key, Number(event.target.value)),
            }),
          );

        settingsPanel = h(
          'div',
          { key: 'settings', className: 'dbf-card dbf-surface' + (leaving ? ' dbf-leaving' : ''), style: cardStyle, role: 'dialog', 'aria-label': t('settings') },
          h('div', { className: 'dbf-head is-static' }, h('span', { className: 'dbf-head-title' }, t('settings'))),
          h(
            'div',
            { className: 'dbf-body' },
            settingsRow('bg', t('settings.bg'), appearance.bg),
            settingsRow('border', t('settings.border'), appearance.border),
            settingsRow('shadow', t('settings.shadow'), appearance.shadow),
            h(
              'div',
              { className: 'dbf-block', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('span', { className: 'dbf-sub', style: { marginTop: 0 } }, t('settings.hint')),
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
                h('button', { type: 'button', className: 'dbf-textbtn', onClick: () => setAppearance({ ...DEFAULT_APPEARANCE }) }, t('settings.reset')),
                h(
                  'button',
                  { type: 'button', className: 'dbf-textbtn', onClick: closeView },
                  t('settings.done'),
                ),
              ),
            ),
          ),
        );

      }
      const bubble =
        !open && !settingsOpen && flash && turn !== null
          ? h(
              'div',
              { key: 'bubble', className: 'dbf-bubble dbf-surface' + (bubbleUp ? ' is-up' : ''), 'aria-live': 'polite' },
              h('span', { className: 'dbf-bubble-caret', 'aria-hidden': true }),
              h('span', { className: 'dbf-bubble-label' }, t('turn.label')),
              h('span', { className: 'dbf-bubble-amount' }, '¥' + money(turn.cost)),
            )
          : null;

      const surface = settingsOpen ? settingsPanel : open ? card : pill;

      return h(
        'div',
        { ref: rootRef, className: 'dbf-root dbf-dir-' + dir, style: surfaceStyle },
        h('style', { key: 'css' }, STYLE),
        surface,
        bubble,
      );
    }

    // Only `t` is consumed from the slot props: skip the re-renders the shell
    // pushes on every streamed token while a session is running.
    const MemoBalanceFloat = React.memo(BalanceFloat, (prev, next) => prev.t === next.t);

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'balance-float: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'balance-float', order: 60, locale: NS }, (props) =>
          h(MemoBalanceFloat, { ...props, t }),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
