/*
 * Stylesheet module shapes for this project's program. The same declarations
 * `packages/ui/src/css-modules.d.ts` carries: an ambient .d.ts is only part of
 * the project that includes it, so a package that imports ui's components
 * needs its own copy for their CSS-module imports to resolve. `*.module.css`
 * is declared FIRST — TypeScript picks a wildcard module pattern by prefix
 * length, and these two share an empty prefix.
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
declare module '*.css?inline' {
  const css: string
  export default css
}
declare module '*.css' {
  const css: string
  export default css
}
