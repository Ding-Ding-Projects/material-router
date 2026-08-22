# Dim sum surprise

A 10% chance at startup of a small card in the bottom corner showing one dim sum
dish — its English and Chinese names plus its photo. A small delight, not a feature to
manage.

## Behaviour

- Fresh random draw per launch; never more often than stated, never twice in one
  launch.
- Non-blocking: it never gates startup, steals focus, or delays the app. It
  auto-dismisses after eight seconds and can be closed immediately.
- Suppressed during first-run, error, and update flows, and entirely under School
  mode (re-checked after the dish is fetched).
- **There is no opt-out setting by design.** The non-blocking rules above are what
  keep an un-optable surprise polite.

## Photos: public catalog, fetched once

Dish metadata and photos come from the public
[`Ding-Ding-Projects/dim-sum-photos`](https://github.com/Ding-Ding-Projects/dim-sum-photos)
catalog. On first need the app fetches the catalog index once, keeps only the compact
fields it uses, and caches it inside the application-data folder; a chosen dish's
image downloads once into the same cache. After that everything works offline. Only
dishes with published photo assets are eligible; if none can be fetched, no card is
shown and the reason is honest absence rather than a placeholder.

Photos are never generated or vendored into this repository, and each card carries an
attribution link back to the public catalog plus meaningful alt text naming the dish.

## Accessibility

The image's alt text names the dish for screen-reader users; the rise animation is
suppressed under reduced motion; the card is plain `role="complementary"` content that
never takes focus.
