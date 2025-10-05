
import { column, Schema, Table } from '@powersync/web'

export const refs = new Table({
  org_id: column.text,
  repo_id: column.text,
  name: column.text,
  target_sha: column.text,
  updated_at: column.text,
}, { indexes: { org_repo: ['org_id', 'repo_id'], name: ['name'] } })

export const commits = new Table({
  org_id: column.text,
  repo_id: column.text,
  sha: column.text,
  author_name: column.text,
  author_email: column.text,
  authored_at: column.text,
  message: column.text,
  tree_sha: column.text,
}, { indexes: { org_repo: ['org_id','repo_id'], author: ['author_email'] } })

export const file_changes = new Table({
  org_id: column.text,
  repo_id: column.text,
  commit_sha: column.text,
  path: column.text,
  additions: column.integer,
  deletions: column.integer,
}, { indexes: { org_repo: ['org_id','repo_id'], path: ['path'] } })

export const AppSchema = new Schema({ refs, commits, file_changes })
export type Database = (typeof AppSchema)['types']
