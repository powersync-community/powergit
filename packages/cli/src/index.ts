
import simpleGit from 'simple-git';
export async function addPowerSyncRemote(dir: string, name: string, url: string) {
  const git = simpleGit({ baseDir: dir });
  const remotes = await git.getRemotes(true);
  const exists = remotes.find(r => r.name === name);
  if (!exists) await git.addRemote(name, url);
  else await git.remote(['set-url', name, url]);
  return true;
}
