---
paths:
  - "src/**/*.ts"
  - "**/*.ts"
---

# TypeScript Rules

- `strict: true` is enabled — never use `any` implicitly; cast explicitly when the type is truly unknown
- Target ES2020 / CommonJS (matches `tsconfig.json`)
- Prefer `const` over `let`; never use `var`
- Use `unknown` instead of `any` for caught errors; narrow before use
- No unused variables or imports — the compiler enforces `noUnusedLocals`
- Async functions must have a declared return type (`Promise<void>`, `Promise<string>`, etc.)
- Use optional chaining (`?.`) and nullish coalescing (`??`) instead of verbose null checks
- No `@ts-ignore` or `@ts-expect-error` without a comment explaining why
