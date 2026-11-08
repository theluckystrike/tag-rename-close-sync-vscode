// Comparisons, generics, regexes and strings that look like tags.
import { useState } from 'react';

type Box<T> = { value: T };
type Fn = <T>(x: T) => T;
const identity = <T,>(x: T): T => x;
const pick = <T extends object>(x: T) => x;
const re = /<div>(.*?)<\/div>/g;
const s = "<span>not a tag</span>";
const t = `<p>${'<b>'}</p>`;
/* <section> in a comment </section> */

export function Hostile({ a, b, c, d }: { a: number; b: number; c: number; d: number }) {
  const [items] = useState<Array<Box<string>>>([]);
  const ok = a < b && c > d;
  const map = new Map<string, number>();
  return (
    <div className="hostile">
      {a < b && c > d ? <span>less</span> : <em>more</em>}
      <p>It's a "quote" and a {'<string>'} inside text, also 1 &lt; 2.</p>
      {items.map((x, i) => (
        <li key={i} data-ok={ok ? 'yes' : 'no'} onClick={() => (i > 2 ? map.get('<a>') : 0)}>
          {x.value}
        </li>
      ))}
      <>
        <Box.Item />
        <input value={'</div>'} />
      </>
    </div>
  );
}
