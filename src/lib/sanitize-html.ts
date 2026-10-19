import sanitize from 'sanitize-html';

// Allowlist sanitizer for stored SEO/blog bodyHtml (served raw to public storefronts): anything not permitted is dropped,
// which closes the entity-encoded-scheme bypasses a blocklist misses.
export function sanitizeHtml(input: string): string {
  return sanitize(input, {
    allowedTags: [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'br',
      'hr',
      'span',
      'div',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'small',
      'sub',
      'sup',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'figure',
      'figcaption',
      'img',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'th',
      'td',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      th: ['colspan', 'rowspan', 'scope'],
      td: ['colspan', 'rowspan'],
      // `style` survives only as text-align (editor alignment buttons); other declarations are dropped.
      '*': ['id', 'class', 'style'],
    },
    allowedStyles: {
      '*': { 'text-align': [/^(left|right|center|justify)$/] },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    // Safe rel on external links only: internal links keep their link equity, so no blanket nofollow.
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? '';
        const isInternal = href === '' || href.startsWith('/') || href.startsWith('#');
        return {
          tagName,
          attribs: isInternal ? attribs : { ...attribs, rel: 'noopener noreferrer nofollow' },
        };
      },
    },
  });
}
