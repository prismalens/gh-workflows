_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_

<details>
<summary>🔍 Verification note</summary>

> **Validation:** Confirmed in `packages/core/src/auth.ts`: `userContext` is evaluated on line 48 without a null guard when `session.anonymous == true`, throwing TypeError at runtime.
</details>

**Unhandled TypeError on anonymous session**

`userContext.claims` is dereferenced directly without checking whether `userContext` is populated.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `packages/core/src/auth.ts` around lines 45-52: Add a null check for `userContext` before accessing `session.claims`.
```

</details>
