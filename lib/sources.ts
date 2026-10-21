// Opening the pages a quick search cites, so each fact can be checked against the page's text.
// Only public web addresses are opened. An address that leads to a private or local network is refused.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

export type SourceText = { url: string; title: string; ok: boolean; text: string; error?: string };

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return (
      v === "::1" ||
      v === "::" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe80") ||
      v.startsWith("::ffff:127.") ||
      v.startsWith("::ffff:10.") ||
      v.startsWith("::ffff:192.168.")
    );
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function assertPublic(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("local addresses are not opened");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("the address leads to a private network, so it is not opened");
  }
}

/** Readable text of an HTML page: no scripts, styles or tags, and common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]).slice(0, 160) || undefined : undefined;
}

/** Opens one cited page. Never throws: a page that cannot be read comes back with ok false and the reason. */
export async function fetchSource(url: string, fallbackTitle: string): Promise<SourceText> {
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only web addresses are opened");
      await assertPublic(u.hostname);
      // Redirects are followed by hand, so each new address is checked too.
      const res = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
        headers: { "user-agent": "InstaAgent-source-check/1.0", accept: "text/html,text/plain;q=0.9" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
        current = new URL(location, u).toString();
        continue;
      }
      if (!res.ok) throw new Error(`the page answered HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      const isHtml = /text\/html/i.test(type);
      if (!isHtml && !/text\/plain/i.test(type)) throw new Error("the page is not text");
      const body = new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()).subarray(0, MAX_BYTES));
      return {
        url,
        title: (isHtml && titleOf(body)) || fallbackTitle,
        ok: true,
        text: isHtml ? htmlToText(body) : body.replace(/\s+/g, " ").trim(),
      };
    }
  } catch (err) {
    return { url, title: fallbackTitle, ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
  }
}
