// JSON-LD helpers for seo_pages.schemaJsonld (object or @graph-style array).
// Pure, so they're unit-tested without a database.

export type JsonLd = Record<string, unknown> | unknown[];

function isObjectNode(node: unknown): node is Record<string, unknown> {
  return !!node && typeof node === 'object' && !Array.isArray(node);
}

function isArticleNode(node: unknown): node is Record<string, unknown> {
  if (!isObjectNode(node)) return false;
  const type = node['@type'];
  return typeof type === 'string' && /article|blogposting/i.test(type);
}

/** Write `image` onto the Article node of a JSON-LD value (object or @graph array). */
export function setJsonLdImage(schema: JsonLd | null, imageUrl: string): JsonLd {
  if (Array.isArray(schema)) {
    const target = schema.find(isArticleNode) ?? schema.find(isObjectNode);
    if (target) {
      target.image = imageUrl;
      return schema;
    }
    return [...schema, { '@type': 'Article', image: imageUrl }];
  }
  if (isObjectNode(schema)) {
    schema.image = imageUrl;
    return schema;
  }
  return { '@type': 'Article', image: imageUrl };
}

/**
 * Add `datePublished` to the Article node when no node carries one yet. Returns
 * null when there is nothing to change, so callers leave the column untouched.
 */
export function ensureJsonLdDatePublished(schema: JsonLd | null, iso: string): JsonLd | null {
  const nodes = Array.isArray(schema) ? schema : schema ? [schema] : [];
  if (nodes.some((n) => isObjectNode(n) && typeof n.datePublished === 'string')) return null;
  if (Array.isArray(schema)) {
    const target = schema.find(isArticleNode) ?? schema.find(isObjectNode);
    if (target) {
      target.datePublished = iso;
      return schema;
    }
    return [...schema, { '@type': 'Article', datePublished: iso }];
  }
  if (isObjectNode(schema)) return { ...schema, datePublished: iso };
  return { '@type': 'Article', datePublished: iso };
}
