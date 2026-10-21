/**
 * Reading and rewriting the links inside admin-authored rich text (the TipTap
 * HTML stored in tours.full_description and itinerary_days.description).
 *
 * A link the editor inserts from the page picker carries a stable reference
 * next to its address:
 *
 *   <a href="/destinations/tarangire" data-link-type="destinations" data-link-id="9f…">Tarangire</a>
 *
 * The address is what visitors and crawlers follow; the reference is what lets
 * the link be found again and repointed when that page's slug changes. Only the
 * href is ever rewritten here — the words an editor chose to link stay exactly
 * as written.
 *
 * Deliberately dependency-free (no Supabase, no Express) so it can be tested on
 * its own with `node --test`.
 */

export type AnchorInfo = {
  /** Offset of the opening tag in the source HTML. */
  start: number;
  /** Offset just past the opening tag. */
  openEnd: number;
  openTag: string;
  href: string;
  linkType: string | null;
  linkId: string | null;
  /** The visible words, tags stripped and whitespace collapsed. */
  text: string;
};

const ATTR = /([a-z_:][-a-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/gi;

const decodeBasic = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const parseAttrs = (source: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR.lastIndex = 0;
  while ((match = ATTR.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeBasic(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
};

/** Visible text of an HTML fragment. */
export const htmlToText = (html: string | null | undefined): string =>
  decodeBasic(
    String(html ?? '')
      .replace(/<(br|\/p|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

/** Every <a> element in `html`, in document order. Nested anchors are not valid HTML and are not expected. */
export const extractAnchors = (html: string | null | undefined): AnchorInfo[] => {
  const source = String(html ?? '');
  const anchors: AnchorInfo[] = [];
  const open = /<a\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    const attrs = parseAttrs(match[1]);
    const openEnd = match.index + match[0].length;
    const close = source.toLowerCase().indexOf('</a', openEnd);
    const inner = close === -1 ? '' : source.slice(openEnd, close);
    anchors.push({
      start: match.index,
      openEnd,
      openTag: match[0],
      href: (attrs.href ?? '').trim(),
      linkType: attrs['data-link-type']?.trim() || null,
      linkId: attrs['data-link-id']?.trim() || null,
      text: htmlToText(inner)
    });
  }
  return anchors;
};

/** True for a site path ("/tours/x"), false for external, mail, phone and same-page links. */
export const isSitePath = (href: string) => href.startsWith('/') && !href.startsWith('//');

/**
 * The page part of a site link: no query, no hash, no trailing slash, decoded.
 * "/tours/serengeti-safari/?ref=x#day-2" → "/tours/serengeti-safari".
 */
export const pathOf = (href: string): string => {
  let path = href.split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

/** The query and hash of a link, kept when only its page moves. */
const suffixOf = (href: string) => {
  const at = href.search(/[?#]/);
  return at === -1 ? '' : href.slice(at);
};

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The opening tag with its href replaced; every other attribute untouched. */
const withHref = (openTag: string, href: string) => {
  const quoted = `href="${escapeAttr(href)}"`;
  return /\bhref\s*=/i.test(openTag)
    ? openTag.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+)/i, quoted)
    : openTag.replace(/^<a\b/i, `<a ${quoted}`);
};

/**
 * Point every link that references record `linkId` at `newPath`, keeping each
 * link's own query string and hash. Links without the reference are left alone
 * even when their address happens to match — they were not chosen from the
 * picker, so there is no proof they mean this record.
 */
export const repointAnchors = (
  html: string | null | undefined,
  linkId: string,
  newPath: string
): { html: string; changed: number } => {
  const source = String(html ?? '');
  if (!source || !linkId) return { html: source, changed: 0 };
  let changed = 0;
  let out = '';
  let cursor = 0;
  for (const anchor of extractAnchors(source)) {
    if (anchor.linkId !== linkId) continue;
    const next = `${newPath}${suffixOf(anchor.href)}`;
    if (next === anchor.href) continue;
    out += source.slice(cursor, anchor.start) + withHref(anchor.openTag, next);
    cursor = anchor.openEnd;
    changed += 1;
  }
  if (!changed) return { html: source, changed: 0 };
  return { html: out + source.slice(cursor), changed };
};
