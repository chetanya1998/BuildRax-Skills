import { h } from "./dom.js";

export interface LiveConfig {
  server?: boolean;
  token?: string;
  version?: number;
  watch?: boolean;
}

interface VersionInfo {
  version: number;
  added: number;
  removed: number;
  changed: number;
  links: number;
  cycles: number;
}

/** "3 added, 1 removed, 2 links" (what the rescan changed). */
export function describeChange(v: VersionInfo): string {
  const parts = [
    v.added && `${v.added} added`,
    v.removed && `${v.removed} removed`,
    v.changed && `${v.changed} changed`,
    v.links && `${v.links} link change${v.links === 1 ? "" : "s"}`,
    v.cycles && `${v.cycles} new circular dependenc${v.cycles === 1 ? "y" : "ies"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "updated";
}

/**
 * `buildrax serve --watch`: poll the local server for rescans and offer a refresh. Never reloads
 * on its own (that could lose a note being typed); the view state survives through the URL hash.
 */
export function startLiveUpdates(
  config: LiveConfig | undefined,
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
  intervalMs = 2000,
): (() => void) | undefined {
  if (!config?.server || !config.watch || typeof config.token !== "string") return undefined;
  const seen = config.version ?? 0;
  let dismissed = seen;
  const banner = h("div", { class: "live-banner", role: "status", hidden: "" });
  document.body.append(banner);
  const show = (v: VersionInfo): void => {
    const refresh = h("button", { type: "button", class: "primary" }, "Refresh");
    refresh.addEventListener("click", () => location.reload());
    const later = h("button", { type: "button" }, "Later");
    later.addEventListener("click", () => {
      dismissed = v.version;
      banner.hidden = true;
    });
    banner.replaceChildren(
      h("span", null, h("b", null, "The code changed. "), `Architecture: ${describeChange(v)}.`),
      refresh,
      later,
    );
    banner.hidden = false;
  };
  const timer = window.setInterval(() => {
    void fetchFn("/api/version", { headers: { "x-buildrax-token": config.token! } })
      .then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : undefined))
      .then((v) => {
        if (v && typeof v.version === "number" && v.version > seen && v.version > dismissed)
          show(v);
      })
      .catch(() => undefined); // server stopped: keep the page usable
  }, intervalMs);
  return () => window.clearInterval(timer);
}
