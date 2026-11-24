import type { Finding } from "@buildrax/ir";
import type { Provider, Technology } from "./types.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function httpUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    const u = new URL(s.replace(/^git\+/, "").replace(/\.git$/, ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const base = (tech: Technology, provider: string, kind: string, now: string) => ({
  id: `research:${provider}:${tech.name}:${kind}`,
  nodeId: tech.nodeId,
  subject: tech.name,
  retrievedAt: now,
});

const NOT_INSTALLED_NOTE =
  "The registry reports the latest published release. BuildRAX does not yet know which version your repo pins.";

function docsFinding(
  tech: Technology,
  provider: string,
  now: string,
  url: string | undefined,
  what: string,
): Finding[] {
  if (!url) return [];
  return [
    {
      ...base(tech, provider, "docs", now),
      finding: `${what}: ${url}`,
      sourceUrl: url,
      publisher: new URL(url).host,
      evidenceType: "docs-link",
      reliability: "medium",
      reliabilityNote:
        "Link declared by the package maintainers; its content was not fetched or verified.",
    },
  ];
}

/** npm registry: `GET https://registry.npmjs.org/<name>/latest` (no key, no auth). */
export const npmProvider: Provider = {
  id: "npm-registry",
  hosts: ["registry.npmjs.org"],
  supports: (t) => t.ecosystem === "npm" && t.primary !== false,
  request: (t) => ({
    provider: "npm-registry",
    subject: t.name,
    url: `https://registry.npmjs.org/${t.name.replace("/", "%2F")}/latest`,
  }),
  parse(tech, json, { url, now }) {
    const d = asRecord(json);
    const version = str(d.version);
    if (!version) return [];
    const out: Finding[] = [];
    const license = str(d.license);
    const engines = asRecord(d.engines);
    const repo = asRecord(d.repository);
    out.push({
      ...base(tech, "npm-registry", "latest", now),
      finding: `Latest published version is ${version}${license ? ` (license: ${license})` : ""}.`,
      sourceUrl: url,
      publisher: "npm registry (registry.npmjs.org)",
      evidenceType: "registry-metadata",
      reliability: "high",
      reliabilityNote: NOT_INSTALLED_NOTE,
      applicableVersion: version,
    });
    const deprecated = str(d.deprecated);
    if (deprecated) {
      out.push({
        ...base(tech, "npm-registry", "deprecated", now),
        finding: `The latest version is marked deprecated by its maintainers: ${deprecated}`,
        sourceUrl: url,
        publisher: "npm registry (registry.npmjs.org)",
        evidenceType: "registry-metadata",
        reliability: "high",
        applicableVersion: version,
        recommendedAction: "Read the deprecation notice and plan a replacement or migration.",
      });
    }
    const node = str(engines.node);
    if (node) {
      out.push({
        ...base(tech, "npm-registry", "engines", now),
        finding: `Version ${version} declares it needs Node.js ${node}.`,
        sourceUrl: url,
        publisher: "npm registry (registry.npmjs.org)",
        evidenceType: "registry-metadata",
        reliability: "high",
        applicableVersion: version,
      });
    }
    out.push(
      ...docsFinding(
        tech,
        "npm-registry",
        now,
        httpUrl(d.homepage) ?? httpUrl(repo.url),
        "Maintainer-declared homepage",
      ),
    );
    return out;
  },
};

/** PyPI: `GET https://pypi.org/pypi/<name>/json` (no key, no auth). */
export const pypiProvider: Provider = {
  id: "pypi",
  hosts: ["pypi.org"],
  supports: (t) => t.ecosystem === "pypi" && t.primary !== false,
  request: (t) => ({
    provider: "pypi",
    subject: t.name,
    url: `https://pypi.org/pypi/${encodeURIComponent(t.name)}/json`,
  }),
  parse(tech, json, { url, now }) {
    const info = asRecord(asRecord(json).info);
    const version = str(info.version);
    if (!version) return [];
    const out: Finding[] = [];
    const license = str(info.license);
    out.push({
      ...base(tech, "pypi", "latest", now),
      finding: `Latest published version is ${version}${license && license.length < 40 ? ` (license: ${license})` : ""}.`,
      sourceUrl: url,
      publisher: "Python Package Index (pypi.org)",
      evidenceType: "registry-metadata",
      reliability: "high",
      reliabilityNote: NOT_INSTALLED_NOTE,
      applicableVersion: version,
    });
    if (info.yanked === true) {
      out.push({
        ...base(tech, "pypi", "yanked", now),
        finding: `Version ${version} has been yanked${str(info.yanked_reason) ? `: ${str(info.yanked_reason)}` : ""}.`,
        sourceUrl: url,
        publisher: "Python Package Index (pypi.org)",
        evidenceType: "registry-metadata",
        reliability: "high",
        applicableVersion: version,
        recommendedAction:
          "Check which version your project resolves and move off yanked releases.",
      });
    }
    const requires = str(info.requires_python);
    if (requires) {
      out.push({
        ...base(tech, "pypi", "requires-python", now),
        finding: `Version ${version} requires Python ${requires}.`,
        sourceUrl: url,
        publisher: "Python Package Index (pypi.org)",
        evidenceType: "registry-metadata",
        reliability: "high",
        applicableVersion: version,
      });
    }
    const urls = asRecord(info.project_urls);
    const docs =
      httpUrl(urls.Documentation) ??
      httpUrl(urls.Homepage) ??
      httpUrl(info.home_page) ??
      httpUrl(info.project_url);
    out.push(...docsFinding(tech, "pypi", now, docs, "Maintainer-declared documentation/homepage"));
    return out;
  },
};

