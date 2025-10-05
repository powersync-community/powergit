
/* Manual stub for TanStack Router route tree */
import { createRootRoute, createRoute } from '@tanstack/react-router'
import * as Root from './routes/__root'
import * as Home from './routes/index'
import * as OrgIndex from './routes/org.$orgId.index'
import * as RepoIndex from './routes/org.$orgId.repo.$repoId.index'
import * as RepoBranches from './routes/org.$orgId.repo.$repoId.branches'
import * as RepoCommits from './routes/org.$orgId.repo.$repoId.commits'
import * as RepoFiles from './routes/org.$orgId.repo.$repoId.files'

const rootRoute = createRootRoute({ component: Root.Route })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home.Route.component })
const orgIndex = createRoute({ getParentRoute: () => rootRoute, path: '/org/$orgId/', component: OrgIndex.Route.component })
const repoIndex = createRoute({ getParentRoute: () => rootRoute, path: '/org/$orgId/repo/$repoId/', component: RepoIndex.Route.component })
const repoBranches = createRoute({ getParentRoute: () => rootRoute, path: '/org/$orgId/repo/$repoId/branches', component: RepoBranches.Route.component })
const repoCommits = createRoute({ getParentRoute: () => rootRoute, path: '/org/$orgId/repo/$repoId/commits', component: RepoCommits.Route.component })
const repoFiles = createRoute({ getParentRoute: () => rootRoute, path: '/org/$orgId/repo/$repoId/files', component: RepoFiles.Route.component })

export const routeTree = rootRoute.addChildren([indexRoute, orgIndex, repoIndex, repoBranches, repoCommits, repoFiles])
