/** Success-rate band shown with both colour and a text label (colour is never the only signal). */
export function successBand(rate: number): { cls: string; label: string } {
  const ROBUST = 0.9;
  const BORDERLINE = 0.75;
  if (rate >= ROBUST) return { cls: 'robust', label: 'Robust ≥ 90%' };
  if (rate >= BORDERLINE) return { cls: 'borderline', label: 'Borderline 75–90%' };
  return { cls: 'at-risk', label: 'At risk < 75%' };
}