const OSV_ECOSYSTEM = { npm: "npm", pypi: "PyPI" } as const;
const OSV_PUBLISHER = "OSV.dev (Open Source Vulnerabilities)";

/** Fixed-in versions from OSV ranges, preferring ones in the same major line as the pinned version. */
function fixedVersions(vuln: Record<string, unknown>, version: string): string[] {
  const fixed = new Set<string>();
  for (const a of Array.isArray(vuln.affected) ? vuln.affected : [])
    for (const r of Array.isArray(asRecord(a).ranges) ? (asRecord(a).ranges as unknown[]) : [])
      for (const e of Array.isArray(asRecord(r).events) ? (asRecord(r).events as unknown[]) : []) {
        const f = str(asRecord(e).fixed);
        if (f) fixed.add(f);
      }
  const major = version.split(".")[0];
  const same = [...fixed].filter((f) => f.split(".")[0] === major);
  return (same.length ? same : [...fixed]).sort();
}

/**
 * OSV.dev: `POST https://api.osv.dev/v1/query` with `{package: {name, ecosystem}, version}`.
 * Only the public package name and the pinned version are sent; needs a lockfile version.
 */
export const osvProvider: Provider = {
  id: "osv",
  hosts: ["api.osv.dev"],
  supports: (t) => (t.ecosystem === "npm" || t.ecosystem === "pypi") && !!t.version,
  request: (t) => ({
    provider: "osv",
    subject: `${t.name}@${t.version}`,
    url: "https://api.osv.dev/v1/query",
    method: "POST",
    body: JSON.stringify({
      package: { name: t.name, ecosystem: OSV_ECOSYSTEM[t.ecosystem as "npm" | "pypi"] },
      version: t.version,
    }),
  }),
  parse(tech, json, { now }) {
    const version = tech.version!;
    const vulns = (Array.isArray(asRecord(json).vulns) ? (asRecord(json).vulns as unknown[]) : [])
      .map(asRecord)
      .filter((v) => str(v.id));
    const id = (k: string) => `research:osv:${tech.name}@${version}:${k}`;
    if (!vulns.length)
      return [
        {
          id: id("none"),
          nodeId: tech.nodeId,
          subject: tech.name,
          retrievedAt: now,
          finding: `No known advisories in OSV.dev for ${tech.name} ${version}.`,
          sourceUrl: `https://osv.dev/list?ecosystem=${OSV_ECOSYSTEM[tech.ecosystem as "npm" | "pypi"]}&q=${encodeURIComponent(tech.name)}`,
          publisher: OSV_PUBLISHER,
          evidenceType: "advisory",
          reliability: "medium",
          reliabilityNote: "Absence from one database is not proof that a version is safe.",
          applicableVersion: version,
        },
      ];
    return vulns.map((v) => {
      const vid = str(v.id)!;
      const cve = (Array.isArray(v.aliases) ? v.aliases : []).find(
        (a): a is string => typeof a === "string" && a.startsWith("CVE-"),
      );
      const severity = str(asRecord(v.database_specific).severity);
      const fixed = fixedVersions(v, version);
      return {
        id: id(vid),
        nodeId: tech.nodeId,
        subject: tech.name,
        retrievedAt: now,
        finding: `${vid}${cve ? ` (${cve})` : ""}${severity ? ` [${severity.toLowerCase()}]` : ""}: ${str(v.summary) ?? "see advisory"}`,
        sourceUrl: `https://osv.dev/vulnerability/${encodeURIComponent(vid)}`,
        publisher: OSV_PUBLISHER,
        evidenceType: "advisory" as const,
        reliability: "high" as const,
        reliabilityNote: `OSV.dev lists ${version} (the version pinned in your lockfile) as affected.`,
        applicableVersion: version,
        ...(fixed.length
          ? { recommendedAction: `Upgrade ${tech.name} to ${fixed.join(" or ")} or later.` }
          : {}),
      };
    });
  },
};

