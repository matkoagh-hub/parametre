import { useState, useMemo, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import { Menu, X, Check, Droplet, Thermometer, Gauge, Waves, Bell, BellOff, BellRing, Settings, Play, ChevronDown, ChevronUp } from "lucide-react";

// localStorage shim (Claude.ai uses window.storage, GitHub Pages doesn't)
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    get: async (k) => {
      const v = localStorage.getItem(k);
      return v != null ? { value: v } : null;
    },
    set: async (k, v) => { localStorage.setItem(k, v); return { value: v }; },
    delete: async (k) => { localStorage.removeItem(k); return { deleted: true }; },
  };
}

const DEFAULT_TANKS = {
  PG:   { name: "PG",   label: "Prevádzková nádrž",     vRef: 800,  hRef: 1350,  levelUnit: "cm" },
  HK:   { name: "HK",   label: "Havarijná nádrž",       vRef: 500,  hRef: 1000,  levelUnit: "cm" },
  NN:   { name: "NN",   label: "Núdzová nádrž",         vRef: 1000, hRef: 1200,  levelUnit: "cm" },
  SHNC: { name: "SHNČ", label: "Sk. havar. nádrž čerp.", vRef: 811,  hRef: 13.96, levelUnit: "m"  },
};

const TANK_ORDER = ["PG", "HK", "NN", "SHNC"];

const TANK_DEFAULT_INPUTS = {
  PG:   { trend: 0.59,   trendUnitIdx: 2, hStart: 1260, hEnd: 1340 },
  HK:   { trend: 0.5,    trendUnitIdx: 2, hStart: 800,  hEnd: 900  },
  NN:   { trend: 0.5,    trendUnitIdx: 2, hStart: 1000, hEnd: 1100 },
  SHNC: { trend: 0.0059, trendUnitIdx: 0, hStart: 11.5, hEnd: 13.0 },
};

const TANK_TREND_UNITS = [
  { label: "m/min",  toMperMin: 1 },
  { label: "m/h",    toMperMin: 1 / 60 },
  { label: "cm/min", toMperMin: 0.01 },
  { label: "cm/h",   toMperMin: 0.01 / 60 },
];

const QUANTITIES = {
  TEPLOTA: {
    name: "Teplota",
    valueUnits: [{ label: "°C", toCanonical: 1 }],
    trendUnits: [
      { label: "°C/min", toPerMin: 1 },
      { label: "°C/h",   toPerMin: 1 / 60 },
    ],
    defaults: { from: 20, to: 80, trend: 0.5, trendUnitIdx: 0, valueUnitIdx: 0 },
  },
  TLAK: {
    name: "Tlak",
    valueUnits: [
      { label: "bar", toCanonical: 1 },
      { label: "kPa", toCanonical: 0.01 },
      { label: "MPa", toCanonical: 10 },
      { label: "Pa",  toCanonical: 0.00001 },
    ],
    trendUnits: [
      { label: "bar/min", toPerMin: 1 },
      { label: "bar/h",   toPerMin: 1 / 60 },
      { label: "kPa/min", toPerMin: 0.01 },
      { label: "kPa/h",   toPerMin: 0.01 / 60 },
      { label: "MPa/min", toPerMin: 10 },
      { label: "MPa/h",   toPerMin: 10 / 60 },
      { label: "Pa/min",  toPerMin: 0.00001 },
      { label: "Pa/h",    toPerMin: 0.00001 / 60 },
    ],
    defaults: { from: 1.0, to: 2.5, trend: 0.05, trendUnitIdx: 0, valueUnitIdx: 0 },
  },
  HLADINA: {
    name: "Hladina",
    valueUnits: [
      { label: "m",  toCanonical: 1 },
      { label: "cm", toCanonical: 0.01 },
    ],
    trendUnits: [
      { label: "m/min",  toPerMin: 1 },
      { label: "m/h",    toPerMin: 1 / 60 },
      { label: "cm/min", toPerMin: 0.01 },
      { label: "cm/h",   toPerMin: 0.01 / 60 },
    ],
    defaults: { from: 12.6, to: 13.4, trend: 0.0059, trendUnitIdx: 0, valueUnitIdx: 0 },
  },
};

const QUANTITY_ORDER = ["TEPLOTA", "TLAK", "HLADINA"];
const QUANTITY_ICONS = { TEPLOTA: Thermometer, TLAK: Gauge, HLADINA: Waves };

