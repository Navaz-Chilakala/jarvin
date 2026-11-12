export interface GraphNode<T = unknown> {
  id: string;
  deps?: string[];
  run: (ctx: { results: Map<string, T> }) => Promise<T>;
}

export type GraphState = 'pending' | 'running' | 'completed' | 'failed';

export interface GraphRun<T = unknown> {
  results: Map<string, T>;
  states: Map<string, GraphState>;
  errors: Map<string, string>;
  order: string[];
  completed: boolean;
}

export async function runGraph<T>(nodes: GraphNode<T>[]): Promise<GraphRun<T>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const results = new Map<string, T>();
  const states = new Map<string, GraphState>(nodes.map((n) => [n.id, 'pending']));
  const errors = new Map<string, string>();
  const order: string[] = [];

  const ready = (node: GraphNode<T>) => (node.deps ?? []).every((d) => states.get(d) === 'completed');
  const remaining = () => nodes.filter((n) => states.get(n.id) === 'pending');

  let progressed = true;
  while (remaining().length > 0) {
    const batch = remaining().filter(ready);
    if (batch.length === 0) {
      progressed = false;
      break;
    }
    progressed = true;
    for (const node of batch) {
      states.set(node.id, 'running');
    }
    // Run independent nodes in the same layer in parallel.
    await Promise.all(batch.map(async (node) => {
      try {
        results.set(node.id, await node.run({ results }));
        states.set(node.id, 'completed');
        order.push(node.id);
      } catch (e: any) {
        states.set(node.id, 'failed');
        errors.set(node.id, String(e?.message ?? e));
      }
    }));
  }

  if (!progressed) {
    states.forEach((state, id) => {
      if (state === 'pending') errors.set(id, 'Unresolved dependency or cycle');
    });
  }

  return { results, states, errors, order, completed: [...states.values()].every((s) => s === 'completed') };
}