/** Release cycle a version belongs to: the longest cycle name it equals or starts with. */
export function matchCycle(
  version: string,
  cycles: string[],
): { cycle?: string; ambiguous: string[] } {
  const hits = cycles.filter((c) => version === c || version.startsWith(`${c}.`));
  if (hits.length) return { cycle: hits.sort((a, b) => b.length - a.length)[0], ambiguous: [] };
  return { ambiguous: cycles.filter((c) => c.startsWith(`${version}.`)) };
}

const DAY = 86_400_000;

/**
 * endoflife.date: `GET https://endoflife.date/api/v1/products/<product>/`. Product ids come from
 * BuildRAX's fixed tables; only the product name is sent (the version is matched locally).
 */
export const endoflifeProvider: Provider = {
  id: "endoflife",
  hosts: ["endoflife.date"],
  supports: (t) => t.ecosystem === "product" && !!t.version,
  request: (t) => ({
    provider: "endoflife",
    subject: `${t.label ?? t.name} ${t.version}`,
    url: `https://endoflife.date/api/v1/products/${encodeURIComponent(t.name)}/`,
  }),
  parse(tech, json, { now }) {
    const result = asRecord(asRecord(json).result);
    const releases = (Array.isArray(result.releases) ? result.releases : []).map(asRecord);
    const label = str(result.label) ?? tech.label ?? tech.name;
    const page = httpUrl(asRecord(result.links).html) ?? `https://endoflife.date/${tech.name}`;
    const version = tech.version!;
    const names = releases.map((r) => str(r.name)).filter((x): x is string => !!x);
    const { cycle, ambiguous } = matchCycle(version, names);
    const common = {
      id: `research:endoflife:${tech.name}@${version}:lifecycle`,
      nodeId: tech.nodeId,
      subject: `${label} ${version}`,
      retrievedAt: now,
      sourceUrl: page,
      publisher: "endoflife.date",
      evidenceType: "lifecycle" as const,
      applicableVersion: version,
    };
    if (!cycle) {
      if (!ambiguous.length) return [];
      return [
        {
          ...common,
          finding: `${label} ${version} matches several release lines (${ambiguous.slice(0, 4).join(", ")}); their support dates differ.`,
          reliability: "low",
          recommendedAction: `Pin a specific ${label} release line so its support window can be checked.`,
        },
      ];
    }
    const r = releases.find((x) => str(x.name) === cycle)!;
    const eol = str(r.eolFrom);
    const latest = str(asRecord(r.latest).name);
    const newest =
      releases.find((x) => x.isEol === false && x.isLts === true) ??
      releases.find((x) => x.isEol === false);
    const newestName = newest ? str(newest.name) : undefined;
    const latestNote = latest && latest !== version ? ` Latest ${cycle}.x release: ${latest}.` : "";
    if (r.isEol === true)
      return [
        {
          ...common,
          finding: `${label} ${cycle} reached end of life${eol ? ` on ${eol}` : ""}: no more security fixes.${latestNote}`,
          reliability: "high",
          recommendedAction: `Upgrade to a supported ${label} release${newestName ? ` (for example ${newestName})` : ""}.`,
        },
      ];
    const daysLeft = eol ? Math.round((Date.parse(eol) - Date.parse(now)) / DAY) : undefined;
    const soon = daysLeft !== undefined && daysLeft <= 180;
    return [
      {
        ...common,
        finding: eol
          ? `${label} ${cycle} is supported until ${eol}${soon ? ` (${daysLeft} days left)` : ""}.${latestNote}`
          : `${label} ${cycle} is supported; no end-of-life date has been announced.${latestNote}`,
        reliability: "high",
        ...(soon
          ? {
              recommendedAction: `Plan the move to a newer ${label} release${newestName ? ` (for example ${newestName})` : ""}.`,
            }
          : {}),
      },
    ];
  },
};

export const DEFAULT_PROVIDERS: readonly Provider[] = [
  npmProvider,
  pypiProvider,
  osvProvider,
  endoflifeProvider,
];
