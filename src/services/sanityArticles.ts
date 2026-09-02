/**
 * Read the published blog off Sanity (Kyle, 2026-09-02: "attach the articles
 * written"). The production dataset is publicly readable, so this is a plain
 * HTTPS query — no token, no SDK. Values from the website project's env
 * (m5itxotq / production / v2024-10-01), overridable if the site ever moves.
 */

const PROJECT = process.env.SANITY_PROJECT_ID ?? "m5itxotq";
const DATASET = process.env.SANITY_DATASET ?? "production";
const API_VERSION = process.env.SANITY_API_VERSION ?? "2024-10-01";
/** Where article links point. */
export const SITE_BASE_URL = process.env.SITE_BASE_URL ?? "https://redcedarelectricllc.com";

export interface PublishedArticle {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  tag: string | null;
  publishedAt: string | null;
  url: string;
}

export async function fetchPublishedArticles(limit = 20): Promise<PublishedArticle[]> {
  const groq = `*[_type == "article" && defined(slug.current) && !(_id in path("drafts.**"))]
    | order(publishedAt desc)[0...${Math.min(Math.max(limit, 1), 50)}]{
      _id, title, "slug": slug.current, excerpt, tag, publishedAt
    }`;
  const url = `https://${PROJECT}.api.sanity.io/v${API_VERSION}/data/query/${DATASET}?query=${encodeURIComponent(groq)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Sanity query failed (${res.status})`);
  const body = (await res.json()) as { result?: Array<{ _id: string; title?: string; slug?: string; excerpt?: string; tag?: string; publishedAt?: string }> };
  return (body.result ?? [])
    .filter((a) => a.title && a.slug)
    .map((a) => ({
      id: a._id,
      title: a.title!,
      slug: a.slug!,
      excerpt: a.excerpt ?? "",
      tag: a.tag ?? null,
      publishedAt: a.publishedAt ?? null,
      url: `${SITE_BASE_URL}/education/${a.slug}`,
    }));
}
