// Keep only Windows' native SQLite payload in the release copy of sqlite-jdbc.
// The upstream JAR is intentionally left untouched: it remains the pinned
// downloaded dependency, while the Windows package does not ship unrelated
// Linux/Android/FreeBSD/Mac ELF or Mach-O binaries.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const SQLITE_JAR = 'sqlite-jdbc-3.46.1.0.jar';
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const END = 0x06054b50;

function u16(buffer, offset) { return buffer.readUInt16LE(offset); }
function u32(buffer, offset) { return buffer.readUInt32LE(offset); }

function findEndOfCentralDirectory(buffer) {
  // A JAR's EOCD is normally at EOF.  Search backwards to account for the
  // optional archive comment, without relying on a platform zip utility.
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (u32(buffer, i) === END) return i;
  }
  throw new Error('sqlite JDBC JAR has no ZIP end record');
}

function centralEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = u16(buffer, eocd + 10);
  const centralSize = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 sqlite JDBC JARs are not supported by the release sanitizer');
  }
  const out = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    if (u32(buffer, cursor) !== CENTRAL) throw new Error('invalid sqlite JDBC central directory');
    const nameLength = u16(buffer, cursor + 28);
    const extraLength = u16(buffer, cursor + 30);
    const commentLength = u16(buffer, cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localOffset = u32(buffer, cursor + 42);
    if (localOffset === 0xffffffff) throw new Error('ZIP64 sqlite JDBC entry is not supported');
    if (u32(buffer, localOffset) !== LOCAL) throw new Error(`invalid local ZIP entry: ${name}`);
    const localNameLength = u16(buffer, localOffset + 26);
    const localExtraLength = u16(buffer, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressedSize = u32(buffer, cursor + 20);
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`truncated ZIP entry: ${name}`);
    out.push({
      name,
      central: Buffer.from(buffer.subarray(cursor, cursor + 46 + nameLength + extraLength + commentLength)),
      data: buffer.subarray(dataOffset, dataEnd),
      localOffset,
      compressedSize,
      uncompressedSize: u32(buffer, cursor + 24),
      crc: u32(buffer, cursor + 16),
      flags: u16(buffer, cursor + 8) & ~0x0008,
      method: u16(buffer, cursor + 10),
      time: u16(buffer, cursor + 12),
      date: u16(buffer, cursor + 14),
      versionNeeded: u16(buffer, cursor + 6),
      externalAttributes: u32(buffer, cursor + 38),
      madeByVersion: u16(buffer, cursor + 4),
      extra: Buffer.from(buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('sqlite JDBC central directory size mismatch');
  return out;
}

function keepEntry(name) {
  // Keep all Java classes/resources, but restrict sqlite's native payload to
  // Windows DLLs.  This is intentionally path-based and does not inspect or
  // alter executable bytes.
  if (!name.startsWith('org/sqlite/native/')) return true;
  return name === 'org/sqlite/native/' || name.startsWith('org/sqlite/native/Windows/');
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30 + name.length + entry.extra.length);
  header.writeUInt32LE(LOCAL, 0);
  header.writeUInt16LE(entry.versionNeeded, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(entry.extra.length, 28);
  name.copy(header, 30);
  entry.extra.copy(header, 30 + name.length);
  return header;
}

function centralHeader(entry, offset) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46 + name.length + entry.extra.length);
  header.writeUInt32LE(CENTRAL, 0);
  header.writeUInt16LE(entry.madeByVersion, 4);
  header.writeUInt16LE(entry.versionNeeded, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(entry.extra.length, 30);
  header.writeUInt16LE(0, 32); // Do not retain the upstream archive comment.
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.externalAttributes, 38);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  entry.extra.copy(header, 46 + name.length);
  return header;
}

export function sanitizeSqliteJar(file) {
  const original = readFileSync(file);
  const entries = centralEntries(original);
  const kept = entries.filter(entry => keepEntry(entry.name));
  const removed = entries.filter(entry => !keepEntry(entry.name)).map(entry => entry.name);
  // Refuse a malformed or unexpectedly empty Windows payload rather than
  // producing a package that fails later at runtime.
  if (!kept.some(entry => entry.name === 'org/sqlite/native/Windows/x86_64/sqlitejdbc.dll')) {
    throw new Error('sqlite JDBC JAR has no Windows x86_64 native library');
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of kept) {
    const local = localHeader(entry);
    localParts.push(local, entry.data);
    centralParts.push(centralHeader(entry, offset));
    offset += local.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(kept.length, 8); end.writeUInt16LE(kept.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(file, Buffer.concat([...localParts, central, end]));
  return { kept: kept.length, removed };
}

function findJar(root) {
  const candidates = [
    join(root, SQLITE_JAR),
    join(root, 'resources/jvm/libs', SQLITE_JAR),
    join(root, 'resources/app.asar.unpacked/resources/jvm/libs', SQLITE_JAR),
  ];
  return candidates.find(file => {
    try { readFileSync(file, { flag: 'r' }); return true; } catch { return false; }
  });
}

// electron-builder invokes this hook after the unpacked app is assembled and
// before the NSIS target is created.  Only the staging copy is modified.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: node sanitize-sqlite-jar.mjs <staging-root>');
  const file = findJar(root);
  if (!file) throw new Error(`staged ${SQLITE_JAR} not found under ${root}`);
  const result = sanitizeSqliteJar(file);
  console.log(`SQLite release copy sanitized: kept ${result.kept} entries, removed ${result.removed.length} non-Windows entries`);
}
