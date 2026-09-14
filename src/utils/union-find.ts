/** Minimal union-find: after union()-ing every above-threshold pair, find() groups
 * indices into clusters with no dependence on the order pairs were unioned in — the
 * old greedy single-pass (`used[]`, first-claim-wins) produced a different clustering
 * depending on suggestion order; this doesn't. */
class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  public find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  public union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      // Lower index wins as root — arbitrary but fixed, so the resulting root
      // assignment (and therefore grouping) doesn't depend on union() call order.
      if (rootA < rootB) {
        this.parent[rootB] = rootA;
      } else {
        this.parent[rootA] = rootB;
      }
    }
  }
}

export default UnionFind;
