// Dependency-free blocklist sanitizer for stored SEO bodyHtml (served raw to
// public storefronts). Defense-in-depth at the write path; swap for an
// allowlist lib (sanitize-html) when a network install is possible.

const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base'];

export function sanitizeHtml(input: string): string {
  let html = input;

  // Drop dangerous elements entirely, including their content.
  for (const tag of DANGEROUS_TAGS) {
    const withBody = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    html = html.replace(withBody, '').replace(selfClosing, '');
  }

  // Strip inline event handlers: on*="…" / on*='…' / on*=value.
  html = html.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  html = html.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  html = html.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');

  // Neutralize javascript:/vbscript:/data: URIs in href/src attributes.
  html = html.replace(
    /\b(href|src|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data):[^"']*\2/gi,
    '$1=$2#$2',
  );

  return html;
}
