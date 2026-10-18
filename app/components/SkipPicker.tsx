"use client";

import { useId, useState } from "react";

export type StepOption = { id: string; label: string; hint: string };

/**
 * One optional skip. A single checkbox turns skipping on; then the steps are listed and one is chosen.
 * Only one step can be skipped here, so choosing a step clears the others.
 */
export default function SkipPicker({
  steps,
  value,
  onChange,
}: {
  steps: StepOption[];
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
}) {
  const group = useId();
  const [skipping, setSkipping] = useState(() => steps.some((s) => value[s.id]));
  const selected = steps.find((s) => value[s.id])?.id ?? null;

  return (
    <div className="stack">
      <label className="row" style={{ gap: 10 }}>
        <input
          type="checkbox"
          checked={skipping}
          onChange={(e) => {
            setSkipping(e.target.checked);
            if (!e.target.checked) onChange(Object.fromEntries(steps.map((s) => [s.id, false])));
          }}
        />
        <span>Skip a step for this job</span>
      </label>
      {skipping && (
        <fieldset className="stack" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <legend className="muted" style={{ padding: 0, marginBottom: 6 }}>
            Which step do you want to skip?
          </legend>
          {steps.map((s) => (
            <label key={s.id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
              <input
                type="radio"
                name={group}
                checked={selected === s.id}
                onChange={() => onChange(Object.fromEntries(steps.map((x) => [x.id, x.id === s.id])))}
                style={{ marginTop: 4 }}
              />
              <span className="stack" style={{ gap: 2 }}>
                <span>{s.label}</span>
                <span className="muted" style={{ fontSize: "0.85em" }}>{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
