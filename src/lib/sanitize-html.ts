import sanitize from 'sanitize-html';

// Allowlist sanitizer for stored SEO/blog bodyHtml (served raw to public
// storefronts). Anything not explicitly permitted is dropped, which closes the
// entity-encoded-scheme and novel-vector bypasses a blocklist can't.
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
      '*': ['id', 'class'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    // Force a safe rel on links that leave the site. Site-relative links (the
    // internal linking SEO pages exist for) keep their equity — a blanket
    // nofollow here would silently defeat it.
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
