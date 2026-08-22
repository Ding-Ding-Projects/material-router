# Offline docs browser

Material Router ships its own documentation inside the application. The browser reads
bundled Markdown articles, builds an index from them, and renders everything without a
network connection, so help is always available where the app runs.

## Behaviour

- **Bundled articles.** Articles live in the repository under `docs/articles/` and are
  packaged with the app. Each article's first line is a level-one heading that becomes
  its title.
- **Generated index.** The browser generates its article list by scanning the bundle,
  so adding an article to the folder is enough for it to appear; there is no manual
  registry to keep in sync.
- **Internal links resolve.** Relative links between articles (for example
  `[Endpoints](endpoints.md)`) navigate inside the browser rather than shelling out to
  an external web view.
- **Search with regex.** The search bar matches titles and body content, supports
  plain text by default, and accepts regular expressions when you want precision —
  useful for finding every mention of an endpoint, a flag, or a header pattern.

## Configuration

None. The corpus is whatever ships with the installed version, so documentation always
matches the build you are running; new articles arrive with application updates rather
than through any in-app setting. Articles are plain Markdown and can also be read in
any editor or on the repository page.

## Failure modes

- A link pointing at a missing article reports the broken target instead of failing
  silently or navigating nowhere.
- Searching for a pattern with no matches shows an explicit no-results message rather
  than an empty-looking list.
- An empty corpus or a failed index build shows an explicit error state rather than
  a blank pane.
- Malformed Markdown still renders best-effort; the browser treats articles as
  content, not as trusted instructions.

## Security considerations

- Everything is local: no CDN, no remote fonts, no analytics, and no network fetches
  anywhere in the browser.
- Article content is treated as data; links stay confined to the bundled corpus.

## Verification

- Open the docs surface in the app and confirm the generated index lists every
  bundled article by its first-line title.
- Compare the index against the files actually present in `docs/articles/` and
  confirm they match one-for-one.
- Follow several cross-article links and confirm each navigates in place.
- Run a plain-text search and a regular-expression search and compare results.
- Confirm behavior with the machine offline; nothing should differ.

## Status

**Shipped in foundation (v0.1.0).** The bundled browser, generated index, internal
link resolution, and regex-capable search are all implemented. Article coverage grows
with each feature lane; new articles appear automatically.
