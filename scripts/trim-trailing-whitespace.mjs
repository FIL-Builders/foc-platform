import { readFile, writeFile } from "node:fs/promises";

const filePaths = process.argv.slice(2);
if (filePaths.length === 0) {
  console.error("usage: node scripts/trim-trailing-whitespace.mjs <file> [...]");
  process.exit(1);
}

for (const filePath of filePaths) {
  const original = await readFile(filePath, "utf8");
  const trimmed = original.replace(/[ \t]+$/gm, "");
  if (trimmed !== original) {
    await writeFile(filePath, trimmed);
  }
}
