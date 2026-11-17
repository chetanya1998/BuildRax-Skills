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
  supports: (t) => t.ecosystem === "npm",
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
  supports: (t) => t.ecosystem === "pypi",
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

export const DEFAULT_PROVIDERS: readonly Provider[] = [npmProvider, pypiProvider];
