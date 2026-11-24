/**
 * Instance ladders the sizing walks up. These are AWS instance facts (vCPU, memory), plus a
 * labelled assumption for burstable classes: `sustainedVcpu` is the CPU a t4g instance can use
 * all day (its baseline share), which is what steady traffic needs.
 */
export interface DbClass {
  cls: string;
  vcpu: number;
  memoryGib: number;
  sustainedVcpu: number;
}

export const DB_LADDER: DbClass[] = [
  { cls: "db.t4g.micro", vcpu: 2, memoryGib: 1, sustainedVcpu: 0.2 },
  { cls: "db.t4g.small", vcpu: 2, memoryGib: 2, sustainedVcpu: 0.4 },
  { cls: "db.t4g.medium", vcpu: 2, memoryGib: 4, sustainedVcpu: 0.4 },
  { cls: "db.m7g.large", vcpu: 2, memoryGib: 8, sustainedVcpu: 2 },
  { cls: "db.m7g.xlarge", vcpu: 4, memoryGib: 16, sustainedVcpu: 4 },
  { cls: "db.m7g.2xlarge", vcpu: 8, memoryGib: 32, sustainedVcpu: 8 },
  { cls: "db.m7g.4xlarge", vcpu: 16, memoryGib: 64, sustainedVcpu: 16 },
  { cls: "db.m7g.8xlarge", vcpu: 32, memoryGib: 128, sustainedVcpu: 32 },
];

export interface CacheClass {
  cls: string;
  memoryGib: number;
}

export const CACHE_LADDER: CacheClass[] = [
  { cls: "cache.t4g.micro", memoryGib: 0.5 },
  { cls: "cache.t4g.small", memoryGib: 1.37 },
  { cls: "cache.t4g.medium", memoryGib: 3.09 },
  { cls: "cache.m7g.large", memoryGib: 6.38 },
  { cls: "cache.m7g.xlarge", memoryGib: 12.93 },
  { cls: "cache.m7g.2xlarge", memoryGib: 26.04 },
];

/**
 * RDS's default `max_connections` for PostgreSQL/MySQL grows with instance memory
 * (roughly memory / 9.5 MB, capped at 5000). Used to warn when containers would open more.
 */
export function dbMaxConnections(c: DbClass): number {
  return Math.min(5000, Math.floor((c.memoryGib * 1024) / 9.531392));
}

/** Fargate's supported vCPU sizes and the smallest memory each allows. */
const FARGATE_SIZES: [number, number][] = [
  [0.25, 0.5],
  [0.5, 1],
  [1, 2],
  [2, 4],
  [4, 8],
  [8, 16],
  [16, 32],
];

/** Round a container size up to one Fargate can run. */
export function fargateSize(vcpu: number, memoryGb: number): { vcpu: number; memoryGb: number } {
  const [v, minMem] = FARGATE_SIZES.find(([s]) => s >= vcpu - 1e-9) ?? FARGATE_SIZES.at(-1)!;
  const mem = Math.max(minMem, Math.ceil(memoryGb * 2) / 2, memoryGb > 0 ? 0 : minMem);
  return { vcpu: v, memoryGb: Math.min(mem, v * 8) };
}
