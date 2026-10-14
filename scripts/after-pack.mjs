// electron-builder hook.  Keep the source Maven JAR intact and sanitize only
// the Windows staging copy before it is placed in the installer.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeSqliteJar } from './sanitize-sqlite-jar.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const candidates = [
    join(context.appOutDir, 'resources/jvm/libs/sqlite-jdbc-3.46.1.0.jar'),
    join(context.appOutDir, 'resources/app.asar.unpacked/resources/jvm/libs/sqlite-jdbc-3.46.1.0.jar'),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error('Windows package staging is missing sqlite-jdbc-3.46.1.0.jar');
  const result = sanitizeSqliteJar(file);
  console.log(`SQLite release copy sanitized: kept ${result.kept} entries, removed ${result.removed.length} non-Windows entries`);
}
