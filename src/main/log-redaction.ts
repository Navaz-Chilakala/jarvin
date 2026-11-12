import { redactSecrets } from './sandbox';

const SECRET_FIELD = /^(?:password|passwd|secret|token|authorization|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|providerApiKey)$/i;

/** Best-effort redaction before persisting structured traces and audit events. */
export function redactLogValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return redactSecrets(item);
    if (item === null || typeof item !== 'object') return item;
    if (depth >= 20) return '[depth limit]';
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item)) {
      out[key] = SECRET_FIELD.test(key) ? '[REDACTED]' : visit(entry, depth + 1);
    }
    return out;
  };
  return visit(value, 0);
}
