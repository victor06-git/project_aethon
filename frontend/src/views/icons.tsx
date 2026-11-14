// One icon set, one style: 24×24 outline, 1.8 stroke, round caps. Colour comes from currentColor.
// Path data is static and trusted, so it is inlined as SVG markup.
const P: Record<string, string> = {
  home: '<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M5.5 9v10.5h13V9"/><path d="M10 19.5v-5h4v5"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
  pay: '<path d="M4 8h13"/><path d="m14 4.5 3.5 3.5-3.5 3.5"/><path d="M20 16H7"/><path d="m10 12.5-3.5 3.5 3.5 3.5"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5"/><path d="M4.5 20h15"/><path d="M6.5 10.5v7M10 10.5v7M14 10.5v7M17.5 10.5v7"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5"/>',
  message: '<path d="M4 5.5h16v10.5H9.5L5 19.5V16H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m15.5 15.5 4.5 4.5"/>',
  back: '<path d="m14.5 5-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  accounts: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/><path d="M15 14.5h2.5"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v3.5h3.5"/><path d="M12 8v4.5l3 2"/>',
  invest: '<path d="M4 19.5h16"/><path d="m5 15 4.5-4.5 3.5 3 6-6.5"/><path d="M15 7h4v4"/>',
  saver: '<ellipse cx="12" cy="6.5" rx="6.5" ry="2.5"/><path d="M5.5 6.5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5"/><path d="M5.5 11.5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5"/>',
  loan: '<path d="M4 11 12 5l8 6"/><path d="M6 10v9.5h12V10"/><path d="M12 12v5M10.5 13.2h2.3a1.2 1.2 0 0 1 0 2.4h-1.6a1.2 1.2 0 0 0 0 2.4H13.5"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
  bag: '<path d="M5.5 8h13l-1 12h-11z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  offer: '<path d="M4 4h7.5L20 12.5 12.5 20 4 11.5z"/><circle cx="8" cy="8" r="1.4"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.7"/><path d="M12 16.8v.2"/>',
  city: '<path d="M3.5 20.5h17"/><path d="M5 20.5V11l4-2v11.5"/><path d="M9 20.5V5l6 3v12.5"/><path d="M15 20.5V12l4 1.5v7"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M4 12 20 4.5 15.5 20l-3.5-6.5z"/><path d="m12 13.5 8-9"/>'
};

// Revi mark: an echo. A point with waves repeating outward on both sides, fading with distance.
// Deliberately not a speech bubble or a sparkle: Revi is a money echo, not a chat or "AI" badge.
const REVI_MARK = '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>'
  + '<path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6"/>'
  + '<path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" opacity=".5"/>';

export type IconName = keyof typeof P | 'revi';

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const markup = name === 'revi' ? REVI_MARK : P[name];
  if (!markup) return null;
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }} />
  );
}
