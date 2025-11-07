declare module 'diff' {
  export type DiffChange = {
    added?: boolean
    removed?: boolean
    value: string
  }

  export function diffLines(oldStr: string, newStr: string): DiffChange[]
}
