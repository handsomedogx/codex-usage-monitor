import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";

type Price = { input: number; cachedInput: number; output: number };
type Row = { id: number; model: string; input: string; cachedInput: string; output: string };
type Configuration = { prices: Record<string, Price>; defaults: Record<string, Price>; path: string };
let nextRowId = 0;

function rowsFrom(prices: Record<string, Price>): Row[] {
  return Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)).map(([model, price]) => ({
    id: nextRowId++, model, input: String(price.input), cachedInput: String(price.cachedInput), output: String(price.output),
  }));
}

export function PricingDialog({ language, models, onCancel, onSaved }: {
  language: "zh" | "en"; models: string[]; onCancel: () => void; onSaved: () => void;
}) {
  const zh = language === "zh";
  const [rows, setRows] = useState<Row[]>([]);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void invoke<Configuration>("get_model_prices").then((result) => {
      if (!active) return;
      setConfig(result);
      const known = rowsFrom(result.prices);
      const missing = [...new Set(models)].filter((model) => model !== "unknown" && !(model in result.prices));
      setRows([...missing.map((model) => ({ id: nextRowId++, model, input: "", cachedInput: "", output: "" })), ...known]);
    }).catch((cause) => { if (active) setError(String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [models]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);

  const update = (id: number, key: keyof Omit<Row, "id">, value: string) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, [key]: value } : row));
    setError("");
  };

  const save = async () => {
    const prices: Record<string, Price> = Object.create(null);
    for (const row of rows) {
      const model = row.model.trim().toLowerCase().split("/").pop()!.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
      if (!model || model === "unknown" || Object.prototype.hasOwnProperty.call(prices, model)) {
        setError(zh ? "模型名称不能为空、unknown 或重复（日期后缀和提供商前缀会自动移除）。" : "Model names must be nonempty, unique and not unknown; provider prefixes and date suffixes are removed.");
        return;
      }
      const values = [row.input, row.cachedInput, row.output];
      if (values.some((value) => !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) {
        setError(zh ? `请为 ${model} 填写三个非负价格；免费项请填 0。` : `Enter three non-negative prices for ${model}; use 0 for free tokens.`);
        return;
      }
      prices[model] = { input: Number(row.input), cachedInput: Number(row.cachedInput), output: Number(row.output) };
    }
    setSaving(true);
    setError("");
    try {
      await invoke("save_model_prices", { prices });
      onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop">
    <div className="date-dialog pricing-dialog" role="dialog" aria-modal="true" aria-labelledby="pricing-title" tabIndex={-1} ref={dialog}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) onCancel();
        if (event.key !== "Tab") return;
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}>
      <div className="dialog-header">
        <h2 id="pricing-title">{zh ? "模型价格配置" : "Model pricing"}</h2>
        <button className="button button-ghost" onClick={onCancel} disabled={saving} aria-label={zh ? "关闭" : "Close"}><X size={16} /></button>
      </div>
      <p className="pricing-note">{zh ? "单位：美元 / 百万 Tokens。输入价格用于非缓存输入；第三方费用仍为同名模型的参考折算。" : "USD per million tokens. Input rates apply to uncached input; custom providers use these rates as a reference."}</p>
      <p className="pricing-note">{zh ? "未定价模型已列在前面，请填写价格或删除该行以保持未定价。" : "Unpriced models appear first. Enter prices or remove their rows to leave them unpriced."}</p>
      {config && <p className="pricing-path" title={config.path}>{config.path}</p>}
      {loading ? <p>{zh ? "正在加载…" : "Loading…"}</p> : <>
        <fieldset className="pricing-fields" disabled={saving || !config}>
          <div className="pricing-table-scroll"><table className="pricing-table">
            <thead><tr><th>{zh ? "模型名称" : "Model"}</th><th>{zh ? "输入" : "Input"}</th><th>{zh ? "缓存输入" : "Cached input"}</th><th>{zh ? "输出" : "Output"}</th><th>{zh ? "操作" : "Actions"}</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.id}>
              <td><input aria-label={zh ? "模型名称" : "Model name"} value={row.model} onChange={(event) => update(row.id, "model", event.target.value)} placeholder="model-id" /></td>
              {(["input", "cachedInput", "output"] as const).map((key) => <td key={key}><input type="number" min="0" step="any" aria-label={`${row.model} ${key}`} value={row[key]} onChange={(event) => update(row.id, key, event.target.value)} /></td>)}
              <td><button className="button button-ghost" onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} aria-label={`${zh ? "删除" : "Remove"} ${row.model}`}><Trash2 size={14} /></button></td>
            </tr>)}</tbody>
          </table></div>
          <div className="pricing-tools">
            <button className="button button-secondary" onClick={() => setRows((current) => [{ id: nextRowId++, model: "", input: "", cachedInput: "", output: "" }, ...current])}><Plus size={14} />{zh ? "添加模型" : "Add model"}</button>
            <button className="button button-ghost" onClick={() => { if (config) setRows(rowsFrom(config.defaults)); setError(""); }}>{zh ? "恢复默认价格" : "Restore defaults"}</button>
          </div>
        </fieldset>
      </>}
      {error && <p className="validation" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button button-secondary" onClick={onCancel} disabled={saving}>{zh ? "取消" : "Cancel"}</button>
        <button className="button button-primary" onClick={() => void save()} disabled={loading || saving || !config}>{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存并重新计算" : "Save and recalculate")}</button>
      </div>
    </div>
  </div>;
}
