import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAnchors, htmlToText, pathOf, repointAnchors } from '../src/utils/internal-link-html.ts';

const ID = '9f1c2d3e-0000-4000-8000-000000000001';
const OTHER = '9f1c2d3e-0000-4000-8000-000000000002';

test('reads href, stable reference and visible text of each link', () => {
  const html = `<p>See <a href="/destinations/tarangire" data-link-type="destinations" data-link-id="${ID}"><strong>Tarangire</strong> National Park</a> and <a href="https://x.com">x</a>.</p>`;
  const [a, b] = extractAnchors(html);
  assert.equal(a.href, '/destinations/tarangire');
  assert.equal(a.linkType, 'destinations');
  assert.equal(a.linkId, ID);
  assert.equal(a.text, 'Tarangire National Park');
  assert.equal(b.href, 'https://x.com');
  assert.equal(b.linkId, null);
});

test('repoint changes only the href of referenced links, keeping anchor text, query and hash', () => {
  const html = `<p><a href="/destinations/old?x=1#wild" data-link-type="destinations" data-link-id="${ID}">Explore Tarangire</a> · <a href="/destinations/old" data-link-id="${OTHER}">Other</a> · <a href="/destinations/old">Unreferenced</a></p>`;
  const { html: out, changed } = repointAnchors(html, ID, '/destinations/tarangire-national-park');
  assert.equal(changed, 1);
  assert.match(out, /href="\/destinations\/tarangire-national-park\?x=1#wild" data-link-type="destinations"/);
  assert.match(out, />Explore Tarangire</);
  // Other references and unreferenced look-alikes are untouched.
  assert.match(out, new RegExp(`<a href="/destinations/old" data-link-id="${OTHER}">Other</a>`));
  assert.match(out, /<a href="\/destinations\/old">Unreferenced<\/a>/);
});

test('repoint is a no-op when nothing references the record or it already points there', () => {
  const html = `<p><a href="/tours/new" data-link-id="${ID}">Trip</a></p>`;
  assert.deepEqual(repointAnchors(html, OTHER, '/tours/x'), { html, changed: 0 });
  assert.deepEqual(repointAnchors(html, ID, '/tours/new'), { html, changed: 0 });
});

test('a new path is attribute-escaped', () => {
  const { html } = repointAnchors(`<a href="/a" data-link-id="${ID}">t</a>`, ID, '/tours/"onmouseover="x');
  assert.match(html, /href="\/tours\/&quot;onmouseover=&quot;x"/);
});

test('pathOf drops query, hash and trailing slash and decodes', () => {
  assert.equal(pathOf('/tours/serengeti-safari/?ref=x#day-2'), '/tours/serengeti-safari');
  assert.equal(pathOf('/'), '/');
  assert.equal(pathOf('/blog/caf%C3%A9'), '/blog/café');
});

test('htmlToText keeps word breaks between blocks', () => {
  assert.equal(htmlToText('<p>Day 2</p><p>Explore&nbsp;Tarangire &amp; more</p>'), 'Day 2 Explore Tarangire & more');
});
