import type { ParamSchema } from "../../types";

interface Props {
  schema: ParamSchema;
  value: unknown;
  onChange: (value: unknown) => void;
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
          <input
            className="text-input sm"
            type="number"
            step={schema.type === "int" ? 1 : 0.05}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </label>
      );

    case "range": {
      const arr = Array.isArray(value) ? (value as number[]) : [undefined, undefined];
      const step = schema.int ? 1 : 0.05;
      return (
        <label className="param">
          {label}
          <span className="range-row">
            <input
              className="text-input sm"
              type="number"
              step={step}
              value={arr[0] ?? ""}
              onChange={(e) =>
                onChange([
                  e.target.value === "" ? null : Number(e.target.value),
                  arr[1] ?? null,
                ])
              }
            />
            <span className="dash">—</span>
            <input
              className="text-input sm"
              type="number"
              step={step}
              value={arr[1] ?? ""}
              onChange={(e) =>
                onChange([
                  arr[0] ?? null,
                  e.target.value === "" ? null : Number(e.target.value),
                ])
              }
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
