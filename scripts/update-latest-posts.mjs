#!/usr/bin/env node
/**
 * Rewrite README "## Latest posts" block between BLOG-POST-LIST markers.
 *
 * Env:
 *   POSTS_SOURCE  blog | rss          (default: blog)
 *   BLOG_PATH     path to blog checkout (default: ./blog)
 *   POSTS_LANG    posts lang folder   (default: en)
 *   MAX_POSTS     number of items     (default: 5)
 *   LINK_MODE     github-blob | site  (default: github-blob)
 *   SITE_BASE     base URL for site   (default: https://borjalofe.com)
 *   GITHUB_BLOG   owner/repo for blob (default: borjalofe/blog)
 *   BLOG_BRANCH   branch for blob     (default: main)
 *   RSS_URL       feed URL when POSTS_SOURCE=rss
 *   README_PATH   readme to update    (default: ./README.md)
 *   DRY_RUN       if "1", print only
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

const START = "<!-- BLOG-POST-LIST:START -->";
const END = "<!-- BLOG-POST-LIST:END -->";

const source = (process.env.POSTS_SOURCE || "blog").toLowerCase();
const blogPath = process.env.BLOG_PATH || "blog";
const lang = process.env.POSTS_LANG || "en";
const maxPosts = Number(process.env.MAX_POSTS || 5);
const linkMode = process.env.LINK_MODE || "github-blob";
const siteBase = (process.env.SITE_BASE || "https://borjalofe.com").replace(/\/$/, "");
const githubBlog = process.env.GITHUB_BLOG || "borjalofe/blog";
const blogBranch = process.env.BLOG_BRANCH || "main";
const rssUrl = process.env.RSS_URL || "";
const readmePath = process.env.README_PATH || "README.md";
const dryRun = process.env.DRY_RUN === "1";

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { data: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const fm = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    data[m[1]] = v;
  }
  return { data, body };
}

function postUrl({ file, data }) {
  if (data.canonicalURL) return data.canonicalURL;
  if (linkMode === "site") {
    const slug = data.reference || basename(file, ".md");
    return `${siteBase}/blog/${slug}`;
  }
  return `https://github.com/${githubBlog}/blob/${blogBranch}/content/posts/${lang}/${file}`;
}

async function postsFromBlog() {
  const dir = join(blogPath, "content", "posts", lang);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  const posts = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf8");
    const { data } = parseFrontmatter(raw);
    if (!data.title) continue;
    const pub = data.pubDate ? Date.parse(data.pubDate) : NaN;
    posts.push({
      title: data.title,
      date: Number.isFinite(pub) ? pub : 0,
      url: postUrl({ file, data }),
    });
  }
  posts.sort((a, b) => b.date - a.date);
  return posts.slice(0, maxPosts);
}

function stripCdata(s) {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

async function postsFromRss() {
  if (!rssUrl) throw new Error("RSS_URL is required when POSTS_SOURCE=rss");
  const res = await fetch(rssUrl);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = stripCdata((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const link = stripCdata((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "");
    const pubRaw =
      (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] ||
      (block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) || [])[1] ||
      "";
    const date = Date.parse(stripCdata(pubRaw));
    if (!title || !link) continue;
    items.push({ title, url: link.trim(), date: Number.isFinite(date) ? date : 0 });
  }
  // Atom fallback
  if (items.length === 0) {
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1];
      const title = stripCdata((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      const link = linkMatch ? linkMatch[1] : "";
      const pubRaw =
        (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] ||
        (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] ||
        "";
      const date = Date.parse(stripCdata(pubRaw));
      if (!title || !link) continue;
      items.push({ title, url: link.trim(), date: Number.isFinite(date) ? date : 0 });
    }
  }
  items.sort((a, b) => b.date - a.date);
  return items.slice(0, maxPosts);
}

function formatList(posts) {
  if (posts.length === 0) {
    return "_No posts yet._\n";
  }
  return (
    posts
      .map((p) => {
        const d =
          p.date > 0
            ? new Date(p.date).toISOString().slice(0, 10)
            : null;
        return d
          ? `- [${p.title}](${p.url}) — ${d}`
          : `- [${p.title}](${p.url})`;
      })
      .join("\n") + "\n"
  );
}

function replaceBlock(readme, listBody) {
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`README missing ${START} / ${END} markers`);
  }
  const before = readme.slice(0, startIdx + START.length);
  const after = readme.slice(endIdx);
  return `${before}\n${listBody}${after}`;
}

const posts = source === "rss" ? await postsFromRss() : await postsFromBlog();
const listBody = formatList(posts);
const readme = await readFile(readmePath, "utf8");
const next = replaceBlock(readme, listBody);

if (next === readme) {
  console.log("Latest posts already up to date.");
  process.exit(0);
}

if (dryRun) {
  console.log(listBody);
  process.exit(0);
}

await writeFile(readmePath, next, "utf8");
console.log(`Updated ${readmePath} with ${posts.length} post(s) from ${source}.`);
