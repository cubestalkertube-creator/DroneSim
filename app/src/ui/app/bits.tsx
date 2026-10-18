// Small shared pieces of the menus.
import type { ComponentChildren } from 'preact';
import { back } from './store';

export const Stars = ({ n, of = 3 }: { n: number; of?: number }) => (
  <span class="stars">{'★'.repeat(n)}<i>{'★'.repeat(Math.max(0, of - n))}</i></span>
);

export const Bar = ({ v }: { v: number }) => <div class="bar"><i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></div>;

export const Stat = ({ label, v, value }: { label: string; v: number; value: string | number }) => (
  <div class="stat">{label}<Bar v={v} /><b>{value}</b></div>
);

export const BackBtn = ({ label = 'Назад', onClick = back }: { label?: string; onClick?: () => void }) => (
  <button class="backbtn" onClick={onClick}>← {label}</button>
);

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup">
      {options.map((o) => <button role="radio" aria-checked={o.id === value} class={o.id === value ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="chips">
      {options.map((o) => <button class={`chip${o.id === value ? ' on' : ''}`} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

export const Slider = ({ label, min, max, step, value, fmt, onInput, disabled }: {
  label: ComponentChildren; min: number; max: number; step: number; value: number; fmt?: (v: number) => string; onInput: (v: number) => void; disabled?: boolean;
}) => (
  <label class="sl">{label}
    <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onInput={(e) => onInput(+(e.target as HTMLInputElement).value)} />
    <b>{fmt ? fmt(value) : value}</b>
  </label>
);

export const Opt = ({ title, hint, children }: { title: ComponentChildren; hint?: ComponentChildren; children: ComponentChildren }) => (
  <div class="opt"><div>{title}{hint ? <small>{hint}</small> : null}</div>{children}</div>
);
