// @types/js-yaml is not installed in the mounted dependencies, so this keeps the parser signature local.
declare module 'js-yaml' {
  export function load(source: string): unknown;
}
