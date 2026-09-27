// Side-effect import that activates the cordis-plugin-timer Context augmentation
// (ctx.timeout / ctx.interval / ctx.timer) for type checking only; nothing is emitted.
// A bare `import type '@deepseek-ai/cordis-plugin-timer'` in a .ts file is a syntax error,
// so the side-effect import lives in this .d.ts instead.
import '@deepseek-ai/cordis-plugin-timer'
