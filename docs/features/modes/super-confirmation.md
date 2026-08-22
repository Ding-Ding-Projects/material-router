# Super confirmation (destructive actions)

The upgraded gate for destructive actions, implemented entirely in the app's own UI
layer (`tabs/delight/dialogs-super.js`). It is exported for every lane and already
used by this lane's own destructive surfaces (vocabulary clear, lock removal, ticket
deletion).

## Flow

1. The dialog names the exact destructive action and affected data in plain words —
   unambiguous at every language mode and funny level.
2. **Two independently operated key holds** (pointer press-and-hold or held
   Enter/Space; releasing early cancels that key). Each key shows its own progress and
   confirms separately.
3. Only then is the **full-range slider** enabled. Authorisation happens when the
   slider reaches its end.
4. A **distinct completion state** ("Authorised") plays before the action proceeds.
5. **Emergency exit** stays visible the whole time; Escape cancels at any point;
   focus returns to the invoking control on every exit path.

## Accessibility

Keyboard-operable end to end (holds work via Enter/Space), screen-reader named with a
live progress value per key, visible focus rings, reduced-motion respected (the
completion pop and hold sweep are suppressed while the full hold duration is still
required).

## Integration

```js
import { destructiveConfirmSuper } from '<tab>/delight/dialogs-super.js';
const ok = await destructiveConfirmSuper({ title, body, confirmLabel });
```

The signature matches the foundation's `destructiveConfirm`, so lanes can switch call
sites one by one.
