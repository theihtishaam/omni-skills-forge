---
name: react-form-handling-advanced
category: web-dev/react
version: 1.0.0
difficulty: intermediate
tags: ["react","form-handling","advanced","intermediate"]
tools: ["claude-code","kilo","cline","opencode","cursor","windsurf"]
description: "react form-handling advanced at intermediate level"
---
# Submit and validate React forms

- Handle submission on the `<form>` so keyboard submission and the submit button use the same code. Give inputs names and read `FormData` before awaiting network work.
- Start with native constraints such as `required`, `type="email"`, and `minLength`. Validate again on the server. For custom field errors, associate the message with its control and preserve the entered values.
- Use `defaultValue` for an uncontrolled input with an initial value. Use `value` with a synchronous `onChange` state update when other rendered UI needs each change. Keep that choice consistent while the input is mounted.

```jsx
import { useId, useRef, useState } from 'react';

export function EmailForm({ saveEmail }) {
  const emailId = useId();
  const saving = useRef(false);
  const [phase, setPhase] = useState('idle');

  async function submit(event) {
    event.preventDefault();
    if (saving.current) return;
    const email = new FormData(event.currentTarget).get('email');
    saving.current = true;
    setPhase('saving');
    try {
      await saveEmail(email);
      setPhase('saved');
    } catch {
      setPhase('failed');
    } finally {
      saving.current = false;
    }
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor={emailId}>Email</label>
      <input id={emailId} name="email" type="email" required
        autoComplete="email" readOnly={phase === 'saving'} />
      <button type="submit" aria-disabled={phase === 'saving'}>Save</button>
      <p role="status">
        {phase === 'saving' && 'Saving…'}
        {phase === 'saved' && 'Email saved.'}
        {phase === 'failed' && 'Email could not be saved. Try again.'}
      </p>
    </form>
  );
}
```

The submit guard enforces the busy state while the button remains focusable. Adapt `saveEmail` so it rejects failed responses and maps any field-specific server errors to the affected fields.

## Acceptance checks

- Submitting an empty or malformed email leaves the form open and makes no save request.
- Submitting a valid email by Enter or by the button sends the same payload. Repeated activation while a request is pending results in one request.
- A failed request keeps the entered email, announces a retryable error, and allows a retry. Success announces completion after the server responds.

[React inputs and form submission](https://react.dev/reference/react-dom/components/input) · [W3C form validation](https://www.w3.org/WAI/tutorials/forms/validation/) · [W3C form notifications](https://www.w3.org/WAI/tutorials/forms/notifications/)