let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration, volume, type = "sine", startOffset = 0) {
  const ctx = ensureAudio();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(ctx.destination);
  const t0 = ctx.currentTime + startOffset;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), t0 + 0.015);
  g.gain.setValueAtTime(Math.max(0.0001, volume), t0 + Math.max(0.02, duration - 0.05));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

const SOUND_PRESETS = {
  beep: {
    name: "Pípnutie (stále)",
    play: (duration, volume) => { playTone(880, duration, volume); },
  },
  triple: {
    name: "Trojité pípnutie",
    play: (duration, volume) => {
      const seg = duration / 3.5;
      const gap = seg / 2.5;
      playTone(880, seg, volume, "sine", 0);
      playTone(1100, seg, volume, "sine", seg + gap);
      playTone(1320, seg * 1.4, volume, "sine", 2 * (seg + gap));
    },
  },
  chime: {
    name: "Zvonček (uvoľnené)",
    play: (duration, volume) => {
      const notes = [1318.51, 1046.5, 783.99, 659.25];
      const seg = duration / notes.length;
      notes.forEach((f, i) => playTone(f, seg * 1.3, volume * 0.8, "sine", i * seg));
    },
  },
  siren: {
    name: "Siréna",
    play: (duration, volume) => {
      const ctx = ensureAudio();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sawtooth";
      osc.connect(g);
      g.connect(ctx.destination);
      const t0 = ctx.currentTime;
      g.gain.setValueAtTime(volume * 0.5, t0);
      const cycle = 1.0;
      const cycles = Math.max(1, Math.floor(duration / cycle));
      for (let i = 0; i < cycles; i++) {
        const s = t0 + i * cycle;
        osc.frequency.setValueAtTime(500, s);
        osc.frequency.linearRampToValueAtTime(1100, s + cycle / 2);
        osc.frequency.linearRampToValueAtTime(500, s + cycle);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.start(t0);
      osc.stop(t0 + duration + 0.05);
    },
  },
  alarmClock: {
    name: "Budík (rýchle pípanie)",
    play: (duration, volume) => {
      const beep = 0.08;
      const gap = 0.07;
      const pair = beep * 2 + gap * 3;
      const cycles = Math.floor(duration / pair);
      for (let i = 0; i < cycles; i++) {
        playTone(1200, beep, volume, "square", i * pair);
        playTone(1200, beep, volume, "square", i * pair + beep + gap);
      }
    },
  },
  pulses: {
    name: "Pomalé pulzy",
    play: (duration, volume) => {
      const pulse = 0.3;
      const gap = 0.4;
      const total = pulse + gap;
      const cycles = Math.floor(duration / total);
      for (let i = 0; i < cycles; i++) {
        playTone(660, pulse, volume, "sine", i * total);
      }
    },
  },
};

const SOUND_KEYS = Object.keys(SOUND_PRESETS);
const DEFAULT_SOUND_SETTINGS = { sound: "triple", duration: 3, volume: 0.3 };

function playSound(settings) {
  const preset = SOUND_PRESETS[settings.sound] || SOUND_PRESETS.triple;
  preset.play(settings.duration, settings.volume);
}

function Field({ label, value, onChange, step = "any", suffix, children }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600 font-medium">{label}</span>
      <div className="flex items-stretch mt-1">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full px-3 py-2 border border-slate-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
        />
        {children ? children : (
          <span className="px-3 py-2 bg-slate-100 border border-l-0 border-slate-300 rounded-r-md text-sm text-slate-600 min-w-[70px] text-center">{suffix}</span>
        )}
      </div>
    </label>
  );
}

function Stat({ label, value, unit, big }) {
  return (
    <div className={`p-3 rounded-lg ${big ? "bg-blue-50 border border-blue-200" : "bg-slate-50"}`}>
      <div className="text-xs text-slate-600">{label}</div>
      <div className={`font-semibold ${big ? "text-blue-900 text-lg" : "text-slate-900"}`}>
        {value} <span className="text-xs font-normal text-slate-500">{unit}</span>
      </div>
    </div>
  );
}

