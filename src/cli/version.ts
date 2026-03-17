// __VERSION__ is injected at compile time via `bun build --define`.
// When running source directly (e.g. dev or tests), fall back to package.json.
export const VERSION: string = (typeof __VERSION__ !== 'undefined'
  ? __VERSION__
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : ((await import('../../package.json')) as any).default.version) as string
