/** Iterative Tarjan strongly connected components. Returns components with more than one node. */
export function tarjanScc(
  nodeIds: readonly string[],
  adj: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  for (const root of nodeIds) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const next = adj.get(frame.v) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!.v;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
        }
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.v);
          if (comp.length > 1) result.push(comp.sort());
        }
      }
    }
  }
  return result.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}