const fmtHM = (min) => {
  if (!isFinite(min)) return "—";
  const neg = min < 0;
  const total = Math.round(Math.abs(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${neg ? "−" : ""}${h}:${String(m).padStart(2, "0")}`;
};

const fmtDate = (d) =>
  d.toLocaleString("sk-SK", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const fmt = (n, d = 3) => (isFinite(n) ? n.toLocaleString("sk-SK", { maximumFractionDigits: d }) : "—");

function SoundSettingsPanel({ settings, onChange }) {
  const [open, setOpen] = useState(false);
  const set = (patch) => onChange({ ...settings, ...patch });
  return (
    <div className="border-t border-slate-700">
      <button onClick={() => setOpen((o) => !o)} className="w-full px-4 py-3 flex items-center justify-between text-slate-300 hover:bg-slate-800 transition-colors">
        <span className="flex items-center gap-2 text-xs uppercase tracking-wider"><Settings size={13} /> Nastavenia zvuku</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div>
            <label className="text-[11px] text-slate-400 block mb-1">Typ zvuku</label>
            <select value={settings.sound} onChange={(e) => set({ sound: e.target.value })} className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-slate-100">
              {SOUND_KEYS.map((k) => (<option key={k} value={k}>{SOUND_PRESETS[k].name}</option>))}
            </select>
          </div>
          <div>
            <label className="text-[11px] text-slate-400 block mb-1">Dĺžka: <span className="text-slate-200">{settings.duration.toFixed(1)} s</span></label>
            <input type="range" min="0.5" max="20" step="0.5" value={settings.duration} onChange={(e) => set({ duration: parseFloat(e.target.value) })} className="w-full" />
            <div className="flex justify-between text-[10px] text-slate-500"><span>0,5 s</span><span>20 s</span></div>
          </div>
          <div>
            <label className="text-[11px] text-slate-400 block mb-1">Hlasitosť: <span className="text-slate-200">{Math.round(settings.volume * 100)} %</span></label>
            <input type="range" min="0.02" max="1" step="0.02" value={settings.volume} onChange={(e) => set({ volume: parseFloat(e.target.value) })} className="w-full" />
          </div>
          <button onClick={() => playSound(settings)} className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs flex items-center justify-center gap-1.5"><Play size={12} /> Vyskúšať zvuk</button>
        </div>
      )}
    </div>
  );
}

function Sidebar({ tanks, selected, setSelected, onClose, alarms, soundSettings, setSoundSettings }) {
  return (
    <aside className="w-64 bg-slate-900 text-slate-100 flex-shrink-0 flex flex-col h-screen sticky top-0">
      <div className="p-4 border-b border-slate-700 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400">Výber</div>
          <div className="text-sm font-medium">Nádrže a veličiny</div>
        </div>
        <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-white"><X size={20} /></button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1"><Droplet size={11} /> Nádrže</div>
        {TANK_ORDER.map((key) => {
          const t = tanks[key];
          const a = alarms[key];
          return (
            <button key={key} onClick={() => { setSelected(key); onClose(); }} className={`w-full text-left px-3 py-2 mb-1 rounded-md transition-colors ${selected === key ? "bg-blue-600 text-white" : "hover:bg-slate-800 text-slate-300"}`}>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-sm">{t.name}</span>
                {a && !a.fired && <Bell size={11} className="text-amber-400" />}
                {a && a.fired && <BellRing size={11} className="text-red-400 animate-pulse" />}
              </div>
              <div className="text-xs opacity-75">{t.label}</div>
              <div className="text-xs opacity-60 mt-0.5">{t.vRef} m³ @ {t.hRef} {t.levelUnit}</div>
            </button>
          );
        })}
        <div className="px-2 pt-4 pb-1 text-[10px] uppercase tracking-wider text-slate-500">Univerzálny výpočet času</div>
        {QUANTITY_ORDER.map((key) => {
          const q = QUANTITIES[key];
          const Icon = QUANTITY_ICONS[key];
          const a = alarms[key];
          return (
            <button key={key} onClick={() => { setSelected(key); onClose(); }} className={`w-full text-left px-3 py-2 mb-1 rounded-md transition-colors flex items-center gap-2 ${selected === key ? "bg-blue-600 text-white" : "hover:bg-slate-800 text-slate-300"}`}>
              <Icon size={16} className="opacity-80" />
              <div className="flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm">{q.name}</span>
                  {a && !a.fired && <Bell size={11} className="text-amber-400" />}
                  {a && a.fired && <BellRing size={11} className="text-red-400 animate-pulse" />}
                </div>
                <div className="text-xs opacity-60">z trendu</div>
              </div>
            </button>
          );
        })}
      </nav>
      <SoundSettingsPanel settings={soundSettings} onChange={setSoundSettings} />
    </aside>
  );
}

function AlarmBar({ alarm, t_min, valueLabel, onSet, onCancel, onAck }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (alarm && alarm.fired) {
    return (
      <div className="bg-red-50 border border-red-300 rounded-lg p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-red-800">
          <BellRing size={18} className="animate-pulse" />
          <div className="text-sm font-semibold">Cieľ dosiahnutý — {alarm.label} {valueLabel ? `(${alarm.targetValue} ${valueLabel})` : ""}</div>
        </div>
        <button onClick={onAck} className="px-3 py-1 text-xs rounded-md bg-red-600 text-white hover:bg-red-700">OK</button>
      </div>
    );
  }
  if (alarm && !alarm.fired) {
    const remainMin = (alarm.dueAt - Date.now()) / 60000;
    return (
      <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-amber-900">
          <Bell size={18} />
          <div className="text-sm">
            <div className="font-semibold">Upozornenie nastavené</div>
            <div className="text-xs opacity-80">Δt: {fmtHM(remainMin)} &nbsp;•&nbsp; o {fmtDate(new Date(alarm.dueAt))}</div>
          </div>
        </div>
        <button onClick={onCancel} className="px-3 py-1 text-xs rounded-md bg-white border border-amber-400 text-amber-800 hover:bg-amber-100 flex items-center gap-1"><BellOff size={12} /> Zrušiť</button>
      </div>
    );
  }
  const disabled = !isFinite(t_min) || t_min <= 0;
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-slate-700">
        <Bell size={18} />
        <div className="text-sm">
          <div className="font-medium">Upozornenie pri dosiahnutí cieľa</div>
          <div className="text-xs text-slate-500">Karta musí byť otvorená. Zvuk nastavíš v bočnom paneli.</div>
        </div>
      </div>
      <button onClick={onSet} disabled={disabled} className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed">Nastaviť</button>
    </div>
  );
}

function TankCalc({ tank, onUpdateTank, onSave, saveFlash, tankInput, setTankInput, alarm, onSetAlarm, onCancelAlarm, onAckAlarm }) {
  const { trend, trendUnitIdx, hStart, hEnd } = tankInput;
  const set = (patch) => setTankInput({ ...tankInput, ...patch });
  const lvlUnit = tank.levelUnit;
  const lvlToM = lvlUnit === "cm" ? 0.01 : 1;
  const trendUnit = TANK_TREND_UNITS[trendUnitIdx] || TANK_TREND_UNITS[0];
  const trendMpMin = trend * trendUnit.toMperMin;
  const trendInLvlPerMin = trendMpMin / lvlToM;

  const r = useMemo(() => {
    const hRef_m = tank.hRef * lvlToM;
    const hStart_m = hStart * lvlToM;
    const hEnd_m = hEnd * lvlToM;
    const A = hRef_m > 0 ? tank.vRef / hRef_m : 0;
    const dh_m = hEnd_m - hStart_m;
    const Q_m3_min = A * trendMpMin;
    const Q_m3_h = Q_m3_min * 60;
    const Q_ls = (Q_m3_min * 1000) / 60;
    const t_min = trendMpMin !== 0 ? dh_m / trendMpMin : 0;
    const dV = A * dh_m;
    const V_start = A * hStart_m;
    const V_end = A * hEnd_m;
    const finish = new Date(Date.now() + t_min * 60_000);
    return { A, dh_lvl: hEnd - hStart, Q_m3_min, Q_m3_h, Q_ls, t_min, dV, V_start, V_end, finish };
  }, [tank.vRef, tank.hRef, hStart, hEnd, trendMpMin, lvlToM]);

  const chartData = useMemo(() => {
    const pts = [];
    const steps = 30;
    for (let i = 0; i <= steps; i++) {
      const t = (r.t_min * i) / steps;
      pts.push({ t: +t.toFixed(2), h: +(hStart + trendInLvlPerMin * t).toFixed(4) });
    }
    return pts;
  }, [r.t_min, hStart, trendInLvlPerMin]);

  const TankTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    const wall = new Date(Date.now() + p.t * 60_000);
    return (
      <div className="bg-white border border-slate-300 rounded-md shadow-md px-3 py-2 text-xs">
        <div className="font-semibold text-slate-800">{fmt(p.h, 3)} {lvlUnit}</div>
        <div className="text-slate-600 mt-0.5">Δt: <strong>{fmtHM(p.t)}</strong></div>
        <div className="text-slate-600">čas: <strong>{fmtDate(wall)}</strong></div>
      </div>
    );
  };

  const toggleLevelUnit = (newUnit) => {
    if (newUnit === lvlUnit) return;
    const ratio = newUnit === "cm" ? 100 : 0.01;
    onUpdateTank({ levelUnit: newUnit, hRef: +(tank.hRef * ratio).toFixed(6) });
    setTankInput({ ...tankInput, hStart: +(hStart * ratio).toFixed(6), hEnd: +(hEnd * ratio).toFixed(6) });
  };

  const handleSetAlarm = () => {
    onSetAlarm({
      dueAt: Date.now() + r.t_min * 60_000,
      label: `${tank.name} — cieľová hladina`,
      targetValue: hEnd,
      targetUnit: lvlUnit,
    });
  };

  return (
    <>
      <div className="mt-5">
        <AlarmBar alarm={alarm} t_min={r.t_min} valueLabel={lvlUnit} onSet={handleSetAlarm} onCancel={onCancelAlarm} onAck={onAckAlarm} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-5">
        <div className="bg-white rounded-xl shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between border-b pb-2">
            <h2 className="font-semibold text-slate-800">Vstupy</h2>
            <div className="flex gap-1">
              {["m", "cm"].map((u) => (
                <button key={u} onClick={() => toggleLevelUnit(u)} className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${u === lvlUnit ? "bg-blue-600 text-white border-blue-600" : "bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100"}`}>{u}</button>
              ))}
            </div>
          </div>
          <Field label="Trend hladiny" value={trend} onChange={(v) => set({ trend: v })}>
            <select value={trendUnitIdx} onChange={(e) => set({ trendUnitIdx: parseInt(e.target.value, 10) })} className="px-2 py-2 bg-slate-100 border border-l-0 border-slate-300 rounded-r-md text-sm text-slate-700 min-w-[100px]">
              {TANK_TREND_UNITS.map((u, i) => (<option key={u.label} value={i}>{u.label}</option>))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Začiatočná hladina" value={hStart} onChange={(v) => set({ hStart: v })} suffix={lvlUnit} />
            <Field label="Cieľová hladina"    value={hEnd}   onChange={(v) => set({ hEnd:   v })} suffix={lvlUnit} />
          </div>
          <div className="pt-2 border-t">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-slate-500">Geometria nádrže {tank.name}</div>
              <button onClick={onSave} className={`text-xs px-2 py-1 rounded-md flex items-center gap-1 transition-colors ${saveFlash ? "bg-green-100 text-green-700" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}>
                {saveFlash ? <Check size={12} /> : null}
                {saveFlash ? "Uložené" : "Uložiť"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Referenčný objem" value={tank.vRef} onChange={(v) => onUpdateTank({ vRef: v })} suffix="m³" />
              <Field label="pri hladine"      value={tank.hRef} onChange={(v) => onUpdateTank({ hRef: v })} suffix={lvlUnit} />
            </div>
            <div className="mt-2 text-xs text-slate-500">Prierez A = V / h = <strong>{fmt(r.A, 3)} m²</strong></div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 border-b pb-2">Výsledky</h2>
          <Stat label="Δt do cieľovej hladiny (h:m)" value={fmtHM(r.t_min)} unit="" big />
          <Stat label="Čas dosiahnutia" value={fmtDate(r.finish)} unit="" />
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Prietok" value={fmt(r.Q_m3_min, 4)} unit="m³/min" />
            <Stat label="Prietok" value={fmt(r.Q_m3_h, 2)}   unit="m³/h" />
            <Stat label="Prietok" value={fmt(r.Q_ls, 3)}     unit="l/s" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Δ hladina" value={fmt(r.dh_lvl, 3)} unit={lvlUnit} />
            <Stat label="Δ objem"   value={fmt(r.dV, 2)} unit="m³" />
            <Stat label="Trend"     value={fmt(trendInLvlPerMin, 5)} unit={`${lvlUnit}/min`} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Objem pri začiatku" value={fmt(r.V_start, 2)} unit="m³" />
            <Stat label="Objem pri cieli"    value={fmt(r.V_end, 2)}   unit="m³" />
          </div>
        </div>
      </div>
      <div className="mt-6 bg-white rounded-xl shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-2 mb-3">
          <h2 className="font-semibold text-slate-800">Priebeh hladiny v čase</h2>
          <div className="text-xs text-slate-500">Prejdi prstom / myšou cez graf — odčítaš hladinu a čas</div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="t" label={{ value: "Δt (min)", position: "insideBottom", offset: -10, fontSize: 12 }} tick={{ fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} label={{ value: `hladina (${lvlUnit})`, angle: -90, position: "insideLeft", fontSize: 12 }} tick={{ fontSize: 11 }} />
              <Tooltip content={<TankTooltip />} />
              <ReferenceLine y={hEnd} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "cieľ", fontSize: 11, fill: "#ef4444" }} />
              <Line type="monotone" dataKey="h" stroke="#2563eb" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

function GenericCalc({ quantityKey, state, setState, alarm, onSetAlarm, onCancelAlarm, onAckAlarm }) {
  const q = QUANTITIES[quantityKey];
  const s = state[quantityKey];
  const set = (patch) => setState({ ...state, [quantityKey]: { ...s, ...patch } });
  const valueUnit = q.valueUnits[s.valueUnitIdx] || q.valueUnits[0];
  const valueUnitLabel = valueUnit.label;
  const trendUnit = q.trendUnits[s.trendUnitIdx] || q.trendUnits[0];
  const trendPerMinCanonical = s.trend * trendUnit.toPerMin;
  const fromCanonical = s.from * valueUnit.toCanonical;
  const toCanonical = s.to * valueUnit.toCanonical;
  const deltaCanonical = toCanonical - fromCanonical;
  const t_min = trendPerMinCanonical !== 0 ? deltaCanonical / trendPerMinCanonical : Infinity;
  const finish = new Date(Date.now() + (isFinite(t_min) ? t_min : 0) * 60_000);
  const trendInDisplayPerMin = trendPerMinCanonical / valueUnit.toCanonical;
  const deltaDisplay = s.to - s.from;
  const readVal = s.readVal ?? (s.from + (s.to - s.from) / 2);
  const readTime = trendInDisplayPerMin !== 0 ? (readVal - s.from) / trendInDisplayPerMin : Infinity;
  const readFinish = new Date(Date.now() + (isFinite(readTime) ? readTime : 0) * 60_000);

  const changeValueUnit = (newIdx) => {
    if (newIdx === s.valueUnitIdx) return;
    const oldU = q.valueUnits[s.valueUnitIdx];
    const newU = q.valueUnits[newIdx];
    const ratio = oldU.toCanonical / newU.toCanonical;
    set({
      valueUnitIdx: newIdx,
      from: +(s.from * ratio).toFixed(6),
      to:   +(s.to   * ratio).toFixed(6),
      readVal: s.readVal != null ? +(s.readVal * ratio).toFixed(6) : null,
    });
  };

  const chartData = useMemo(() => {
    const pts = [];
    const steps = 40;
    const span = isFinite(t_min) ? t_min : 0;
    for (let i = 0; i <= steps; i++) {
      const t = (span * i) / steps;
      pts.push({ t: +t.toFixed(3), v: +(s.from + trendInDisplayPerMin * t).toFixed(4) });
    }
    return pts;
  }, [t_min, s.from, trendInDisplayPerMin]);

  const ChartTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    const wall = new Date(Date.now() + p.t * 60_000);
    return (
      <div className="bg-white border border-slate-300 rounded-md shadow-md px-3 py-2 text-xs">
        <div className="font-semibold text-slate-800">{fmt(p.v, 3)} {valueUnitLabel}</div>
        <div className="text-slate-600 mt-0.5">Δt: <strong>{fmtHM(p.t)}</strong></div>
        <div className="text-slate-600">čas: <strong>{fmtDate(wall)}</strong></div>
      </div>
    );
  };

  const hasValueUnitChoice = q.valueUnits.length > 1;
  const handleSetAlarm = () => {
    onSetAlarm({
      dueAt: Date.now() + t_min * 60_000,
      label: `${q.name} — cieľová hodnota`,
      targetValue: s.to,
      targetUnit: valueUnitLabel,
    });
  };

  return (
    <>
      <div className="mt-5">
        <AlarmBar alarm={alarm} t_min={t_min} valueLabel={valueUnitLabel} onSet={handleSetAlarm} onCancel={onCancelAlarm} onAck={onAckAlarm} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-5">
        <div className="bg-white rounded-xl shadow-sm p-5 space-y-4">
          <h2 className="font-semibold text-slate-800 border-b pb-2">Vstupy — {q.name}</h2>
          {hasValueUnitChoice && (
            <div>
              <span className="text-xs text-slate-600 font-medium">Jednotka hodnoty</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {q.valueUnits.map((u, i) => (
                  <button key={u.label} onClick={() => changeValueUnit(i)} className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${i === s.valueUnitIdx ? "bg-blue-600 text-white border-blue-600" : "bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100"}`}>{u.label}</button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Aktuálna hodnota" value={s.from} onChange={(v) => set({ from: v })} suffix={valueUnitLabel} />
            <Field label="Cieľová hodnota"  value={s.to}   onChange={(v) => set({ to:   v })} suffix={valueUnitLabel} />
          </div>
          <Field label="Trend (rýchlosť zmeny)" value={s.trend} onChange={(v) => set({ trend: v })}>
            <select value={s.trendUnitIdx} onChange={(e) => set({ trendUnitIdx: parseInt(e.target.value, 10) })} className="px-2 py-2 bg-slate-100 border border-l-0 border-slate-300 rounded-r-md text-sm text-slate-700 min-w-[100px]">
              {q.trendUnits.map((u, i) => (<option key={u.label} value={i}>{u.label}</option>))}
            </select>
          </Field>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 border-b pb-2">Výsledky</h2>
          <Stat label="Δt do cieľa (h:m)" value={fmtHM(t_min)} unit="" big />
          <Stat label="Čas dosiahnutia cieľa" value={isFinite(t_min) ? fmtDate(finish) : "—"} unit="" />
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Δ hodnota" value={fmt(deltaDisplay, 4)} unit={valueUnitLabel} />
            <Stat label="Trend (prepočítaný)" value={fmt(trendInDisplayPerMin, 6)} unit={`${valueUnitLabel}/min`} />
          </div>
        </div>
      </div>
      <div className="mt-6 bg-white rounded-xl shadow-sm p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-2 mb-3">
          <h2 className="font-semibold text-slate-800">Priebeh {q.name.toLowerCase()} v čase</h2>
          <div className="text-xs text-slate-500">Prejdi prstom / myšou cez graf — odčítaš hodnotu a čas</div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="t" label={{ value: "Δt (min)", position: "insideBottom", offset: -10, fontSize: 12 }} tick={{ fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} label={{ value: `${q.name} (${valueUnitLabel})`, angle: -90, position: "insideLeft", fontSize: 12 }} tick={{ fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={s.to} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "cieľ", fontSize: 11, fill: "#ef4444" }} />
              <ReferenceLine y={readVal} stroke="#10b981" strokeDasharray="2 2" />
              <Line type="monotone" dataKey="v" stroke="#2563eb" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 pt-4 border-t">
          <div className="text-xs text-slate-500 mb-2">Odčítať pri konkrétnej hodnote</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Hodnota" value={readVal} onChange={(v) => set({ readVal: v })} suffix={valueUnitLabel} />
            <Stat label="Δt (h:m)" value={fmtHM(readTime)} unit="" />
            <Stat label="Dosiahne sa" value={isFinite(readTime) ? fmtDate(readFinish) : "—"} unit="" />
          </div>
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [tanks, setTanks] = useState(DEFAULT_TANKS);
  const [tankInputs, setTankInputs] = useState(TANK_DEFAULT_INPUTS);
  const [selected, setSelected] = useState("PG");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const [genericState, setGenericState] = useState(() => {
    const s = {};
    for (const k of QUANTITY_ORDER) s[k] = { ...QUANTITIES[k].defaults };
    return s;
  });
  const [alarms, setAlarms] = useState({});
  const [soundSettings, setSoundSettings] = useState(DEFAULT_SOUND_SETTINGS);
  const soundSettingsRef = useRef(soundSettings);
  useEffect(() => { soundSettingsRef.current = soundSettings; }, [soundSettings]);
  const timersRef = useRef({});

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("tanks");
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          const merged = { ...DEFAULT_TANKS };
          for (const k of Object.keys(parsed)) {
            merged[k] = { ...DEFAULT_TANKS[k], ...parsed[k] };
          }
          setTanks(merged);
        }
      } catch (e) {}
      try {
        const res = await window.storage.get("soundSettings");
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setSoundSettings({ ...DEFAULT_SOUND_SETTINGS, ...parsed });
        }
      } catch (e) {}
    })();
    return () => { Object.values(timersRef.current).forEach((id) => clearTimeout(id)); };
  }, []);

  useEffect(() => {
    const id = setTimeout(() => { window.storage.set("soundSettings", JSON.stringify(soundSettings)).catch(() => {}); }, 300);
    return () => clearTimeout(id);
  }, [soundSettings]);

  const fireAlarm = (key, payload) => {
    playSound(soundSettingsRef.current);
    setAlarms((prev) => ({ ...prev, [key]: { ...payload, fired: true } }));
  };

  const setAlarm = (key, payload) => {
    if (timersRef.current[key]) clearTimeout(timersRef.current[key]);
    const ms = payload.dueAt - Date.now();
    if (ms <= 0) { fireAlarm(key, payload); return; }
    timersRef.current[key] = setTimeout(() => fireAlarm(key, payload), ms);
    setAlarms((prev) => ({ ...prev, [key]: { ...payload, fired: false } }));
  };

  const cancelAlarm = (key) => {
    if (timersRef.current[key]) { clearTimeout(timersRef.current[key]); delete timersRef.current[key]; }
    setAlarms((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };
  const ackAlarm = (key) => cancelAlarm(key);

  const isTank = TANK_ORDER.includes(selected);
  const isQuantity = QUANTITY_ORDER.includes(selected);
  const updateTank = (patch) => { setTanks((prev) => ({ ...prev, [selected]: { ...prev[selected], ...patch } })); };
  const setTankInput = (newState) => { setTankInputs((prev) => ({ ...prev, [selected]: newState })); };
  const saveTanks = async () => {
    try {
      await window.storage.set("tanks", JSON.stringify(tanks));
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 1500);
    } catch (e) {}
  };

  let headerTitle = "";
  let headerSub = "";
  if (isTank) { headerTitle = `Plnenie nádrže — ${tanks[selected].name}`; headerSub = tanks[selected].label; }
  else if (isQuantity) { const q = QUANTITIES[selected]; headerTitle = `${q.name} — výpočet času`; headerSub = "Iba z trendu, bez ďalších konštánt"; }

  return (
    <div className="min-h-screen bg-slate-100 flex">
      <div className="hidden lg:block">
        <Sidebar tanks={tanks} selected={selected} setSelected={setSelected} onClose={() => setSidebarOpen(false)} alarms={alarms} soundSettings={soundSettings} setSoundSettings={setSoundSettings} />
      </div>
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="fixed inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className="relative z-50">
            <Sidebar tanks={tanks} selected={selected} setSelected={setSelected} onClose={() => setSidebarOpen(false)} alarms={alarms} soundSettings={soundSettings} setSoundSettings={setSoundSettings} />
          </div>
        </div>
      )}
      <main className="flex-1 p-4 sm:p-6 min-w-0">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-1">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 -ml-2 text-slate-700 hover:bg-slate-200 rounded-md"><Menu size={22} /></button>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{headerTitle}</h1>
              <p className="text-sm text-slate-600">{headerSub}</p>
            </div>
          </div>
          {isTank && (
            <TankCalc tank={tanks[selected]} onUpdateTank={updateTank} onSave={saveTanks} saveFlash={saveFlash} tankInput={tankInputs[selected]} setTankInput={setTankInput} alarm={alarms[selected]} onSetAlarm={(payload) => setAlarm(selected, payload)} onCancelAlarm={() => cancelAlarm(selected)} onAckAlarm={() => ackAlarm(selected)} />
          )}
          {isQuantity && (
            <GenericCalc quantityKey={selected} state={genericState} setState={setGenericState} alarm={alarms[selected]} onSetAlarm={(payload) => setAlarm(selected, payload)} onCancelAlarm={() => cancelAlarm(selected)} onAckAlarm={() => ackAlarm(selected)} />
          )}
        </div>
      </main>
    </div>
  );
}
