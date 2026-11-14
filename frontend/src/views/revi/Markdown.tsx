// The small subset of Markdown the trainer writes: paragraphs, "- " bullets and **bold**.
// Rendered as React elements, never as HTML, so model text cannot inject markup.
import { Fragment, type ReactNode } from 'react';

const BULLET = /^\s*[-*•]\s+/;

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    (part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const closeList = () => {
    if (!bullets.length) return;
    blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of text.split('\n')) {
    if (BULLET.test(line)) { bullets.push(line.replace(BULLET, '')); continue; }
    closeList();
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.trim())}</p>);
  }
  closeList();
  return <div className="md">{blocks}</div>;
}
