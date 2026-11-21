---
name: react-accessibility-a11y-advanced
category: web-dev/react
version: 1.0.0
difficulty: intermediate
tags: ["react","accessibility-a11y","advanced","intermediate"]
tools: ["claude-code","kilo","cline","opencode","cursor","windsurf"]
description: "react accessibility-a11y advanced at intermediate level"
---
# Keyboard accessibility for React forms

1. Use native inputs, buttons, and links so the browser supplies keyboard behavior. Mark auxiliary buttons `type="button"` and use `type="submit"` for submission.
2. Keep DOM order consistent with the intended reading and tab order. Use a visible `:focus-visible` indicator and check that sticky headers or scroll containers leave the focused control visible. Avoid positive `tabIndex`.
3. Give each field a visible label. Associate help and error text with `aria-describedby`, and set `aria-invalid` when validation reports an error. Use `fieldset` and `legend` to name groups of related controls.
4. After a failed custom validation attempt, render the error, preserve entered values, and move focus to the first invalid control or to an error summary that links to each affected field.

```jsx
import { useId } from 'react';

export function ContactEmailField({ error }) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label htmlFor={id}>Contact email</label>
      <input
        id={id}
        name="email"
        type="email"
        autoComplete="email"
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${helpId} ${errorId}` : helpId}
      />
      <p id={helpId}>Use an address you check regularly.</p>
      {error && <p id={errorId}>{error}</p>}
    </div>
  );
}
```

## Acceptance checks

- Use Tab and Shift+Tab through the whole form. Every control is reachable in a meaningful order, with visible focus and a way to leave each control.
- Activate buttons with Enter and Space. Press Enter from a valid single-line field to check that the form submits through its normal handler.
- Submit invalid data. The affected field has a text error with a correction, focus lands at a useful place, and already-entered data remains available.
- Check the field with a screen reader. Its name, required state, help, and any current error are available when the field receives focus.

[React useId](https://react.dev/reference/react/useId) · [W3C form labels and errors](https://www.w3.org/WAI/tutorials/forms/notifications/) · [WCAG focus order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) · [WCAG visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
