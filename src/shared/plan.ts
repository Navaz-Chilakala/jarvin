/** True when a plan-mode reply is a proper plan (a numbered or checkbox list), so the UI can offer "Approve". */
export function looksLikePlan(text: string): boolean {
  const items = text.match(/^\s*(?:\d+[.)]|[-*]\s*\[[ xX]\])\s+\S/gm);
  return (items?.length ?? 0) >= 2 && text.trim().length >= 60;
}
