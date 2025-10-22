import type { PowerSyncDatabase } from '@powersync/node';
import { RAW_TABLE_CREATE_STATEMENTS } from '@shared/core';

export async function ensureLocalSchema(database: PowerSyncDatabase): Promise<void> {
  await database.writeTransaction(async (tx) => {
    for (const statements of Object.values(RAW_TABLE_CREATE_STATEMENTS)) {
      for (const statement of statements) {
        await tx.execute(statement);
      }
    }

    // Git metadata tables require triggers to forward local writes into the powersync_crud
    // virtual table so PowerSync can upload mutations to the backend. We recreate the triggers
    // on each bootstrap to ensure schema drift is handled.
    const triggerSpecs: Array<{ drop: string; create: string }> = [
      {
        drop: 'DROP TRIGGER IF EXISTS ps_refs_insert',
        create: `CREATE TRIGGER ps_refs_insert
          AFTER INSERT ON refs
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'refs', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'name', NEW.name,
              'target_sha', NEW.target_sha,
              'updated_at', NEW.updated_at
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_refs_update',
        create: `CREATE TRIGGER ps_refs_update
          AFTER UPDATE ON refs
          FOR EACH ROW
          BEGIN
            SELECT CASE WHEN OLD.id != NEW.id THEN RAISE(FAIL, 'Cannot update id') END;
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'refs', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'name', NEW.name,
              'target_sha', NEW.target_sha,
              'updated_at', NEW.updated_at
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_refs_delete',
        create: `CREATE TRIGGER ps_refs_delete
          AFTER DELETE ON refs
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type)
            VALUES ('DELETE', OLD.id, 'refs');
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_commits_insert',
        create: `CREATE TRIGGER ps_commits_insert
          AFTER INSERT ON commits
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'commits', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'sha', NEW.sha,
              'author_name', NEW.author_name,
              'author_email', NEW.author_email,
              'authored_at', NEW.authored_at,
              'message', NEW.message,
              'tree_sha', NEW.tree_sha
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_commits_update',
        create: `CREATE TRIGGER ps_commits_update
          AFTER UPDATE ON commits
          FOR EACH ROW
          BEGIN
            SELECT CASE WHEN OLD.id != NEW.id THEN RAISE(FAIL, 'Cannot update id') END;
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'commits', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'sha', NEW.sha,
              'author_name', NEW.author_name,
              'author_email', NEW.author_email,
              'authored_at', NEW.authored_at,
              'message', NEW.message,
              'tree_sha', NEW.tree_sha
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_commits_delete',
        create: `CREATE TRIGGER ps_commits_delete
          AFTER DELETE ON commits
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type)
            VALUES ('DELETE', OLD.id, 'commits');
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_file_changes_insert',
        create: `CREATE TRIGGER ps_file_changes_insert
          AFTER INSERT ON file_changes
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'file_changes', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'commit_sha', NEW.commit_sha,
              'path', NEW.path,
              'additions', NEW.additions,
              'deletions', NEW.deletions
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_file_changes_update',
        create: `CREATE TRIGGER ps_file_changes_update
          AFTER UPDATE ON file_changes
          FOR EACH ROW
          BEGIN
            SELECT CASE WHEN OLD.id != NEW.id THEN RAISE(FAIL, 'Cannot update id') END;
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'file_changes', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'commit_sha', NEW.commit_sha,
              'path', NEW.path,
              'additions', NEW.additions,
              'deletions', NEW.deletions
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_file_changes_delete',
        create: `CREATE TRIGGER ps_file_changes_delete
          AFTER DELETE ON file_changes
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type)
            VALUES ('DELETE', OLD.id, 'file_changes');
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_objects_insert',
        create: `CREATE TRIGGER ps_objects_insert
          AFTER INSERT ON objects
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'objects', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'pack_oid', NEW.pack_oid,
              'pack_bytes', NEW.pack_bytes,
              'created_at', NEW.created_at
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_objects_update',
        create: `CREATE TRIGGER ps_objects_update
          AFTER UPDATE ON objects
          FOR EACH ROW
          BEGIN
            SELECT CASE WHEN OLD.id != NEW.id THEN RAISE(FAIL, 'Cannot update id') END;
            INSERT INTO powersync_crud (op, id, type, data)
            VALUES ('PUT', NEW.id, 'objects', json_object(
              'id', NEW.id,
              'org_id', NEW.org_id,
              'repo_id', NEW.repo_id,
              'pack_oid', NEW.pack_oid,
              'pack_bytes', NEW.pack_bytes,
              'created_at', NEW.created_at
            ));
          END`,
      },
      {
        drop: 'DROP TRIGGER IF EXISTS ps_objects_delete',
        create: `CREATE TRIGGER ps_objects_delete
          AFTER DELETE ON objects
          FOR EACH ROW
          BEGIN
            INSERT INTO powersync_crud (op, id, type)
            VALUES ('DELETE', OLD.id, 'objects');
          END`,
      },
    ];

    for (const spec of triggerSpecs) {
      await tx.execute(spec.drop);
      await tx.execute(spec.create);
    }
  });
}
