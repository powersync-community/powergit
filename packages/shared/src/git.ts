export interface GitFileChangeSummary {
  path: string
  additions: number
  deletions: number
}

export interface GitCommitSummary {
  sha: string
  tree: string
  author_name: string
  author_email: string
  authored_at: string
  message: string
  parents: string[]
  files: GitFileChangeSummary[]
}

export interface GitRefSummary {
  name: string
  target: string
}

export interface GitPushSummary {
  head?: string
  refs: GitRefSummary[]
  commits: GitCommitSummary[]
}
