import { useEffect, useState } from "react";
import type { ParamSchema } from "../../types";

interface Props {
  schema: ParamSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

// A numeric field that keeps a local text buffer so floats can be typed by hand
// ("0.", "0.5", "-", ",") without the value being normalised away mid-edit, and
// that does NOT react to the mouse wheel (type="text" has no spinner). Commas are
// accepted as decimal separators.
function NumField({
  value,
  onChange,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  const ext = value === undefined || value === null ? "" : String(value);
  const [text, setText] = useState(ext);

  // Re-sync when the value is changed from outside (e.g. switching configs)
  // and no longer matches what is in the buffer.
  useEffect(() => {
    const buf = text.replace(",", ".");
    const cur =
      buf === "" || buf === "-" || buf === "." || buf === "-." ? null : Number(buf);
    if (cur !== (value ?? null)) setText(ext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      className="text-input sm num-input"
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        // allow only number-ish characters while typing
        if (raw !== "" && !/^-?\d*[.,]?\d*$/.test(raw)) return;
        setText(raw);
        const norm = raw.replace(",", ".");
        if (norm === "" || norm === "-" || norm === "." || norm === "-.") {
          onChange(null);
        } else {
          const n = Number(norm);
          if (!Number.isNaN(n)) onChange(n);
        }
      }}
    />
  );
}

export default function ParamControl({ schema, value, onChange }: Props) {
  const label = (
    <span className="param-name">
      {schema.name}
      {schema.required && <span className="req">*</span>}
    </span>
  );

  switch (schema.type) {
    case "bool":
      return (
        <label className="param param-bool">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      );

    case "int":
    case "float":
      return (
        <label className="param">
          {label}
          <NumField
            value={value as number | null | undefined}
            onChange={(v) => onChange(v)}
          />
        </label>
      );

    case "range": {
      const arr = Array.isArray(value) ? (value as number[]) : [undefined, undefined];
      return (
        <label className="param">
          {label}
          <span className="range-row">
            <NumField
              value={arr[0] as number | null | undefined}
              onChange={(v) => onChange([v, arr[1] ?? null])}
            />
            <span className="dash">—</span>
            <NumField
              value={arr[1] as number | null | undefined}
              onChange={(v) => onChange([arr[0] ?? null, v])}
            />
          </span>
        </label>
      );
    }

    case "string":
    case "optional":
      return (
        <label className="param">
          {label}
          <input
            className="text-input sm"
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          />
        </label>
      );

    case "json":
    default:
      return (
        <label className="param">
          {label}
          <input
            className="text-input sm"
            placeholder="JSON"
            value={value === undefined ? "" : JSON.stringify(value)}
            onChange={(e) => {
              try {
                onChange(e.target.value === "" ? null : JSON.parse(e.target.value));
              } catch {
                /* keep previous value until JSON is valid */
              }
            }}
          />
        </label>
      );
  }
}
